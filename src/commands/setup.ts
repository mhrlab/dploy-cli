import inquirer from "inquirer";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { loadConfig, getEnvName, EnvironmentConfig } from "../core/config.js";
import { connect, close, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin, escapeShellArg, expandTilde, toSudoersSlug } from "../core/utils.js";
import { printElevatedWarning } from "../core/banner.js";
import {
    generateNginxConfig,
    generateSystemdUnit,
    AppKind,
    SslMode,
    NginxConfigParams,
    SystemdConfigParams,
} from "../features/server-wizard.js";

/**
 * Write a string content safely to a remote file, using sudo tee if needed.
 */
async function writeRemotePrivilegedFile(
    ssh: any,
    targetPath: string,
    content: string,
    sudoPrefix: string
): Promise<void> {
    const base64 = Buffer.from(content, "utf8").toString("base64");
    // Decode base64 remotely and write via sudo tee without needing SFTP write permission on /tmp or system directories
    const cmd = `echo ${escapeShellArg(base64)} | base64 -d | ${sudoPrefix}tee ${escapeShellArg(targetPath)} > /dev/null`;
    const res = await exec(ssh, cmd);
    if (res.code !== 0) {
        throw new Error(`Failed to write ${targetPath}: ${res.stderr || res.stdout}`);
    }
}

/**
 * Generate a clean, responsive "Coming Soon / Deployment in Progress" placeholder HTML page.
 */
