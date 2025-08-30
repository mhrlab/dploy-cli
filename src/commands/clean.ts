import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close, listDirs, removePath } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin } from "../core/utils.js";

export async function clean(opts: { env?: string }) {
    log.debug(`Clean started with options: ${JSON.stringify(opts)}`);

    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    log.verbose(`Using environment: ${envName}`);

    const env = cfg.environments[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);

    const releases = posixJoin(env.deployTo, "releases");
    const keep = env.keepVersions ?? 5;
    log.debug(`Releases directory: ${releases}, Keeping versions: ${keep}`);

    log.info(`Connecting to ${env.username}@${env.host} to clean old releases`);
    const bundle = await connect(env);
    try {
        log.verbose(`Listing all releases`);
        const dirs = (await listDirs(bundle.sftp, releases)).sort();
        log.debug(`Found ${dirs.length} releases: ${JSON.stringify(dirs)}`);

        const toDelete = dirs.slice(0, Math.max(0, dirs.length - keep));
        log.debug(`Releases to delete: ${JSON.stringify(toDelete)}`);

        if (!toDelete.length) {
            log.ok("Nothing to clean - all releases are within the keep limit");
            return;
        }

        log.info(`Cleaning ${toDelete.length} old release(s) to keep ${keep} latest`);
        for (const r of toDelete) {
            log.verbose(`Removing release: ${r}`);
            await removePath(bundle.ssh, posixJoin(releases, r));
        }
        log.ok(`Successfully cleaned ${toDelete.length} release(s)`);
    } finally {
        log.verbose(`Closing SSH connection`);
        await close(bundle);
    }
}
