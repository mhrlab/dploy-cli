import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { collectRemoteStatus, formatRemoteStatus } from "../features/status.js";

export async function status(opts: { env?: string }) {
    log.debug(`Status command started with options: ${JSON.stringify(opts)}`);

    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    log.verbose(`Using environment: ${envName}`);

    const env = cfg.environments?.[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);
    if (!env.deployTo) throw new Error(`Environment '${envName}' is missing deployTo`);

    log.info(`Connecting to ${env.username}@${env.host} to inspect status`);
    const spin = log.spinner("Connecting");
    const bundle = await connect(env).catch((e) => {
        spin.fail("SSH connect failed");
        log.err(e.message || String(e));
        process.exit(1);
    });
    spin.succeed("Connected");

    try {
        const remoteStatus = await collectRemoteStatus(bundle, envName, env.deployTo);
        remoteStatus.host = env.host;
        remoteStatus.username = env.username;

        log.ok(`Status for [${envName}]`);
        for (const line of formatRemoteStatus(remoteStatus)) {
            console.log(line);
        }
    } finally {
        log.verbose(`Closing SSH connection`);
        await close(bundle);
    }
}
