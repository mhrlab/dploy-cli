import inquirer from "inquirer";
import { loadConfig, getEnvName, EnvironmentConfig } from "../core/config.js";
import { connect, close, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { expandTilde, getReadableFileSize, escapeShellArg, posixJoin } from "../core/utils.js";
import { backupSiteConfigurations } from "../features/site-backup.js";
import { removeSiteConfigurations } from "../features/site-remove.js";
import { generateNginxConfig, AppKind, SslMode } from "../features/server-wizard.js";
import { printElevatedWarning } from "../core/banner.js";

export interface SiteOptions {
    env?: string;
    domain?: string;
    output?: string;
    dryRun?: boolean;
    force?: boolean;
    ssl?: SslMode;
    cloudflare?: boolean;
    certbot?: boolean;
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
    printElevatedWarning("dploy site remove", "Stops systemd services, removes Nginx virtual hosts, and cleans sudoers rules.");
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

/**
 * Inspect remote site configuration, Nginx state, systemd services, SSL certificates, and active releases.
 */
export async function siteInfo(opts: SiteOptions) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const { env, appName, deployTo, domains } = resolveSiteContext(cfg, envName, opts.domain);
    const primaryDomain = domains[0];
    const { setupConnConfig, sudoPrefix } = resolveAdminConnection(env, opts);

    log.info(`Connecting to ${setupConnConfig.username}@${setupConnConfig.host} to inspect site '${primaryDomain}'...`);
    const bundle = await connect(setupConnConfig);

    try {
        console.log(`\n======================================================`);
        console.log(` 🌐 Remote Site Overview: ${primaryDomain} [${envName}]`);
        console.log(`======================================================`);

        // 1. Release & Directory status
        const releaseRes = await exec(bundle.ssh, `readlink ${escapeShellArg(posixJoin(deployTo, "current"))} || echo "not-found"`);
        const currentTarget = releaseRes.stdout.trim();
        console.log(`  📁 Deploy Path:     ${deployTo}`);
        console.log(`  🔗 Current Release: ${currentTarget !== "not-found" ? currentTarget : "None (not linked)"}`);

        // 2. Nginx virtual host status
        const nginxAvailRes = await exec(bundle.ssh, `test -f /etc/nginx/sites-available/${escapeShellArg(primaryDomain)} && echo "yes" || echo "no"`);
        const nginxEnabledRes = await exec(bundle.ssh, `test -L /etc/nginx/sites-enabled/${escapeShellArg(primaryDomain)} && echo "yes" || echo "no"`);
        const isNginxAvail = nginxAvailRes.stdout.trim() === "yes";
        const isNginxEnabled = nginxEnabledRes.stdout.trim() === "yes";
        console.log(`  🌍 Nginx VHost:     ${isNginxAvail ? "Configured" : "Missing"} (${isNginxEnabled ? "Enabled" : "Disabled"})`);

        // Check if Nginx syntax is clean
        const nginxTestRes = await exec(bundle.ssh, `${sudoPrefix}nginx -t`);
        console.log(`  ⚙️  Nginx Syntax:    ${nginxTestRes.code === 0 ? "Valid (nginx -t passed)" : "Failed syntax test"}`);

        // 3. Systemd App Service status
        const serviceName = `${appName}.service`;
        const serviceStatusRes = await exec(bundle.ssh, `systemctl is-active ${escapeShellArg(appName)} 2>/dev/null || echo "inactive"`);
        const serviceState = serviceStatusRes.stdout.trim();
        console.log(`  ⚡ App Service:     ${serviceName} [${serviceState}]`);

        // Worker Service status
        const workerName = `${appName}-worker.service`;
        const workerCheck = await exec(bundle.ssh, `test -f /etc/systemd/system/${escapeShellArg(workerName)} && echo "yes" || echo "no"`);
        if (workerCheck.stdout.trim() === "yes") {
            const workerStatusRes = await exec(bundle.ssh, `systemctl is-active ${escapeShellArg(`${appName}-worker`)} 2>/dev/null || echo "inactive"`);
            console.log(`  👷 Worker Service:  ${workerName} [${workerStatusRes.stdout.trim()}]`);
        }

        // 4. SSL Certificate status
        const certbotCheck = await exec(bundle.ssh, `${sudoPrefix}certbot certificates --cert-name ${escapeShellArg(primaryDomain)} 2>/dev/null || true`);
        if (certbotCheck.code === 0 && certbotCheck.stdout.includes("Expiry Date:")) {
            const expiryMatch = certbotCheck.stdout.match(/Expiry Date:\s*([^\n]+)/);
            console.log(`  🔒 SSL Certificate: Certbot (Expires: ${expiryMatch ? expiryMatch[1].trim() : "Active"})`);
        } else {
            // Check if Cloudflare origin cert exists
            const cfOriginCheck = await exec(bundle.ssh, `test -f /etc/ssl/certs/cf-origin-${escapeShellArg(primaryDomain)}.pem && echo "yes" || echo "no"`);
            if (cfOriginCheck.stdout.trim() === "yes") {
                console.log(`  🔒 SSL Certificate: Cloudflare Origin CA (/etc/ssl/certs/cf-origin-${primaryDomain}.pem)`);
            } else {
                console.log(`  🔒 SSL Certificate: Standard HTTP or Cloudflare Flexible`);
            }
        }
        console.log(`======================================================\n`);
    } finally {
        await close(bundle);
    }
}

/**
 * Switch or update SSL mode for an existing site without re-running full server setup.
 */
export async function siteSsl(opts: SiteOptions) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const { env, appName, deployTo, domains } = resolveSiteContext(cfg, envName, opts.domain);
    const primaryDomain = domains[0];
    const { setupConnConfig, sudoPrefix } = resolveAdminConnection(env, opts);

    let sslMode = opts.ssl;
    if (!sslMode) {
        if (opts.certbot) {
            sslMode = "certbot";
        } else if (opts.cloudflare) {
            sslMode = "cloudflare-flexible";
        }
    }

    if (!sslMode && process.stdin.isTTY) {
        const ans = await inquirer.prompt([
            {
                type: "list",
                name: "sslMode",
                message: `Select new SSL mode for '${primaryDomain}':`,
                choices: [
                    { name: "Certbot (Let's Encrypt automated SSL certificate)", value: "certbot" },
                    { name: "Cloudflare Flexible SSL (Real-IP restoration, HTTP 80 upstream)", value: "cloudflare-flexible" },
                    { name: "Cloudflare Origin CA Certificate (Full / Strict 443 SSL)", value: "cloudflare-origin" },
                    { name: "Plain HTTP / Disable SSL", value: "none" },
                ],
                default: "certbot",
            },
        ]);
        sslMode = ans.sslMode;
    }

    if (!sslMode) {
        throw new Error("SSL mode must be specified (certbot, cloudflare-flexible, cloudflare-origin, none)");
    }

    if (opts.dryRun) {
        log.info("[dry-run] Planned SSL reconfiguration:");
        log.info(`[dry-run] Host: ${setupConnConfig.host}`);
        log.info(`[dry-run] Domain: ${primaryDomain}`);
        log.info(`[dry-run] New SSL Mode: ${sslMode}`);
        return;
    }

    // Inspect existing remote Nginx configuration to determine app kind
    log.info(`Connecting to ${setupConnConfig.username}@${setupConnConfig.host}...`);
    const bundle = await connect(setupConnConfig);

    try {
        const confPath = `/etc/nginx/sites-available/${primaryDomain}`;
        const catRes = await exec(bundle.ssh, `${sudoPrefix}cat ${escapeShellArg(confPath)}`);
        if (catRes.code !== 0) {
            throw new Error(`Remote Nginx configuration for '${primaryDomain}' not found at ${confPath}. Run 'dploy setup' first.`);
        }

        const existingConf = catRes.stdout;
        // Detect app kind from existing config
        let kind: AppKind = "node";
        let rootDir: string | undefined;
        let phpSocket: string | undefined;
        let port: number = 3000;

        if (existingConf.includes("fastcgi_pass")) {
            kind = "php";
            const socketMatch = existingConf.match(/fastcgi_pass\s+([^;]+);/);
            if (socketMatch) phpSocket = socketMatch[1].trim();
            rootDir = posixJoin(deployTo, "current", "public");
        } else if (existingConf.includes("try_files $uri $uri/ /index.html;")) {
            kind = "spa";
            rootDir = posixJoin(deployTo, "current", "dist");
        } else {
            kind = "node";
            const portMatch = existingConf.match(/proxy_pass http:\/\/127\.0\.0\.1:(\d+);/);
            if (portMatch) port = parseInt(portMatch[1], 10);
        }

        log.info(`Detected application kind '${kind}'. Generating updated Nginx config for SSL: ${sslMode}...`);
        const updatedConf = await generateNginxConfig({
            kind,
            domains,
            deployTo,
            rootDir,
            port,
            phpSocket,
            ssl: sslMode,
            cloudflareRealIp: Boolean(opts.cloudflare || sslMode.startsWith("cloudflare")),
        });

        if (opts.dryRun) {
            log.info("[dry-run] Preview of updated Nginx configuration:");
            console.log(updatedConf);
            return;
        }

        // Write remotely using sudo tee
        const base64 = Buffer.from(updatedConf, "utf8").toString("base64");
        const writeCmd = `echo ${escapeShellArg(base64)} | base64 -d | ${sudoPrefix}tee ${escapeShellArg(confPath)} > /dev/null`;
        await exec(bundle.ssh, writeCmd);

        // Ensure sites-enabled symlink
        const enabledPath = `/etc/nginx/sites-enabled/${primaryDomain}`;
        await exec(bundle.ssh, `${sudoPrefix}ln -sfn ${escapeShellArg(confPath)} ${escapeShellArg(enabledPath)}`);

        // Test syntax
        const testRes = await exec(bundle.ssh, `${sudoPrefix}nginx -t`);
        if (testRes.code !== 0) {
            throw new Error(`Nginx syntax check failed: ${testRes.stderr || testRes.stdout}`);
        }

        // Request certbot if selected
        if (sslMode === "certbot") {
            log.info(`Requesting / renewing Certbot certificate for ${domains.join(", ")}...`);
            const certbotCmd = `${sudoPrefix}certbot --nginx -d ${domains.map((d) => escapeShellArg(d)).join(" -d ")} --non-interactive --agree-tos -m admin@${primaryDomain} --redirect || true`;
            await exec(bundle.ssh, certbotCmd);
        }

        await exec(bundle.ssh, `${sudoPrefix}systemctl reload nginx`);
        log.ok(`SSL mode updated to '${sslMode}' and Nginx reloaded for ${primaryDomain}!`);
    } finally {
        await close(bundle);
    }
}
