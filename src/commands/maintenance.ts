import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { enableMaintenance, disableMaintenance, checkMaintenance } from "../features/maintenance.js";

export async function down(opts: {
    env?: string;
    message?: string;
    retry?: string | number;
}) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];

    if (!env || !env.deployTo) {
        throw new Error(`Environment '${envName}' is missing or lacks deployTo path`);
    }

    const spin = log.spinner(`Connecting to ${env.host} to enable maintenance mode...`);
    let bundle;
    try {
        bundle = await connect(env);
        spin.text = `Enabling maintenance mode on [${envName}]...`;
        const flagPath = await enableMaintenance(bundle.ssh, env.deployTo, {
            message: opts.message,
            retryAfter: opts.retry ? Number(opts.retry) : undefined,
        });
        spin.succeed(`Maintenance mode enabled (${flagPath})`);
        if (opts.message) {
            log.info(`Notice: "${opts.message}"`);
        }
    } catch (err) {
        spin.fail(`Failed to enable maintenance mode on [${envName}]`);
        throw err;
    } finally {
        if (bundle) await close(bundle);
    }
}

export async function up(opts: { env?: string }) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];

    if (!env || !env.deployTo) {
        throw new Error(`Environment '${envName}' is missing or lacks deployTo path`);
    }

    const spin = log.spinner(`Connecting to ${env.host} to disable maintenance mode...`);
    let bundle;
    try {
        bundle = await connect(env);
        spin.text = `Checking maintenance status on [${envName}]...`;
        const status = await checkMaintenance(bundle.ssh, env.deployTo);
        if (!status) {
            spin.warn(`Site is not currently in maintenance mode`);
            return;
        }

        await disableMaintenance(bundle.ssh, env.deployTo);
        spin.succeed(`Maintenance mode disabled. Site is live!`);
    } catch (err) {
        spin.fail(`Failed to disable maintenance mode on [${envName}]`);
        throw err;
    } finally {
        if (bundle) await close(bundle);
    }
}
