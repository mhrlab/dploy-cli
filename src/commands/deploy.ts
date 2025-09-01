import path from "node:path";
import { loadConfig, getEnvName } from "../core/config.js";
import { detectVersion, posixJoin } from "../core/utils.js";
import { buildArtifact } from "../features/packager.js";
import { connect, close, ensureRemoteDirs, exec, uploadFile, listDirs, removePath } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { linkShared } from "../features/shared.js";
import {runLocalHooks, runRemoteHooks} from "../core/hooks.js";
import {cleanupReleases} from "../features/cleaner.js";

export async function deploy(opts: { env?: string; artifact?: string; version?: string }) {
    log.debug(`Deploy command started with options: ${JSON.stringify(opts)}`);

    const cwd = process.cwd();
    const cfg = await loadConfig(cwd);
    const envName = getEnvName(opts.env);
    log.verbose(`Using environment: ${envName}`);

    const env = cfg.environments[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);

    const version = detectVersion(opts.version);
    log.verbose(`Deployment version: ${version}`);

    log.info(`Starting deployment to [${envName}] environment (${env.host})`);

    // Build or use provided artifact
    let artifactPath = opts.artifact ? path.resolve(opts.artifact) : undefined;
    if (!artifactPath) {
        log.info(`No artifact provided, building from source`);

        log.verbose(`Running pre-build hooks`);
        await runLocalHooks("preBuild", cfg.hooks?.preBuild);

        const result = await buildArtifact({
            cwd,
            buildDir: cfg.buildDir,
            version,
            cfg,
        });
        artifactPath = result.artifactPath;

        log.debug(`Artifact built successfully: ${artifactPath}`);
        log.verbose(`Running post-build hooks`);
        await runLocalHooks("postBuild", cfg.hooks?.postBuild);

    } else {
        log.verbose(`Using provided artifact: ${artifactPath}`);
        log.info(`Using provided artifact: ${path.basename(artifactPath)}`);
    }

    log.verbose(`Preparing for artifact uploading to remote server.`);

    const remoteRoot = env.deployTo;
    const releases = posixJoin(remoteRoot, "releases");
    const currentLink = posixJoin(remoteRoot, "current");
    const tmp = posixJoin(remoteRoot, "tmp");
    const releaseDir = posixJoin(releases, version);
    const remoteTar = posixJoin(tmp, `release-${version}.tar.gz`);

    log.debug(`Remote paths - Root: ${remoteRoot}, Releases: ${releases}, Current: ${currentLink}, Tmp: ${tmp}`);
    log.debug(`Release directory: ${releaseDir}, Remote tar: ${remoteTar}`);
    log.verbose(`SSH connection config - Host: ${env.host}, Port: ${env.port || 22}, User: ${env.username}`);
    const spin = log.spinner(`Connecting to ${env.username}@${env.host}`);
    const bundle = await connect(env).catch((e) => {
        spin.fail("SSH connect failed");
        log.err(e.message || String(e));
        process.exit(1);
    });
    spin.succeed("Connected");

    try {
        log.verbose(`Ensuring remote directories exist`);
        await ensureRemoteDirs(bundle.ssh, releases, tmp);

        log.verbose(`Uploading artifact to remote server`);
        log.info(`Uploading deployment artifact...`);
        await uploadFile(bundle.sftp, artifactPath!, remoteTar);

        // Extract release
        log.debug(`Executing extract command: mkdir -p "${releaseDir}" && tar -xzf "${remoteTar}" -C "${releaseDir}" && rm -f "${remoteTar}"`);
        const extract = log.spinner("Extracting release...");

        const { code, stderr } = await exec(
            bundle.ssh,
            `mkdir -p "${releaseDir}" && tar -xzf "${remoteTar}" -C "${releaseDir}" && rm -f "${remoteTar}"`
        );
        if (code !== 0) throw new Error(stderr || "remote extract failed");
        extract.succeed(`Extracted ${version}`);

        // run PreDeploy hooks
        log.verbose(`Running pre-deploy hooks after extraction.`);
        await runRemoteHooks(bundle.ssh, "preDeploy", cfg.hooks?.preDeploy, releaseDir);

        // Link shared items
        if (cfg.shared?.length) {
            log.verbose(`Linking ${cfg.shared.length} shared items`);
            log.debug(`Shared items: ${JSON.stringify(cfg.shared)}`);
            const spinShared = log.spinner("Linking shared items...");
            await linkShared(bundle.ssh, remoteRoot, releaseDir, cfg.shared, cfg.sharedDefaults);
            spinShared.succeed(`Linking completed for ${cfg.shared.length} shared items`);
        } else {
            log.verbose(`No shared items to link`);
        }

        // Switch current symlink
        log.verbose(`Switching current symlink to new release`);
        log.info(`Activating new release...`);

        await exec(bundle.ssh, `ln -sfn "${releaseDir}" "${currentLink}"`);

        log.ok(`Activated ${version}`);
        log.ok(`Deployed ${version} to [${envName}]`);

        // run PostDeploy hooks
        log.verbose(`Running post-deploy hooks`);
        await runRemoteHooks(bundle.ssh, "postDeploy", cfg.hooks?.postDeploy, releaseDir);

        // Clean old releases
        const keep = env.keepVersions ?? 5;
        log.verbose(`Cleaning old releases, keeping ${keep} versions`);
        await cleanupReleases(bundle, releases, keep, true);
        if (cfg.cleanAfterDeploy) {
            log.verbose(`Cleaning temporary uploaded directory & files`);
            await exec(bundle.ssh, `rm -rf "${tmp}"`);
        }

    } finally {
        log.verbose(`Closing SSH connection`);
        await close(bundle);
    }
}

