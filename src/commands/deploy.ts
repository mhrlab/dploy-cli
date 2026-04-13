import path from "node:path";
import { loadConfig, getEnvName } from "../core/config.js";
import { detectVersion, posixJoin } from "../core/utils.js";
import { buildArtifact, planBuildArtifact } from "../features/packager.js";
import { connect, close, ensureRemoteDirs, exec, uploadFile } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { linkShared } from "../features/shared.js";
import {runLocalHooks, runRemoteHooks} from "../core/hooks.js";
import {cleanupReleases} from "../features/cleaner.js";
import { resolveDeployArtifact } from "../features/deploy-artifact.js";
import { verifyArtifactChecksum } from "../features/checksum.js";

export async function deploy(opts: { env?: string; artifact?: string; archive?: string; version?: string; dryRun?: boolean; skipBuild?: boolean }) {
    log.debug(`Deploy command started with options: ${JSON.stringify(opts)}`);

    const cwd = process.cwd();
    const cfg = await loadConfig(cwd);
    const envName = getEnvName(opts.env);
    log.verbose(`Using environment: ${envName}`);

    const env = cfg.environments?.[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);

    const version = detectVersion(opts.version);
    log.verbose(`Deployment version: ${version}`);

    log.info(`Starting deployment to [${envName}] environment (${env.host})`);

    const customArtifact = opts.artifact ?? opts.archive;
    const shouldBuild = !customArtifact && !opts.skipBuild;
    let artifactPath: string;

    if (opts.dryRun) {
        if (shouldBuild) {
            const plan = await planBuildArtifact({
                cwd,
                buildDir: cfg.build?.buildDir,
                version,
                cfg,
            });

            log.info(`[dry-run] Would package ${plan.files.length} file(s) into ${path.basename(plan.artifactPath)}`);
            if (cfg.hooks?.preBuild?.length) {
                log.info(`[dry-run] Would run ${cfg.hooks.preBuild.length} local preBuild hook(s)`);
            } else {
                log.info(`[dry-run] No local preBuild hooks configured`);
            }
            if (cfg.hooks?.postBuild?.length) {
                log.info(`[dry-run] Would run ${cfg.hooks.postBuild.length} local postBuild hook(s)`);
            } else {
                log.info(`[dry-run] No local postBuild hooks configured`);
            }
            for (const file of plan.files) {
                log.verbose(`[dry-run] package ${file.from} -> ${file.to}`);
            }
            artifactPath = plan.artifactPath;
        } else {
            const selection = await resolveDeployArtifact({
                cwd,
                cfg,
                version,
                artifact: opts.artifact,
                archive: opts.archive,
                skipBuild: opts.skipBuild,
                strict: false,
            });
            artifactPath = selection.artifactPath;
            log.info(`[dry-run] Would skip build phase`);
            log.info(`[dry-run] Would use ${selection.source === "custom" ? "provided artifact" : "existing prebuilt artifact"}: ${path.basename(artifactPath)}`);
        }
    } else if (shouldBuild) {
        log.info(`No artifact provided, building from source`);

        log.verbose(`Running pre-build hooks`);
        await runLocalHooks("preBuild", cfg.hooks?.preBuild);

        const result = await buildArtifact({
            cwd,
            buildDir:  cfg.build?.buildDir,
            version,
            cfg,
        });
        artifactPath = result.artifactPath;

        log.debug(`Artifact built successfully: ${artifactPath}`);
        log.verbose(`Running post-build hooks`);
        await runLocalHooks("postBuild", cfg.hooks?.postBuild);
    } else {
        const selection = await resolveDeployArtifact({
            cwd,
            cfg,
            version,
            artifact: opts.artifact,
            archive: opts.archive,
            skipBuild: opts.skipBuild,
            strict: true,
        });
        artifactPath = selection.artifactPath;
        log.info(selection.source === "custom" ? `Using provided artifact: ${path.basename(artifactPath)}` : `Using prebuilt artifact: ${path.basename(artifactPath)}`);
        log.verbose(`Using artifact path: ${artifactPath}`);
    }

    if (opts.dryRun) {
        const remoteRoot = env.deployTo ? env.deployTo : '';
        const releases = posixJoin(remoteRoot, "releases");
        const currentLink = posixJoin(remoteRoot, "current");
        const tmp = posixJoin(remoteRoot, "tmp");
        const releaseDir = posixJoin(releases, version);
        const remoteTar = posixJoin(tmp, `release-${version}.tar.gz`);
        const keep = env.keepVersions ?? 5;

        log.info(`[dry-run] Would connect to ${env.username}@${env.host}`);
        log.info(`[dry-run] Would upload ${path.basename(artifactPath!)} to ${remoteTar}`);
        log.info(`[dry-run] Would extract into ${releaseDir}`);
        if (cfg.shared?.length) {
            log.info(`[dry-run] Would link shared items: ${cfg.shared.join(", ")}`);
        }
        log.info(`[dry-run] Would switch current symlink to ${currentLink}`);
        if (cfg.hooks?.preDeploy?.length) {
            log.info(`[dry-run] Would run ${cfg.hooks.preDeploy.length} preDeploy hook(s)`);
        } else {
            log.info(`[dry-run] No preDeploy hooks configured`);
        }
        if (cfg.hooks?.postDeploy?.length) {
            log.info(`[dry-run] Would run ${cfg.hooks.postDeploy.length} postDeploy hook(s)`);
        } else {
            log.info(`[dry-run] No postDeploy hooks configured`);
        }
        log.info(`[dry-run] Would clean old releases, keeping ${keep} version(s)`);
        if (cfg.cleanAfterDeploy) {
            log.info(`[dry-run] Would remove temporary upload directory ${tmp}`);
        }
        log.info(`[dry-run] Would verify SHA256 checksum after upload`);
        return;
    }

    log.verbose(`Preparing for artifact uploading to remote server.`);

    const remoteRoot = env.deployTo ? env.deployTo : '';
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

        log.verbose(`Verifying uploaded artifact checksum`);
        const checksum = log.spinner("Verifying checksum...");
        try {
            const { localHash, remoteHash } = await verifyArtifactChecksum({
                ssh: bundle.ssh,
                localPath: artifactPath!,
                remotePath: remoteTar,
            });
            checksum.succeed("Checksum verified");
            log.ok(`Checksum verified (${localHash.slice(0, 12)}...)`);
            log.debug(`Local checksum: ${localHash}`);
            log.debug(`Remote checksum: ${remoteHash}`);
        } catch (error) {
            checksum.fail("Checksum verification failed");
            throw error;
        }

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
        await cleanupReleases(bundle, releases, keep, { strict: true });
        if (cfg.cleanAfterDeploy) {
            log.verbose(`Cleaning temporary uploaded directory & files`);
            await exec(bundle.ssh, `rm -rf "${tmp}"`);
        }

    } finally {
        log.verbose(`Closing SSH connection`);
        await close(bundle);
    }
}

