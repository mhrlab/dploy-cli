import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { collectRemoteStatus, formatRemoteStatus } from "../features/status.js";

export async function status(opts: { env?: string; json?: boolean }) {
    log.debug(`Status command started with options: ${JSON.stringify(opts)}`);

    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    log.verbose(`Using environment: ${envName}`);

    const env = cfg.environments?.[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);
    if (!env.deployTo) throw new Error(`Environment '${envName}' is missing deployTo`);

    if (!opts.json) {
        log.info(`Connecting to ${env.username}@${env.host} to inspect status`);
    }

    const spin = opts.json ? null : log.spinner("Connecting");
    const bundle = await connect(env).catch((e) => {
        if (spin) spin.fail("SSH connect failed");
        log.err(e.message || String(e));
        process.exit(1);
    });
    if (spin) spin.succeed("Connected");

    try {
        const remoteStatus = await collectRemoteStatus(bundle, envName, env.deployTo);
        remoteStatus.host = env.host;
        remoteStatus.username = env.username;

        if (opts.json) {
            console.log(JSON.stringify(remoteStatus, null, 2));
        } else {
            log.ok(`Status for [${envName}]`);
            for (const line of formatRemoteStatus(remoteStatus)) {
                console.log(line);
            }
        }
    } finally {
        log.verbose(`Closing SSH connection`);
        await close(bundle);
    }
}
