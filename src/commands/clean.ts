import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin } from "../core/utils.js";
import {cleanupReleases} from "../features/cleaner.js";

export async function clean(opts: { env?: string; dryRun?: boolean }) {
    log.debug(`Clean started with options: ${JSON.stringify(opts)}`);

    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    log.verbose(`Using environment: ${envName}`);

    const env = cfg.environments?.[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);
    if (!env.deployTo || typeof env.deployTo !== "string" || !env.deployTo.trim()) {
        throw new Error(`Environment '${envName}' is missing required 'deployTo' path`);
    }
    const remoteRoot = env.deployTo.trim();
    if (remoteRoot === "/") {
        throw new Error(`Invalid deployTo path: cannot clean directly from root '/'`);
    }

    const releases = posixJoin(remoteRoot, "releases");
    const keep = env.keepVersions ?? 5;
    log.debug(`Releases directory: ${releases}, Keeping versions: ${keep}`);

    const spin = log.spinner(`Connecting to ${env.username}@${env.host} to clean old releases...`);
    let bundle;
    try {
        bundle = await connect(env);
        spin.succeed(`Connected to ${env.host}`);
    } catch (err) {
        spin.fail(`SSH connect failed`);
        throw err;
    }
    try {
        await cleanupReleases(bundle, releases, keep, { dryRun: opts.dryRun })
    } finally {
        log.verbose(`Closing SSH connection`);
        await close(bundle);
    }
}