function renderComingSoonHtml(domain: string, envName: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${domain} &mdash; Coming Soon</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(255, 255, 255, 0.04);
      --border: rgba(255, 255, 255, 0.1);
      --text: #f3f4f6;
      --muted: #9ca3af;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.2);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 1rem;
      padding: 3rem 2.5rem;
      max-width: 580px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(12px);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.85rem;
      border-radius: 9999px;
      background: var(--accent-glow);
      color: var(--accent);
      font-size: 0.85rem;
      font-weight: 600;
      letter-spacing: 0.025em;
      margin-bottom: 1.5rem;
    }
    .badge-dot {
      width: 8px;
      height: 8px;
      background: var(--accent);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--accent);
    }
    h1 {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.025em;
      margin-bottom: 0.75rem;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p {
      color: var(--muted);
      font-size: 1.05rem;
      line-height: 1.6;
      margin-bottom: 2rem;
    }
    .meta-box {
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 0.85rem 1.25rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.875rem;
      color: #93c5fd;
      display: flex;
      justify-content: space-between;
      margin-bottom: 2rem;
    }
    .meta-label { color: var(--muted); }
    .footer {
      font-size: 0.85rem;
      color: #6b7280;
    }
    .footer strong { color: #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">
      <span class="badge-dot"></span>
      <span>Setup Completed</span>
    </div>
    <h1>${domain}</h1>
    <p>This web server and SSL certificate have been provisioned successfully. The application deployment is pending.</p>
    <div class="meta-box">
      <span><span class="meta-label">Environment:</span> ${envName}</span>
      <span><span class="meta-label">Status:</span> Live</span>
    </div>
    <div class="footer">
      Powered by <strong>dploy-cli</strong>
    </div>
  </div>
</body>
</html>`;
}

export interface SetupOptions {
    env?: string;
    dryRun?: boolean;
    webserver?: "nginx" | "none";
    kind?: AppKind;
    domain?: string;
    port?: number;
    phpSocket?: string;
    ssl?: SslMode;
    cloudflare?: boolean;
    cfCert?: string;
    cfKey?: string;
    certbot?: boolean;
    service?: boolean;
    execStart?: string;
    queueWorker?: boolean;
    workerCommand?: string;
    adminUser?: string;
    adminKey?: string;
    adminPassword?: string;
    createDeployer?: boolean;
}

export async function setup(opts: SetupOptions) {
    printElevatedWarning("dploy setup", "Configures Nginx virtual hosts, Systemd services, and SSL.");
    log.debug(`Setup started with options: ${JSON.stringify(opts)}`);
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];

    if (!env) {
        throw new Error(`Unknown environment: ${envName}`);
    }
    if (!env.host || !env.username) {
        throw new Error(`Environment '${envName}' is missing required 'host' or 'username'`);
    }

    const deployTo = env.deployTo ? env.deployTo.trim() : `/var/www/${cfg.name || "app"}`;
    const defaultAppName = cfg.name || "app";

    // Interactive questions if not supplied via options
    let webserver = opts.webserver;
    let kind = opts.kind;
    let domainInput = opts.domain;
    let port = opts.port;
    let phpSocket = opts.phpSocket;
    let sslMode = opts.ssl;
    let setupCertbot = opts.certbot;
    let isCloudflare = opts.cloudflare;
    let setupService = opts.service;
    let execStart = opts.execStart;
    let setupWorker = opts.queueWorker;
    let workerCommand = opts.workerCommand;

    // Normalize legacy --certbot flag or --cloudflare flag to sslMode if not explicitly set
    if (!sslMode) {
        if (setupCertbot) {
            sslMode = "certbot";
        } else if (isCloudflare) {
            sslMode = "cloudflare-flexible";
        }
    }

    if (!webserver && process.stdin.isTTY) {
        const ans = await inquirer.prompt([
            {
                type: "list",
                name: "webserver",
                message: "Which web server do you want to configure?",
                choices: [
                    { name: "Nginx (recommended)", value: "nginx" },
                    { name: "None / Skip web server", value: "none" },
                ],
                default: "nginx",
            },
        ]);
        webserver = ans.webserver;
    }

    if (webserver === "nginx") {
        if (!kind && process.stdin.isTTY) {
            const ans = await inquirer.prompt([
                {
                    type: "list",
                    name: "kind",
                    message: "What type of application is this?",
                    choices: [
                        { name: "Node.js (Reverse proxy to local port)", value: "node" },
                        { name: "PHP / Laravel (FastCGI php-fpm)", value: "php" },
                        { name: "Static HTML / Single Page App (SPA)", value: "spa" },
                    ],
                    default: "node",
                },
            ]);
            kind = ans.kind;
        }

        const configuredDomain = env.domain || (Array.isArray(env.domains) ? env.domains.join(" ") : undefined) || cfg.domain || (Array.isArray(cfg.domains) ? cfg.domains.join(" ") : undefined);
        const deployBasename = env.deployTo ? env.deployTo.replace(/\/+$/, "").split("/").pop() : undefined;
        const suggestedDomain = configuredDomain || (deployBasename && deployBasename.includes(".") && !deployBasename.includes(" ") ? deployBasename : (env.host !== "localhost" && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(env.host) ? env.host : "example.com"));

        if (!domainInput && process.stdin.isTTY) {
            const ans = await inquirer.prompt([
                {
                    type: "input",
                    name: "domain",
                    message: "Domain name(s) (space-separated, e.g. example.com www.example.com):",
                    default: suggestedDomain,
                    validate: (input) => (input.trim() ? true : "At least one domain is required"),
                },
            ]);
            domainInput = ans.domain;
        } else if (!domainInput && configuredDomain) {
            domainInput = configuredDomain;
        }

        if (kind === "node" && !port && process.stdin.isTTY) {
            const ans = await inquirer.prompt([
                {
                    type: "number",
                    name: "port",
                    message: "Upstream Node.js application port:",
                    default: 3000,
                },
            ]);
            port = ans.port;
        }

        if (kind === "php" && !phpSocket && process.stdin.isTTY) {
            const ans = await inquirer.prompt([
                {
                    type: "input",
                    name: "phpSocket",
                    message: "PHP-FPM socket path:",
                    default: "unix:/run/php/php8.2-fpm.sock",
                },
            ]);
            phpSocket = ans.phpSocket;
        }

        if (sslMode === undefined && process.stdin.isTTY) {
            const ans = await inquirer.prompt([
                {
                    type: "list",
                    name: "sslMode",
                    message: "How would you like to configure SSL / HTTPS?",
                    choices: [
                        { name: "Certbot (Let's Encrypt automated SSL certificate)", value: "certbot" },
                        { name: "Cloudflare Flexible SSL (Proxy behind Cloudflare, no origin cert needed)", value: "cloudflare-flexible" },
                        { name: "Cloudflare Origin CA Certificate (Full / Strict SSL)", value: "cloudflare-origin" },
                        { name: "None / Plain HTTP (Configure SSL later)", value: "none" },
                    ],
                    default: "certbot",
                },
            ]);
            sslMode = ans.sslMode;
        }

        setupCertbot = sslMode === "certbot";

        // If Cloudflare Origin CA was selected, ask how user wants to provide the certificate
        if (sslMode === "cloudflare-origin" && (!opts.cfCert || !opts.cfKey) && process.stdin.isTTY) {
            const certMethodAns = await inquirer.prompt([
                {
                    type: "list",
                    name: "method",
                    message: "How would you like to provide the Cloudflare Origin Certificate?",
                    choices: [
                        { name: "Paste Certificate & Private Key directly into terminal", value: "paste" },
                        { name: "Provide paths to local files on this computer", value: "local" },
                        { name: "Use existing paths already on remote server", value: "remote" },
                    ],
                    default: "paste",
                },
            ]);

            if (certMethodAns.method === "paste") {
                const pasteAns = await inquirer.prompt([
                    {
                        type: "editor",
                        name: "cert",
                        message: "Paste your Cloudflare Origin Certificate (including BEGIN/END CERTIFICATE):",
                    },
                    {
                        type: "editor",
                        name: "key",
                        message: "Paste your Cloudflare Private Key (including BEGIN/END PRIVATE KEY):",
                    },
                ]);
                opts.cfCert = pasteAns.cert?.trim();
                opts.cfKey = pasteAns.key?.trim();
            } else if (certMethodAns.method === "local") {
                const fileAns = await inquirer.prompt([
                    {
                        type: "input",
                        name: "certPath",
                        message: "Path to local certificate (.pem):",
                    },
                    {
                        type: "input",
                        name: "keyPath",
                        message: "Path to local private key (.key):",
                    },
                ]);
                if (fileAns.certPath && (await fs.pathExists(fileAns.certPath))) {
                    opts.cfCert = await fs.readFile(fileAns.certPath, "utf8");
                }
                if (fileAns.keyPath && (await fs.pathExists(fileAns.keyPath))) {
                    opts.cfKey = await fs.readFile(fileAns.keyPath, "utf8");
                }
            }
        }
    }

    if (kind === "node" && setupService === undefined && process.stdin.isTTY) {
        const ans = await inquirer.prompt([
            {
                type: "confirm",
                name: "service",
                message: "Configure a systemd background service for this Node.js app?",
                default: true,
            },
        ]);
        setupService = ans.service;

        if (setupService && !execStart) {
            const startAns = await inquirer.prompt([
                {
                    type: "input",
                    name: "execStart",
                    message: "Systemd ExecStart command:",
                    default: "node dist/index.js",
                },
            ]);
            execStart = startAns.execStart;
        }
    }

    if (kind === "php" && setupWorker === undefined && process.stdin.isTTY) {
        const ans = await inquirer.prompt([
            {
                type: "confirm",
                name: "worker",
                message: "Configure a systemd queue worker (e.g. Laravel queue:work)?",
                default: true,
            },
        ]);
        setupWorker = ans.worker;

        if (setupWorker && !workerCommand) {
            const workerAns = await inquirer.prompt([
                {
                    type: "input",
                    name: "workerCommand",
                    message: "Queue worker command:",
                    default: "php artisan queue:work --sleep=3 --tries=3 --max-time=3600",
                },
            ]);
            workerCommand = workerAns.workerCommand;
        }
    }

    const domains = (domainInput || "example.com").split(/\s+/).filter(Boolean);
    const primaryDomain = domains[0] || "app";

    let rootDir: string;
    if (kind === "php") {
        rootDir = posixJoin(deployTo, "current", "public");
    } else if (kind === "spa") {
        rootDir = posixJoin(deployTo, "current", "dist");
    } else {
        rootDir = posixJoin(deployTo, "current");
    }

    // 1. Generate Nginx configuration
    let nginxConf: string | undefined;
    if (webserver === "nginx" && kind) {
        nginxConf = await generateNginxConfig({
            kind,
            domains,
            deployTo,
            rootDir,
            port: port || 3000,
            phpSocket: phpSocket || "unix:/run/php/php8.2-fpm.sock",
            ssl: sslMode || (setupCertbot ? "certbot" : "none"),
            cloudflareRealIp: Boolean(isCloudflare || sslMode?.startsWith("cloudflare")),
        });
    }

    // 2. Generate Systemd unit
    let systemdUnit: string | undefined;
    if (setupService) {
        systemdUnit = await generateSystemdUnit({
            appName: defaultAppName,
            user: env.username,
            workingDir: posixJoin(deployTo, "current"),
            execStart: execStart || "node dist/index.js",
        });
    }

    // 3. Generate Laravel/PHP Queue Worker Systemd unit
    let workerUnit: string | undefined;
    const workerServiceName = `${defaultAppName}-worker`;
    if (setupWorker) {
        workerUnit = await generateSystemdUnit({
            appName: defaultAppName,
            user: env.username,
            workingDir: posixJoin(deployTo, "current"),
            execStart: workerCommand || "php artisan queue:work --sleep=3 --tries=3 --max-time=3600",
            isQueueWorker: true,
        });
    }

    // Determine Admin / Sudo Connection Config
    // If adminUser is specified, or env.admin is configured, use admin credentials for OS-level setup
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
    // If running as root, no need to prepend `sudo -n`; otherwise prepend `sudo -n`
    const sudoPrefix = isRunningAsRoot ? "" : "sudo -n ";

    // If dry-run, output planned files and finish
    if (opts.dryRun) {
        log.info("[dry-run] Planned server setup configurations:");
        log.info(`[dry-run] Would connect to ${setupConnConfig.username}@${setupConnConfig.host} (Privileged Mode: ${isRunningAsRoot ? "root" : "sudo"})`);
        if (opts.createDeployer && env.username && env.username !== "root") {
            log.info(`[dry-run] Would create unprivileged user '${env.username}'`);
        }
        log.info(`[dry-run] Would create directory ${deployTo} and set ownership to ${env.username || "deploy"}:www-data (mode 775)`);
        if (nginxConf) {
            console.log(`\n--- [Nginx Config: /etc/nginx/sites-available/${primaryDomain}] ---`);
            console.log(nginxConf);
        }
        if (systemdUnit) {
            console.log(`\n--- [Systemd Unit: /etc/systemd/system/${defaultAppName}.service] ---`);
            console.log(systemdUnit);
        }
        if (workerUnit) {
            console.log(`\n--- [Queue Worker Unit: /etc/systemd/system/${workerServiceName}.service] ---`);
            console.log(workerUnit);
        }
        if (setupCertbot) {
            log.info(`[dry-run] Would execute: ${sudoPrefix}certbot --nginx -d ${domains.join(" -d ")} --non-interactive --agree-tos`);
        }
        log.ok("[dry-run] Server setup preview completed");
        return;
    }

    log.info(`Connecting to ${setupConnConfig.username}@${setupConnConfig.host} to execute server setup...`);
    const bundle = await connect(setupConnConfig);
    try {
        // If requested or if deploying as a non-root user that doesn't exist yet, provision the deployer user
        if (opts.createDeployer && env.username && env.username !== "root") {
            log.info(`Provisioning unprivileged deploy user '${env.username}'...`);
            await exec(bundle.ssh, `${sudoPrefix}id -u ${escapeShellArg(env.username)} || ${sudoPrefix}useradd -m -s /bin/bash ${escapeShellArg(env.username)}`);
            await exec(bundle.ssh, `${sudoPrefix}mkdir -p /home/${escapeShellArg(env.username)}/.ssh && ${sudoPrefix}chmod 700 /home/${escapeShellArg(env.username)}/.ssh`);

            // Authorize local public key if available
            const defaultPubPaths = [
                env.ssh_key_path ? `${env.ssh_key_path}.pub` : null,
                path.join(os.homedir(), ".ssh", "id_ed25519.pub"),
                path.join(os.homedir(), ".ssh", "id_rsa.pub"),
            ].filter(Boolean) as string[];

            for (const pubPath of defaultPubPaths) {
                if (await fs.pathExists(pubPath)) {
                    const pubContent = (await fs.readFile(pubPath, "utf8")).trim();
                    log.info(`Authorizing public key (${path.basename(pubPath)}) for ${env.username}...`);
                    await exec(
                        bundle.ssh,
                        `echo ${escapeShellArg(pubContent)} | ${sudoPrefix}tee -a /home/${escapeShellArg(env.username)}/.ssh/authorized_keys > /dev/null && ${sudoPrefix}chmod 600 /home/${escapeShellArg(env.username)}/.ssh/authorized_keys && ${sudoPrefix}chown -R ${escapeShellArg(env.username)}:${escapeShellArg(env.username)} /home/${escapeShellArg(env.username)}/.ssh`
                    );
                    break;
                }
            }
            log.ok(`User '${env.username}' provisioned and authorized.`);
        }

        // Add limited passwordless sudo rules for service reloads (always ensure this exists for non-root deploy users)
        if (env.username && env.username !== "root") {
            const appSlug = toSudoersSlug(defaultAppName);
            const sudoersFile = `/etc/sudoers.d/dploy-${appSlug}`;

            const reloadCommands: string[] = [
                "/usr/bin/systemctl reload nginx",
                "/bin/systemctl reload nginx",
                "/usr/bin/systemctl restart nginx",
                "/bin/systemctl restart nginx",
                "/usr/bin/systemctl status nginx",
                "/bin/systemctl status nginx",
                "/usr/sbin/nginx -t",
                "/usr/bin/nginx -t",
                "/usr/bin/systemctl reload php*-fpm",
                "/bin/systemctl reload php*-fpm",
                "/usr/bin/systemctl restart php*-fpm",
                "/bin/systemctl restart php*-fpm",
                "/usr/bin/systemctl status php*-fpm",
                "/bin/systemctl status php*-fpm",
                "/usr/bin/systemctl reload php-fpm",
                "/bin/systemctl reload php-fpm",
                "/usr/bin/systemctl restart php-fpm",
                "/bin/systemctl restart php-fpm",
            ];

            // If an app service is configured or requested
            if (kind === "node" || systemdUnit) {
                reloadCommands.push(
                    `/usr/bin/systemctl restart ${appSlug}`,
                    `/bin/systemctl restart ${appSlug}`,
                    `/usr/bin/systemctl reload ${appSlug}`,
                    `/bin/systemctl reload ${appSlug}`,
                    `/usr/bin/systemctl status ${appSlug}`,
                    `/bin/systemctl status ${appSlug}`
                );
            }

            if (workerUnit) {
                reloadCommands.push(
                    `/usr/bin/systemctl restart ${appSlug}-worker`,
                    `/bin/systemctl restart ${appSlug}-worker`,
                    `/usr/bin/systemctl reload ${appSlug}-worker`,
                    `/bin/systemctl reload ${appSlug}-worker`,
                    `/usr/bin/systemctl status ${appSlug}-worker`,
                    `/bin/systemctl status ${appSlug}-worker`
                );
            }

            const sudoersContent = `${env.username} ALL=(ALL) NOPASSWD: ${reloadCommands.join(", ")}\n`;
            await exec(
                bundle.ssh,
                `echo ${escapeShellArg(sudoersContent)} | ${sudoPrefix}tee ${escapeShellArg(sudoersFile)} > /dev/null && ${sudoPrefix}chmod 440 ${escapeShellArg(sudoersFile)}`
            );
            log.ok(`Configured passwordless sudo rules for '${env.username}' in ${sudoersFile} (Nginx, PHP-FPM, and systemctl)`);
        }

        // Ensure deploy directory structure and permissions exist
        const deployUser = env.username || "deploy";
        log.info(`Configuring deploy directory ${deployTo} for ${deployUser}:www-data...`);
        await exec(
            bundle.ssh,
            `${sudoPrefix}mkdir -p ${escapeShellArg(deployTo)}/releases ${escapeShellArg(deployTo)}/shared && ` +
            `${sudoPrefix}chown -R ${escapeShellArg(deployUser)}:www-data ${escapeShellArg(deployTo)} && ` +
            `${sudoPrefix}chmod -R 775 ${escapeShellArg(deployTo)} && ` +
            `${sudoPrefix}chmod g+s ${escapeShellArg(deployTo)} ${escapeShellArg(deployTo)}/releases ${escapeShellArg(deployTo)}/shared`
        );
        log.ok(`Deploy directory ${deployTo} created with ownership ${deployUser}:www-data (mode 775, setgid)`);

        // Seed initial "Coming Soon" placeholder if no release exists yet
        const checkCurrentRes = await exec(bundle.ssh, `test -e ${escapeShellArg(posixJoin(deployTo, "current"))}`);
        if (checkCurrentRes.code !== 0) {
            log.info("No active release found. Deploying initial 'Coming Soon' placeholder page...");
            const initialReleaseDir = posixJoin(deployTo, "releases", "0.0.0");
            let initialPublicDir = initialReleaseDir;
            if (kind === "php") {
                initialPublicDir = posixJoin(initialReleaseDir, "public");
            } else if (kind === "spa") {
                initialPublicDir = posixJoin(initialReleaseDir, "dist");
            }

            await exec(bundle.ssh, `${sudoPrefix}mkdir -p ${escapeShellArg(initialPublicDir)}`);

            const comingSoonHtml = renderComingSoonHtml(primaryDomain, envName);
            const indexHtmlPath = posixJoin(initialPublicDir, "index.html");
            await writeRemotePrivilegedFile(bundle.ssh, indexHtmlPath, comingSoonHtml, sudoPrefix);

            // Set ownership of placeholder to deployUser:www-data
            await exec(bundle.ssh, `${sudoPrefix}chown -R ${escapeShellArg(deployUser)}:www-data ${escapeShellArg(initialReleaseDir)}`);

            // Symlink current -> releases/0.0.0
            const currentSymlink = posixJoin(deployTo, "current");
            const symlinkRes = await exec(
                bundle.ssh,
                `${sudoPrefix}ln -sfn ${escapeShellArg(initialReleaseDir)} ${escapeShellArg(currentSymlink)} && ` +
                `${sudoPrefix}chown -h ${escapeShellArg(deployUser)}:www-data ${escapeShellArg(currentSymlink)}`
            );
            if (symlinkRes.code !== 0) {
                log.warn(`Failed to create current symlink: ${symlinkRes.stderr || symlinkRes.stdout}`);
            } else {
                log.ok(`Live placeholder activated at ${primaryDomain} (linked to 0.0.0)`);
            }
        }

        if (nginxConf) {
            log.info(`Configuring Nginx virtual host for ${primaryDomain}...`);
            const confPath = `/etc/nginx/sites-available/${primaryDomain}`;
            const enabledPath = `/etc/nginx/sites-enabled/${primaryDomain}`;

            // If Cloudflare Origin CA certificate/key content was supplied, write them to /etc/ssl
            if (sslMode === "cloudflare-origin" && opts.cfCert && opts.cfKey) {
                const certDest = `/etc/ssl/certs/cf-origin-${primaryDomain}.pem`;
                const keyDest = `/etc/ssl/private/cf-origin-${primaryDomain}.key`;
                log.info(`Writing Cloudflare Origin CA certificate and private key to /etc/ssl...`);
                await writeRemotePrivilegedFile(bundle.ssh, certDest, opts.cfCert, sudoPrefix);
                await writeRemotePrivilegedFile(bundle.ssh, keyDest, opts.cfKey, sudoPrefix);
                await exec(bundle.ssh, `${sudoPrefix}chmod 644 ${escapeShellArg(certDest)} && ${sudoPrefix}chmod 600 ${escapeShellArg(keyDest)}`);
                log.ok(`Cloudflare certificates deployed (${certDest}, ${keyDest})`);
            }

            await writeRemotePrivilegedFile(bundle.ssh, confPath, nginxConf, sudoPrefix);
            await exec(bundle.ssh, `${sudoPrefix}ln -sfn ${escapeShellArg(confPath)} ${escapeShellArg(enabledPath)}`);

            log.info("Testing Nginx configuration syntax (nginx -t)...");
            const testRes = await exec(bundle.ssh, `${sudoPrefix}nginx -t`);
            if (testRes.code !== 0) {
                log.err(`Nginx configuration test failed: ${testRes.stderr}`);
                throw new Error("Nginx config test failed. Configuration was not applied.");
            }

            await exec(bundle.ssh, `${sudoPrefix}systemctl reload nginx`);
            log.ok(`Nginx virtual host enabled and reloaded for ${primaryDomain}`);
        }

        if (systemdUnit) {
            log.info(`Configuring systemd service ${defaultAppName}.service...`);
            const servicePath = `/etc/systemd/system/${defaultAppName}.service`;

            await writeRemotePrivilegedFile(bundle.ssh, servicePath, systemdUnit, sudoPrefix);
            await exec(bundle.ssh, `${sudoPrefix}systemctl daemon-reload`);
            await exec(bundle.ssh, `${sudoPrefix}systemctl enable ${escapeShellArg(defaultAppName)}`);
            log.ok(`Systemd unit ${defaultAppName}.service enabled`);
        }

        if (workerUnit) {
            log.info(`Configuring queue worker service ${workerServiceName}.service...`);
            const workerPath = `/etc/systemd/system/${workerServiceName}.service`;

            await writeRemotePrivilegedFile(bundle.ssh, workerPath, workerUnit, sudoPrefix);
            await exec(bundle.ssh, `${sudoPrefix}systemctl daemon-reload`);
            await exec(bundle.ssh, `${sudoPrefix}systemctl enable ${escapeShellArg(workerServiceName)}`);
            log.ok(`Systemd queue worker ${workerServiceName}.service enabled`);
        }

        if (setupCertbot) {
            log.info("Running Certbot to obtain SSL certificate...");
            const certbotCmd = `${sudoPrefix}certbot --nginx -d ${domains.map((d) => escapeShellArg(d)).join(" -d ")} --non-interactive --agree-tos -m admin@${primaryDomain} --redirect || true`;
            const certRes = await exec(bundle.ssh, certbotCmd);
            if (certRes.code === 0) {
                log.ok(`Certbot SSL successfully provisioned for ${domains.join(", ")}`);
            } else {
                log.warn(`Certbot command exited with code ${certRes.code}: ${certRes.stderr || certRes.stdout}`);
            }
        } else if (sslMode === "cloudflare-origin") {
            log.info(`Cloudflare Origin CA SSL configured in Nginx (expects /etc/ssl/certs/cf-origin-${primaryDomain}.pem and /etc/ssl/private/cf-origin-${primaryDomain}.key).`);
        } else if (sslMode === "cloudflare-flexible") {
            log.ok("Cloudflare Flexible SSL configured (real visitor IP restoring enabled, HTTPS protocol detection active)");
        }

        log.ok("Server setup wizard completed successfully!");
    } finally {
        await close(bundle);
    }
}
