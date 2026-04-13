import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close, listDirs } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin } from "../core/utils.js";
import { readRemoteReleaseMetadata, formatReleaseLabel } from "../features/release-metadata.js";

export async function list(opts: { env?: string }) {
    log.debug(`List command started with options: ${JSON.stringify(opts)}`);

    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    log.verbose(`Using environment: ${envName}`);

    const env = cfg.environments?.[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);
    if (!env.deployTo) throw new Error(`Environment '${envName}' is missing deployTo`);

    const releases = posixJoin((env.deployTo ? env.deployTo : ''), "releases");
    log.debug(`Releases directory: ${releases}`);

    log.info(`Connecting to ${env.username}@${env.host} to list releases`);
    const spin = log.spinner("Connecting");
    const bundle = await connect(env).catch((e) => {
        spin.fail("SSH connect failed");
        log.err(e.message || String(e));
        process.exit(1);
    });
    spin.succeed("Connected");

    try {
        log.verbose(`Listing releases in: ${releases}`);
        const dirs_list = await listDirs(bundle.sftp, releases);
        const dirs = dirs_list.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
        const releasesWithMetadata = await Promise.all(
            dirs.map(async (release) => ({
                ...release,
                metadata: await readRemoteReleaseMetadata(bundle, posixJoin(releases, release.name)),
            }))
        );

        log.debug(`Found ${releasesWithMetadata.length} releases: ${JSON.stringify(releasesWithMetadata)}`);

        if (!releasesWithMetadata.length) {
            log.warn("No releases found");
        } else {
            log.ok(`Found ${releasesWithMetadata.length} release(s):`);
            for (const release of releasesWithMetadata) {
                console.log("  -", formatReleaseLabel(release, null));
            }
        }
    } finally {
        log.verbose(`Closing SSH connection`);
        await close(bundle);
    }
}
