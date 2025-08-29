import path from "node:path";
import { loadConfig, getEnvName } from "../core/config.js";
import { detectVersion, posixJoin } from "../core/utils.js";
import { buildArtifact } from "../core/packager.js";
import { connect, close, ensureRemoteDirs, exec, uploadFile, listDirs, removePath } from "../core/ssh.js";
import { log } from "../core/logger.js";
import {linkShared} from "../features/shared.js";

export async function deploy(opts: { env?: string; artifact?: string; version?: string }) {
    const cwd = process.cwd();
    const cfg = await loadConfig(cwd);
    const envName = getEnvName(opts.env);
    const env = cfg.environments[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);

    const version = detectVersion(opts.version);

    // Build or use provided artifact
    let artifactPath = opts.artifact ? path.resolve(opts.artifact) : undefined;
    if (!artifactPath) {
        const result = await buildArtifact({
            cwd,
            buildDir: cfg.buildDir,
            version,
            cfg,
        });
        artifactPath = result.artifactPath;
    }

    const remoteRoot = env.deployTo;
    const releases = posixJoin(remoteRoot, "releases");
    const currentLink = posixJoin(remoteRoot, "current");
    const tmp = posixJoin(remoteRoot, "tmp");
    const releaseDir = posixJoin(releases, version);
    const remoteTar = posixJoin(tmp, `release-${version}.tar.gz`);

    const spin = log.spinner(`Connecting to ${env.username}@${env.host}`);
    const bundle = await connect(env).catch((e) => {
        spin.fail("SSH connect failed");
        log.err(e.message || String(e));
        process.exit(1);
    });
    spin.succeed("Connected");

    try {
        await ensureRemoteDirs(bundle.ssh, releases, tmp);
        await uploadFile(bundle.sftp, artifactPath!, remoteTar);

        // 1️⃣ Extract release
        const extract = log.spinner("Extracting release");
        const { code, stderr } = await exec(
            bundle.ssh,
            `mkdir -p "${releaseDir}" && tar -xzf "${remoteTar}" -C "${releaseDir}" && rm -f "${remoteTar}"`
        );
        if (code !== 0) throw new Error(stderr || "remote extract failed");
        extract.succeed(`Extracted ${version}`);

        // 2️⃣ Link shared items
        if (cfg.shared?.length) {
            const spinShared = log.spinner("Linking shared items");
            await linkShared(bundle.ssh, remoteRoot, releaseDir, cfg.shared, cfg.sharedDefaults);
            spinShared.succeed("Linked shared items");
        }

        // 3️⃣ Switch current symlink
        await exec(bundle.ssh, `ln -sfn "${releaseDir}" "${currentLink}"`);
        log.ok(`Activated ${version}`);

        // Clean old releases
        const keep = env.keepVersions ?? 5;
        const existing = await listDirs(bundle.sftp, releases);
        const sorted = existing.sort();
        const toDelete = sorted.filter((r) => r !== version).slice(0, Math.max(0, sorted.length - keep));
        for (const r of toDelete) {
            await removePath(bundle.ssh, posixJoin(releases, r));
        }

        if (cfg.cleanAfterDeploy) {
            await exec(bundle.ssh, `rm -rf "${tmp}"`);
        }

        log.ok(`Deployed ${version} to ${envName}`);
    } finally {
        await close(bundle);
    }
}

