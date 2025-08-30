import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close, listDirs, removePath } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin } from "../core/utils.js";

export async function clean(opts: { env?: string }) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);

    const releases = posixJoin(env.deployTo, "releases");
    const keep = env.keepVersions ?? 5;

    log.info(`Connecting to ${env.username}@${env.host} to clean old releases`);
    const bundle = await connect(env);
    try {
        const dirs = (await listDirs(bundle.sftp, releases)).sort();
        const toDelete = dirs.slice(0, Math.max(0, dirs.length - keep));
        if (!toDelete.length) {
            log.ok("Nothing to clean - all releases are within the keep limit");
            return;
        }

        log.info(`Cleaning ${toDelete.length} old release(s) to keep ${keep} latest`);
        for (const r of toDelete) {
            await removePath(bundle.ssh, posixJoin(releases, r));
        }
        log.ok(`Successfully cleaned ${toDelete.length} release(s)`);
    } finally {
        await close(bundle);
    }
}
