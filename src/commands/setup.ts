import inquirer from "inquirer";
import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin, escapeShellArg } from "../core/utils.js";
import {
    generateNginxConfig,
    generateSystemdUnit,
    AppKind,
    NginxConfigParams,
    SystemdConfigParams,
} from "../features/server-wizard.js";

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

    // If dry-run, output planned files and finish
    if (opts.dryRun) {
        log.info("[dry-run] Planned server setup configurations:");
        if (nginxConf) {
            console.log(`\n--- [Nginx Config: /etc/nginx/sites-available/${primaryDomain}] ---`);
            console.log(nginxConf);
        }
        if (systemdUnit) {
            console.log(`\n--- [Systemd Unit: /etc/systemd/system/${defaultAppName}.service] ---`);
            console.log(systemdUnit);
        }
        if (setupCertbot) {
            log.info(`[dry-run] Would execute: sudo certbot --nginx -d ${domains.join(" -d ")} --non-interactive --agree-tos`);
        }
        log.ok("[dry-run] Server setup preview completed");
        return;
    }

    log.info(`Connecting to ${env.username}@${env.host} to execute server setup...`);
    const bundle = await connect(env);
    try {
        if (nginxConf) {
            log.info(`Configuring Nginx virtual host for ${primaryDomain}...`);
            const confPath = `/etc/nginx/sites-available/${primaryDomain}`;
            const enabledPath = `/etc/nginx/sites-enabled/${primaryDomain}`;

            // Upload via tmp file and sudo move
            const tmpConf = `/tmp/nginx-${primaryDomain}.conf`;
            await bundle.sftp.put(Buffer.from(nginxConf, "utf8"), tmpConf);

            await exec(bundle.ssh, `sudo -n mv -f ${escapeShellArg(tmpConf)} ${escapeShellArg(confPath)}`);
            await exec(bundle.ssh, `sudo -n ln -sfn ${escapeShellArg(confPath)} ${escapeShellArg(enabledPath)}`);

            log.info("Testing Nginx configuration syntax (nginx -t)...");
            const testRes = await exec(bundle.ssh, "sudo -n nginx -t");
            if (testRes.code !== 0) {
                log.err(`Nginx configuration test failed: ${testRes.stderr}`);
                throw new Error("Nginx config test failed. Configuration was not applied.");
            }

            await exec(bundle.ssh, "sudo -n systemctl reload nginx");
            log.ok(`Nginx virtual host enabled and reloaded for ${primaryDomain}`);
        }

        if (systemdUnit) {
            log.info(`Configuring systemd service ${defaultAppName}.service...`);
            const servicePath = `/etc/systemd/system/${defaultAppName}.service`;
            const tmpService = `/tmp/${defaultAppName}.service`;

            await bundle.sftp.put(Buffer.from(systemdUnit, "utf8"), tmpService);
            await exec(bundle.ssh, `sudo -n mv -f ${escapeShellArg(tmpService)} ${escapeShellArg(servicePath)}`);
            await exec(bundle.ssh, "sudo -n systemctl daemon-reload");
            await exec(bundle.ssh, `sudo -n systemctl enable ${escapeShellArg(defaultAppName)}`);
            log.ok(`Systemd unit ${defaultAppName}.service enabled`);
        }

        if (setupCertbot) {
            log.info("Running Certbot to obtain SSL certificate...");
            const certbotCmd = `sudo -n certbot --nginx -d ${domains.map((d) => escapeShellArg(d)).join(" -d ")} --non-interactive --agree-tos -m admin@${primaryDomain} --redirect || true`;
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
