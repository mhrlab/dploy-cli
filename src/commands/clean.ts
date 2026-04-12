import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close, listDirs, removePath } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin } from "../core/utils.js";
import {cleanupReleases} from "../features/cleaner.js";

export async function clean(opts: { env?: string }) {
    log.debug(`Clean started with options: ${JSON.stringify(opts)}`);

    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    log.verbose(`Using environment: ${envName}`);

    const env = cfg.environments?.[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);

    const releases = posixJoin((env.deployTo ? env.deployTo : ''), "releases");
    const keep = env.keepVersions ?? 5;
    log.debug(`Releases directory: ${releases}, Keeping versions: ${keep}`);

    log.info(`Connecting to ${env.username}@${env.host} to clean old releases`);
    const bundle = await connect(env);
    try {
        await cleanupReleases(bundle, releases, keep)
    } finally {
        log.verbose(`Closing SSH connection`);
        await close(bundle);
    }
}
