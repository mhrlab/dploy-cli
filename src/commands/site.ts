import { loadConfig, getEnvName, EnvironmentConfig } from "../core/config.js";
import { connect, close, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { expandTilde, getReadableFileSize, escapeShellArg, posixJoin, toSudoersSlug } from "../core/utils.js";
import { backupSiteConfigurations } from "../features/site-backup.js";
import { removeSiteConfigurations } from "../features/site-remove.js";
import { generateNginxConfig, getSslModeGuidance, AppKind, SslMode } from "../features/server-wizard.js";
import { printElevatedWarning } from "../core/banner.js";
import { setup, SetupOptions } from "./setup.js";

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
    asAdmin?: boolean;
    asSudo?: boolean;
}

function resolveAdminConnection(env: EnvironmentConfig, opts: SiteOptions): { setupConnConfig: EnvironmentConfig; sudoPrefix: string } {
    const isExplicitAdminRequested = Boolean(opts.asAdmin || opts.asSudo || opts.adminUser || opts.adminKey || opts.adminPassword);

    const adminUser = opts.adminUser || process.env.DPLOY_ADMIN_USER || (isExplicitAdminRequested ? env.admin?.username : env.admin?.username);

    if ((opts.asAdmin || opts.asSudo) && !adminUser) {
        throw new Error(`Admin credentials not found in 'admin' block of deploy.config.yml for this environment. Please configure 'admin:' or pass --admin-user.`);
    }

    const adminKey = opts.adminKey || process.env.DPLOY_ADMIN_KEY || env.admin?.ssh_key_path;
    const adminPassword = opts.adminPassword || process.env.DPLOY_ADMIN_PASSWORD || env.admin?.password;

    const setupConnConfig: EnvironmentConfig = {
        ...env,
        username: adminUser || env.username,
        ssh_key_path: adminKey ? expandTilde(adminKey) : (adminUser && adminUser !== env.username && !env.admin?.ssh_key_path ? env.ssh_key_path : (env.admin?.ssh_key_path ? expandTilde(env.admin.ssh_key_path) : env.ssh_key_path)),
        password: adminPassword || (adminUser && adminUser !== env.username ? env.admin?.password : env.password),
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
    if (!env.host && !env.hosts) {
        throw new Error(`Environment '${envName}' is missing required 'host' or 'username'`);
    }

    const appName = cfg.name || "app";
    const deployTo = env.deployTo ? env.deployTo.trim() : `/var/www/${appName}`;

    const domains: string[] = [];
    if (domainOverride) {
        domains.push(...domainOverride.split(/\s+/).filter(Boolean));
    } else if (env.domain) {
        domains.push(...String(env.domain).split(/\s+/).filter(Boolean));
    } else if (Array.isArray(env.domains) && env.domains.length > 0) {
        domains.push(...env.domains.map((d: any) => String(d).trim()));
    } else if (cfg.domain) {
        domains.push(...String(cfg.domain).split(/\s+/).filter(Boolean));
    } else if (Array.isArray(cfg.domains) && cfg.domains.length > 0) {
        domains.push(...cfg.domains.map((d: any) => String(d).trim()));
    } else {
        // Auto-detect domain from deployTo path (e.g. /var/www/tunenest.in -> tunenest.in)
        const deployBasename = deployTo.replace(/\/+$/, "").split("/").pop();
        if (deployBasename && deployBasename.includes(".") && !deployBasename.includes(" ")) {
            domains.push(deployBasename);
        } else if (env.host && env.host !== "localhost") {
            domains.push(env.host);
        } else {
            domains.push("example.com");
        }
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

    const spin = log.spinner(`Connecting to ${setupConnConfig.username}@${setupConnConfig.host} to backup configurations...`);
    let bundle;
    try {
        bundle = await connect(setupConnConfig);
        spin.succeed(`Connected to ${setupConnConfig.host}`);
    } catch (err) {
        spin.fail(`Failed to connect to ${setupConnConfig.host}`);
        throw err;
    }

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
    printElevatedWarning("dploy site remove", "Stops services, removes Nginx virtual hosts, and cleans sudoers rules.");
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
        const { default: inquirer } = await import("inquirer");
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
        const appSlug = toSudoersSlug(appName);
        log.info(`[dry-run] Sudoers rule to remove: /etc/sudoers.d/dploy-${appSlug}`);
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

    const spin = log.spinner(`Connecting to ${setupConnConfig.username}@${setupConnConfig.host} to inspect '${primaryDomain}'...`);
    let bundle;
    try {
        bundle = await connect(setupConnConfig);
        spin.succeed(`Connected to ${setupConnConfig.host}`);
    } catch (err) {
        spin.fail(`Failed to connect to ${setupConnConfig.host}`);
        throw err;
    }

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
        const nginxTestRes = await exec(bundle.ssh, `${sudoPrefix}nginx -t 2>&1`);
        let nginxStatusText = "Valid (nginx -t passed)";
        if (nginxTestRes.code !== 0) {
            const errOutput = (nginxTestRes.stdout || nginxTestRes.stderr || "").trim();
            if (errOutput.includes("password is required") || errOutput.includes("sudo: a password is required") || errOutput.includes("not in sudoers")) {
                nginxStatusText = "Requires sudo (specify --admin-user or configure env.admin)";
            } else if (errOutput.includes("command not found") || errOutput.includes("not found")) {
                nginxStatusText = "Nginx not installed";
            } else {
                const firstErr = errOutput.split(/\r?\n/).find((l: string) => l.toLowerCase().includes("emerg") || l.toLowerCase().includes("error") || l.toLowerCase().includes("failed")) || errOutput.split(/\r?\n/)[0];
                nginxStatusText = `Failed (${firstErr || "syntax error"})`;
            }
        }
        console.log(`  ⚙️  Nginx Syntax:    ${nginxStatusText}`);

        // 3. Systemd App Service status (only if a systemd unit actually exists on the remote host)
        const serviceName = `${appName}.service`;
        const serviceExistsRes = await exec(bundle.ssh, `test -f /etc/systemd/system/${escapeShellArg(serviceName)} && echo "yes" || echo "no"`);
        if (serviceExistsRes.stdout.trim() === "yes") {
            const serviceStatusRes = await exec(bundle.ssh, `systemctl is-active ${escapeShellArg(appName)} 2>/dev/null || true`);
            const serviceState = serviceStatusRes.stdout.trim().split(/\r?\n/)[0] || "inactive";
            console.log(`  ⚡ App Service:     ${serviceName} [${serviceState}]`);
        } else {
            const isPhp = cfg.framework?.includes("php") || cfg.framework?.includes("codeigniter") || cfg.framework?.includes("laravel") || cfg.name?.toLowerCase().includes("codeigniter") || cfg.name?.toLowerCase().includes("php");
            if (isPhp) {
                console.log(`  ⚡ App Engine:      PHP-FPM (served via Nginx)`);
            }
        }

        // Worker Service status
        const workerName = `${appName}-worker.service`;
        const workerCheck = await exec(bundle.ssh, `test -f /etc/systemd/system/${escapeShellArg(workerName)} && echo "yes" || echo "no"`);
        if (workerCheck.stdout.trim() === "yes") {
            const workerStatusRes = await exec(bundle.ssh, `systemctl is-active ${escapeShellArg(`${appName}-worker`)} 2>/dev/null || true`);
            const workerState = workerStatusRes.stdout.trim().split(/\r?\n/)[0] || "inactive";
            console.log(`  👷 Worker Service:  ${workerName} [${workerState}]`);
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
        const { default: inquirer } = await import("inquirer");
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

        for (const line of getSslModeGuidance(sslMode, primaryDomain)) {
            log.info(line);
        }
    } finally {
        await close(bundle);
    }
}

export async function siteAdd(opts: SetupOptions) {
    return setup({
        ...opts,
        createDeployer: false,
        skipUserSetup: true,
    });
}

export interface DiscoveredService {
    name: string;
    activeState: string;
    enabledState: string;
}

export type ServiceAction = "start" | "stop" | "restart" | "reload" | "enable" | "disable" | "status" | "logs";

const VALID_SERVICE_ACTIONS: ServiceAction[] = [
    "restart",
    "reload",
    "start",
    "stop",
    "enable",
    "disable",
    "status",
    "logs",
];

/**
 * Manage systemd background services (app, queue worker, nginx, php-fpm) on the remote server.
 */
export async function siteService(
    opts: SiteOptions & { serviceName?: string; action?: string }
): Promise<void> {
    printElevatedWarning("dploy site service", "Manages remote systemd services (start, stop, restart, enable, logs).");
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const { env, appName, deployTo, domains } = resolveSiteContext(cfg, envName, opts.domain);
    const { setupConnConfig, sudoPrefix } = resolveAdminConnection(env, opts);

    const requestedAction = opts.action?.toLowerCase() as ServiceAction | undefined;
    if (requestedAction && !VALID_SERVICE_ACTIONS.includes(requestedAction)) {
        throw new Error(
            `Invalid service action '${opts.action}'. Valid actions: ${VALID_SERVICE_ACTIONS.join(", ")}`
        );
    }

    if (opts.dryRun) {
        const appSlug = toSudoersSlug(appName);
        log.info("[dry-run] Planned service management:");
        log.info(`[dry-run] Host: ${setupConnConfig.host}`);
        log.info(`[dry-run] Target service: ${opts.serviceName || `${appSlug}.service / ${appSlug}-worker.service / nginx / php*-fpm`}`);
        log.info(`[dry-run] Action: ${requestedAction || "(interactive selection)"}`);
        return;
    }

    const spin = log.spinner(`Connecting to ${setupConnConfig.username}@${setupConnConfig.host}...`);
    let bundle;
    try {
        bundle = await connect(setupConnConfig);
        spin.succeed(`Connected to ${setupConnConfig.host}`);
    } catch (err: any) {
        spin.fail(`Failed to connect to ${setupConnConfig.host}`);
        throw err;
    }

    try {
        const discoverServices = async (): Promise<DiscoveredService[]> => {
            const scanSpin = log.spinner("Discovering installed services on server...");
            const appSlug = toSudoersSlug(appName);
            const primaryDomain = domains[0];
            const candidates = [
                `${appName}.service`,
                `${appName}-worker.service`,
                `${appSlug}.service`,
                `${appSlug}-worker.service`,
                ...(primaryDomain ? [`${primaryDomain}.service`, `${primaryDomain}-worker.service`] : []),
                "nginx.service",
            ];

            // Discover any systemd service in /etc/systemd/system referencing this site's deployTo path
            const grepScanRes = await exec(
                bundle.ssh,
                `${sudoPrefix}grep -l ${escapeShellArg(deployTo)} /etc/systemd/system/*.service 2>/dev/null || true`
            );
            for (const line of grepScanRes.stdout.split(/\r?\n/)) {
                const fullPath = line.trim();
                if (fullPath) {
                    const unit = fullPath.split("/").pop();
                    if (unit && !candidates.includes(unit)) candidates.push(unit);
                }
            }

            // Discover installed php*-fpm units as well
            const phpScanRes = await exec(
                bundle.ssh,
                `${sudoPrefix}systemctl list-unit-files 'php*-fpm.service' 'php-fpm.service' --no-legend 2>/dev/null | awk '{print $1}'`
            );
            for (const line of phpScanRes.stdout.split(/\r?\n/)) {
                const unit = line.trim();
                if (unit && !candidates.includes(unit)) candidates.push(unit);
            }

            const uniqueCandidates = Array.from(new Set(candidates));
            const discovered: DiscoveredService[] = [];
            for (const unit of uniqueCandidates) {
                const checkRes = await exec(
                    bundle.ssh,
                    `if ${sudoPrefix}systemctl list-unit-files ${escapeShellArg(unit)} --no-legend 2>/dev/null | grep -q ${escapeShellArg(unit)} || [ -f ${escapeShellArg(`/etc/systemd/system/${unit}`)} ]; then ` +
                    `active=$(${sudoPrefix}systemctl is-active ${escapeShellArg(unit)} 2>/dev/null || echo inactive); ` +
                    `enabled=$(${sudoPrefix}systemctl is-enabled ${escapeShellArg(unit)} 2>/dev/null || echo disabled); ` +
                    `echo "$active|$enabled"; fi`
                );
                const out = checkRes.stdout.trim();
                if (out) {
                    const [activeState, enabledState] = out.split("|");
                    discovered.push({
                        name: unit,
                        activeState: activeState || "unknown",
                        enabledState: enabledState || "unknown",
                    });
                }
            }
            scanSpin.succeed(`Found ${discovered.length} installed service(s)`);
            return discovered;
        };

        const executeServiceAction = async (svcName: string, act: ServiceAction): Promise<void> => {
            const svcArg = escapeShellArg(svcName);
            if (act === "logs") {
                const logSpin = log.spinner(`Fetching recent logs for ${svcName}...`);
                const res = await exec(bundle.ssh, `${sudoPrefix}journalctl -u ${svcArg} -n 50 --no-pager`);
                logSpin.stop();
                if (res.stdout) console.log(res.stdout);
                if (res.stderr) console.error(res.stderr);
                return;
            }

            if (act === "status") {
                const statusSpin = log.spinner(`Checking status of ${svcName}...`);
                const res = await exec(bundle.ssh, `${sudoPrefix}systemctl status ${svcArg} --no-pager -l || true`);
                statusSpin.stop();
                if (res.stdout) console.log(res.stdout);
                return;
            }

            const actSpin = log.spinner(`Running '${act}' on ${svcName}...`);
            const res = await exec(bundle.ssh, `${sudoPrefix}systemctl ${act} ${svcArg}`);
            if (res.code !== 0) {
                actSpin.fail(`Failed to ${act} ${svcName}`);
                throw new Error(res.stderr.trim() || res.stdout.trim() || `systemctl ${act} exited with code ${res.code}`);
            }
            actSpin.succeed(`Successfully ran '${act}' on ${svcName}`);
        };

        // Direct non-interactive / explicit service execution
        if (opts.serviceName?.trim()) {
            const targetService = opts.serviceName.trim();
            let action = requestedAction;
            if (!action) {
                if (!process.stdin.isTTY) {
                    action = "status";
                } else {
                    const { default: inquirer } = await import("inquirer");
                    const actAns = await inquirer.prompt([
                        {
                            type: "list",
                            name: "action",
                            message: `Select action for ${targetService}:`,
                            choices: [
                                { name: "Restart", value: "restart" },
                                { name: "Reload", value: "reload" },
                                { name: "Start", value: "start" },
                                { name: "Stop", value: "stop" },
                                { name: "Enable on boot", value: "enable" },
                                { name: "Disable on boot", value: "disable" },
                                { name: "Show status", value: "status" },
                                { name: "View last 50 journal logs", value: "logs" },
                                { name: "Cancel", value: "cancel" },
                            ],
                        },
                    ]);
                    if (actAns.action === "cancel") return;
                    action = actAns.action;
                }
            }
            await executeServiceAction(targetService, action!);
            return;
        }

        // Interactive discovery + Back navigation loop
        let discovered = await discoverServices();
        if (discovered.length === 0) {
            log.warn(`No managed services found for '${appName}'. Run 'dploy setup' or pass a service name explicitly.`);
            return;
        }

        if (!process.stdin.isTTY) {
            for (const svc of discovered) {
                console.log(`  - ${svc.name.padEnd(28)} [${svc.activeState}, ${svc.enabledState}]`);
            }
            return;
        }

        const { default: inquirer } = await import("inquirer");
        while (true) {
            const svcAns = await inquirer.prompt([
                {
                    type: "list",
                    name: "service",
                    message: "Select a service to manage:",
                    choices: [
                        ...discovered.map((s) => ({
                            name: `${s.name.padEnd(28)} [${s.activeState}, ${s.enabledState}]`,
                            value: s.name,
                        })),
                        new inquirer.Separator(),
                        { name: "Refresh service list", value: "__REFRESH__" },
                        { name: "Exit", value: "__EXIT__" },
                    ],
                },
            ]);

            if (svcAns.service === "__EXIT__") return;
            if (svcAns.service === "__REFRESH__") {
                discovered = await discoverServices();
                continue;
            }

            const targetService = svcAns.service as string;
            if (requestedAction) {
                await executeServiceAction(targetService, requestedAction);
                return;
            }

            const actAns = await inquirer.prompt([
                {
                    type: "list",
                    name: "action",
                    message: `Select action for ${targetService}:`,
                    choices: [
                        { name: "Restart", value: "restart" },
                        { name: "Reload", value: "reload" },
                        { name: "Start", value: "start" },
                        { name: "Stop", value: "stop" },
                        { name: "Enable on boot", value: "enable" },
                        { name: "Disable on boot", value: "disable" },
                        { name: "Show status", value: "status" },
                        { name: "View last 50 journal logs", value: "logs" },
                        new inquirer.Separator(),
                        { name: "<- Back to services", value: "__BACK__" },
                    ],
                },
            ]);

            if (actAns.action === "__BACK__") {
                continue;
            }

            await executeServiceAction(targetService, actAns.action as ServiceAction);
            discovered = await discoverServices();
        }
    } finally {
        await close(bundle);
    }
}
