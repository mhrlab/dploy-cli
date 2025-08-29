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

    const bundle = await connect(env);
    try {
        const dirs = (await listDirs(bundle.sftp, releases)).sort();
        const toDelete = dirs.slice(0, Math.max(0, dirs.length - keep));
        if (!toDelete.length) {
            log.ok("Nothing to clean");
            return;
        }
        for (const r of toDelete) {
            await removePath(bundle.ssh, posixJoin(releases, r));
        }
        log.ok(`Cleaned ${toDelete.length} release(s)`);
    } finally {
        await close(bundle);
    }
}
