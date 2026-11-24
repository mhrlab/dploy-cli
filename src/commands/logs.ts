import { loadConfig, getEnvName, EnvironmentConfig } from "../core/config.js";
import { connect, close } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin, escapeShellArg, expandTilde } from "../core/utils.js";

export async function logs(opts: {
    env?: string;
    follow?: boolean;
    lines?: string | number;
    file?: string;
    type?: "app" | "nginx" | "pm2" | "systemd" | string;
    sudo?: boolean;
    asAdmin?: boolean;
    asSudo?: boolean;
    adminUser?: string;
    adminKey?: string;
    adminPassword?: string;
}) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];

    if (!env || !env.deployTo) {
        throw new Error(`Environment '${envName}' is missing or lacks deployTo path`);
    }

    // Resolve privileged/admin connection when requested
    const isExplicitAdmin = Boolean(opts.asAdmin || opts.asSudo);
    const adminUser = opts.adminUser || process.env.DPLOY_ADMIN_USER || (isExplicitAdmin || opts.sudo ? env.admin?.username : undefined);

    if (isExplicitAdmin && !adminUser) {
        throw new Error(`Admin credentials not found in 'admin' block of deploy.config.yml for environment '${envName}'. Please configure 'admin:' or pass --admin-user.`);
    }

    const adminKey = opts.adminKey || process.env.DPLOY_ADMIN_KEY || env.admin?.ssh_key_path;
    const adminPassword = opts.adminPassword || process.env.DPLOY_ADMIN_PASSWORD || env.admin?.password;

    let connConfig: EnvironmentConfig = env;
    let sudoPrefix = "";

    if (adminUser) {
        connConfig = {
            ...env,
            username: adminUser,
            ssh_key_path: adminKey ? expandTilde(adminKey) : (adminUser === env.username ? env.ssh_key_path : (env.admin?.ssh_key_path ? expandTilde(env.admin.ssh_key_path) : env.ssh_key_path)),
            password: adminPassword || (adminUser === env.username ? env.password : env.admin?.password),
            passphrase: env.admin?.passphrase || env.passphrase,
        };
        sudoPrefix = adminUser === "root" ? "" : "sudo -n ";
    } else if (opts.sudo) {
        sudoPrefix = "sudo -n ";
    }

    const lineCount = Number(opts.lines) || 50;
    const isFollow = opts.follow ?? false;

    let targetCmd: string;

    // Support configurable log path in deploy.config.yml:
    // e.g. env.logs or env.logPath or env.logsPath
    const configuredLogPath = (env as any).logsPath || (env as any).logPath || (env as any).logs?.app;

    if (opts.file) {
        targetCmd = `${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}${escapeShellArg(opts.file)}`;
    } else if (opts.type === "nginx") {
        targetCmd = `${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}/var/log/nginx/error.log /var/log/nginx/access.log 2>/dev/null || ${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}/var/log/nginx/error.log`;
    } else if (opts.type === "pm2") {
        const appName = cfg.name || "all";
        targetCmd = `${sudoPrefix}pm2 logs ${appName} --lines ${lineCount} ${isFollow ? "" : "--nostream"}`;
    } else if (opts.type === "systemd") {
        const serviceName = cfg.name ? `${cfg.name}.service` : "";
        targetCmd = `${sudoPrefix}journalctl -n ${lineCount} ${isFollow ? "-f " : ""}${serviceName ? `-u ${serviceName}` : ""}`;
    } else if (configuredLogPath) {
        const fullConfiguredPath = configuredLogPath.startsWith("/")
            ? configuredLogPath
            : posixJoin(env.deployTo.trim(), "current", configuredLogPath);
        targetCmd = `${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}${escapeShellArg(fullConfiguredPath)}`;
    } else {
        // Default: tail application log in configured custom paths, shared/logs, or framework standard dirs (storage/logs, writable/logs)
        const appLogDir = posixJoin(env.deployTo.trim(), "logs");
        const sharedLogDir = posixJoin(env.deployTo.trim(), "shared", "logs");
        const laravelLogDir = posixJoin(env.deployTo.trim(), "current", "storage", "logs");
        const ci4LogDir = posixJoin(env.deployTo.trim(), "current", "writable", "logs");

        targetCmd = `${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}` +
            `${escapeShellArg(sharedLogDir)}/*.log ${escapeShellArg(appLogDir)}/*.log ` +
            `${escapeShellArg(laravelLogDir)}/*.log ${escapeShellArg(ci4LogDir)}/*.log 2>/dev/null ` +
            `|| echo "No application logs found in ${sharedLogDir}, ${appLogDir}, ${laravelLogDir}, or ${ci4LogDir}"`;
    }

    log.info(`Streaming logs from ${connConfig.username}@${connConfig.host}:`);
    log.debug(`Executing: ${targetCmd}`);

    const bundle = await connect(connConfig);

    return new Promise<void>((resolve, reject) => {
        bundle.ssh.exec(targetCmd, (err, stream) => {
            if (err) {
                close(bundle);
                return reject(err);
            }

            stream.on("data", (data: Buffer) => {
                process.stdout.write(data);
            });

            stream.stderr.on("data", (data: Buffer) => {
                process.stderr.write(data);
            });

            const cleanup = async () => {
                try {
                    stream.end();
                    await close(bundle);
                } catch {}
                resolve();
            };

            process.on("SIGINT", cleanup);

            stream.on("close", async () => {
                process.off("SIGINT", cleanup);
                await close(bundle);
                resolve();
            });

            stream.on("error", async (streamErr: Error) => {
                process.off("SIGINT", cleanup);
                await close(bundle);
                reject(streamErr);
            });
        });
    });
}
