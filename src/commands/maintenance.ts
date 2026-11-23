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

    log.info(`Enabling maintenance mode on [${envName}] (${env.host})...`);
    const bundle = await connect(env);
    try {
        const flagPath = await enableMaintenance(bundle.ssh, env.deployTo, {
            message: opts.message,
            retryAfter: opts.retry ? Number(opts.retry) : undefined,
        });
        log.ok(`Maintenance mode enabled (${flagPath})`);
        if (opts.message) {
            log.info(`Notice: "${opts.message}"`);
        }
    } finally {
        await close(bundle);
    }
}

export async function up(opts: { env?: string }) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];

    if (!env || !env.deployTo) {
        throw new Error(`Environment '${envName}' is missing or lacks deployTo path`);
    }

    log.info(`Disabling maintenance mode on [${envName}] (${env.host})...`);
    const bundle = await connect(env);
    try {
        const status = await checkMaintenance(bundle.ssh, env.deployTo);
        if (!status) {
            log.warn(`Site is not currently in maintenance mode`);
            return;
        }

        await disableMaintenance(bundle.ssh, env.deployTo);
        log.ok(`Maintenance mode disabled. Site is live!`);
    } finally {
        await close(bundle);
    }
}
