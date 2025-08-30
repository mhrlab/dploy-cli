import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close, listDirs } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin } from "../core/utils.js";

export async function list(opts: { env?: string }) {
    log.debug(`List command started with options: ${JSON.stringify(opts)}`);

    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    log.verbose(`Using environment: ${envName}`);

    const env = cfg.environments[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);

    const releases = posixJoin(env.deployTo, "releases");
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
        const dirs = await listDirs(bundle.sftp, releases);
        log.debug(`Found ${dirs.length} releases: ${JSON.stringify(dirs)}`);

        if (!dirs.length) {
            log.warn("No releases found");
        } else {
            log.ok(`Found ${dirs.length} release(s):`);
            for (const d of dirs.sort()) {
                console.log("  -", d);
            }
        }
    } finally {
        log.verbose(`Closing SSH connection`);
        await close(bundle);
    }
}
