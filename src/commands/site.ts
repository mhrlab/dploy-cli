import inquirer from "inquirer";
import { loadConfig, getEnvName, EnvironmentConfig } from "../core/config.js";
import { connect, close } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { expandTilde, getReadableFileSize } from "../core/utils.js";
import { backupSiteConfigurations } from "../features/site-backup.js";
import { removeSiteConfigurations } from "../features/site-remove.js";

export interface SiteOptions {
    env?: string;
    domain?: string;
    output?: string;
    dryRun?: boolean;
    force?: boolean;
    noBackup?: boolean;
    purgeNginx?: boolean;
    purgeServices?: boolean;
    purgeSudoers?: boolean;
    purgeSsl?: boolean;
    purgeFiles?: boolean;
    adminUser?: string;
    adminKey?: string;
    adminPassword?: string;
}

function resolveAdminConnection(env: EnvironmentConfig, opts: SiteOptions): { setupConnConfig: EnvironmentConfig; sudoPrefix: string } {
    const adminUser = opts.adminUser || env.admin?.username;
    const adminKey = opts.adminKey || env.admin?.ssh_key_path;
    const adminPassword = opts.adminPassword || env.admin?.password;

    const setupConnConfig: EnvironmentConfig = {
        ...env,
        username: adminUser || env.username,
        ssh_key_path: adminKey ? expandTilde(adminKey) : env.ssh_key_path,
        password: adminPassword || env.password,
        passphrase: env.admin?.passphrase || env.passphrase,
    };

    const isRunningAsRoot = setupConnConfig.username === "root";
    const sudoPrefix = isRunningAsRoot ? "" : "sudo -n ";
    return { setupConnConfig, sudoPrefix };
}

function resolveSiteContext(cfg: any, envName: string, domainOverride?: string) {
    const env = cfg.environments?.[envName];
    if (!env) {
        throw new Error(`Unknown environment: ${envName}`);
    }
    if (!env.host || !env.username) {
        throw new Error(`Environment '${envName}' is missing required 'host' or 'username'`);
    }

    const appName = cfg.name || "app";
    const deployTo = env.deployTo ? env.deployTo.trim() : `/var/www/${appName}`;

    const domains: string[] = [];
    if (domainOverride) {
        domains.push(...domainOverride.split(/\s+/).filter(Boolean));
    } else if (env.host && env.host !== "localhost") {
        domains.push(env.host);
    } else {
        domains.push("example.com");
    }

    return { env, appName, deployTo, domains };
}

/**
 * Creates a local backup of the remote site configurations (Nginx, Systemd, Sudoers, .env).
 */
export async function siteBackup(opts: SiteOptions) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const { env, appName, deployTo, domains } = resolveSiteContext(cfg, envName, opts.domain);
    const { setupConnConfig, sudoPrefix } = resolveAdminConnection(env, opts);

    log.info(`Connecting to ${setupConnConfig.username}@${setupConnConfig.host} to backup configurations for '${domains.join(", ")}'...`);
    const bundle = await connect(setupConnConfig);

    try {
        const result = await backupSiteConfigurations(bundle.ssh, bundle.sftp, {
            appName,
            domains,
            deployTo,
            outputDir: opts.output,
            sudoPrefix,
        });

        log.ok(`Site configuration backup completed!`);
        log.info(`Archive: ${result.archivePath} [ ${getReadableFileSize(result.sizeBytes)} ]`);
        log.info(`Included ${result.filesIncluded.length} configuration file(s):`);
        for (const file of result.filesIncluded) {
            console.log(`  - ${file}`);
        }
    } finally {
        await close(bundle);
    }
}

/**
 * Safely decommissions and cleans up remote site configurations and services.
 */
export async function siteRemove(opts: SiteOptions) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const { env, appName, deployTo, domains } = resolveSiteContext(cfg, envName, opts.domain);
    const primaryDomain = domains[0];
    const { setupConnConfig, sudoPrefix } = resolveAdminConnection(env, opts);

    // Confirmation gate: require explicit prompt or --force flag
    if (!opts.force) {
        if (!process.stdin.isTTY) {
            throw new Error(`Decommissioning requires --force flag when running non-interactively.`);
        }

        log.warn(`You are about to remove server configurations for: ${domains.join(", ")} (${envName})`);
        const confirmAnswer = await inquirer.prompt([
            {
                type: "input",
                name: "confirmedDomain",
                message: `Type the domain name '${primaryDomain}' to confirm teardown:`,
            },
        ]);

        if (confirmAnswer.confirmedDomain.trim() !== primaryDomain) {
            log.info("Domain mismatch. Teardown cancelled.");
            return;
        }

        // Check if user wants options
        const optionsAnswer = await inquirer.prompt([
            {
                type: "confirm",
                name: "backupFirst",
                message: "Create a local backup archive of configs before removing?",
                default: true,
            },
            {
                type: "confirm",
                name: "purgeFiles",
                message: `Purge deploy files directory (${deployTo}) as well?`,
                default: false,
            },
            {
                type: "confirm",
                name: "purgeSsl",
                message: `Delete Certbot SSL certificate for ${domains.join(", ")}?`,
                default: false,
            },
        ]);

        if (optionsAnswer.backupFirst) {
            opts.noBackup = false;
        } else {
            opts.noBackup = true;
        }
        opts.purgeFiles = optionsAnswer.purgeFiles;
        opts.purgeSsl = optionsAnswer.purgeSsl;
    }

    if (opts.dryRun) {
        log.info("[dry-run] Planned site teardown:");
        log.info(`[dry-run] Host: ${setupConnConfig.host}`);
        log.info(`[dry-run] Domains to remove from Nginx: ${domains.join(", ")}`);
        log.info(`[dry-run] Services to stop and remove: ${appName}.service, ${appName}-worker.service`);
        log.info(`[dry-run] Sudoers rule to remove: /etc/sudoers.d/dploy-${appName}`);
        if (opts.purgeSsl) log.info(`[dry-run] Certbot certificate to delete: ${domains.join(", ")}`);
        if (opts.purgeFiles) log.info(`[dry-run] Deploy directory to remove: ${deployTo}`);
        return;
    }

    log.info(`Connecting to ${setupConnConfig.username}@${setupConnConfig.host} to execute teardown...`);
    const bundle = await connect(setupConnConfig);

    try {
        // Step 1: Automatic backup unless disabled
        if (!opts.noBackup) {
            log.info("Creating pre-removal configuration snapshot...");
            try {
                const backupResult = await backupSiteConfigurations(bundle.ssh, bundle.sftp, {
                    appName,
                    domains,
                    deployTo,
                    outputDir: opts.output,
                    sudoPrefix,
                });
                log.ok(`Backup saved to: ${backupResult.archivePath}`);
            } catch (err: any) {
                log.warn(`Warning: Pre-removal backup failed: ${err.message}`);
            }
        }

        // Step 2: Execute removal plan
        const results = await removeSiteConfigurations(bundle.ssh, {
            appName,
            domains,
            deployTo,
            purgeNginx: opts.purgeNginx ?? true,
            purgeServices: opts.purgeServices ?? true,
            purgeSudoers: opts.purgeSudoers ?? true,
            purgeSsl: opts.purgeSsl ?? false,
            purgeFiles: opts.purgeFiles ?? false,
            sudoPrefix,
        });

        for (const res of results) {
            if (res.success) {
                log.ok(res.message);
            } else {
                log.warn(res.message);
            }
        }

        log.ok(`Site removal for '${primaryDomain}' completed successfully!`);
    } finally {
        await close(bundle);
    }
}
