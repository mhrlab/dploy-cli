import inquirer from "inquirer";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { loadConfig, getEnvName, EnvironmentConfig } from "../core/config.js";
import { connect, close, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin, escapeShellArg, expandTilde } from "../core/utils.js";
import {
    generateNginxConfig,
    generateSystemdUnit,
    AppKind,
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

export interface SetupOptions {
    env?: string;
    dryRun?: boolean;
    webserver?: "nginx" | "none";
    kind?: AppKind;
    domain?: string;
    port?: number;
    phpSocket?: string;
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
    let setupCertbot = opts.certbot;
    let setupService = opts.service;
    let execStart = opts.execStart;
    let setupWorker = opts.queueWorker;
    let workerCommand = opts.workerCommand;

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

        if (!domainInput && process.stdin.isTTY) {
            const ans = await inquirer.prompt([
                {
                    type: "input",
                    name: "domain",
                    message: "Domain name(s) (space-separated, e.g. example.com www.example.com):",
                    default: env.host !== "localhost" ? env.host : "example.com",
                    validate: (input) => (input.trim() ? true : "At least one domain is required"),
                },
            ]);
            domainInput = ans.domain;
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

        if (setupCertbot === undefined && process.stdin.isTTY) {
            const ans = await inquirer.prompt([
                {
                    type: "confirm",
                    name: "certbot",
                    message: "Would you like to obtain a free SSL certificate via Certbot (Let's Encrypt)?",
                    default: false,
                },
            ]);
            setupCertbot = ans.certbot;
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
            rootDir,
            port: port || 3000,
            phpSocket: phpSocket || "unix:/run/php/php8.2-fpm.sock",
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

            // Add limited passwordless sudo rules for service reloads
            const sudoersFile = `/etc/sudoers.d/dploy-${defaultAppName}`;
            const sudoersContent = `${env.username} ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload nginx, /usr/bin/systemctl restart ${defaultAppName}, /usr/bin/systemctl restart ${workerServiceName}, /usr/bin/systemctl status ${defaultAppName}\n`;
            await exec(
                bundle.ssh,
                `echo ${escapeShellArg(sudoersContent)} | ${sudoPrefix}tee ${escapeShellArg(sudoersFile)} > /dev/null && ${sudoPrefix}chmod 440 ${escapeShellArg(sudoersFile)}`
            );
            log.ok(`User '${env.username}' provisioned and authorized with limited sudo rules`);
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

        if (nginxConf) {
            log.info(`Configuring Nginx virtual host for ${primaryDomain}...`);
            const confPath = `/etc/nginx/sites-available/${primaryDomain}`;
            const enabledPath = `/etc/nginx/sites-enabled/${primaryDomain}`;

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
        }

        log.ok("Server setup wizard completed successfully!");
    } finally {
        await close(bundle);
    }
}
