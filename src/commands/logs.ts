import inquirer from "inquirer";
import { loadConfig, getEnvName, EnvironmentConfig } from "../core/config.js";
import { connect, close, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin, escapeShellArg, expandTilde, getReadableFileSize } from "../core/utils.js";

export interface RemoteLogFile {
    path: string;
    name: string;
    size: string;
    date: string;
}

/**
 * Parses a single line from remote `ls -lt` or `ls -l` into a RemoteLogFile structure.
 */
export function parseLsLtLine(line: string): RemoteLogFile | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("total ") || trimmed.includes("cannot access") || trimmed.includes("No such file")) {
        return null;
    }

    const match = trimmed.match(/^[-a-zA-Z0-9+]+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Za-z0-9:_-]+\s+[A-Za-z0-9:_-]+(?:\s+[A-Za-z0-9:_-]+)?)\s+(.+)$/);
    if (!match) {
        const slashIdx = trimmed.indexOf(" /");
        if (slashIdx !== -1) {
            const filePath = trimmed.slice(slashIdx + 1).trim();
            const fileName = filePath.split("/").pop() || filePath;
            return { path: filePath, name: fileName, size: "", date: "" };
        }
        return null;
    }

    const bytes = parseInt(match[1], 10);
    const size = isNaN(bytes) ? match[1] : getReadableFileSize(bytes);
    const date = match[2];
    const filePath = match[3].trim();
    const fileName = filePath.split("/").pop() || filePath;
    return { path: filePath, name: fileName, size, date };
}

export async function logs(opts: {
    env?: string;
    follow?: boolean;
    lines?: string | number;
    file?: string;
    type?: "app" | "nginx" | "pm2" | "systemd" | string;
    latest?: boolean;
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

    // Connect to server early so we can scan directories if needed
    log.info(`Connecting to ${connConfig.username}@${connConfig.host} to inspect logs...`);
    const bundle = await connect(connConfig);

    let targetCmd: string;

    // Support configurable log path in deploy.config.yml:
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
    } else {
        // App logs: scan candidate directories for daily or rotating log files
        const candidateDirs = [
            configuredLogPath
                ? (configuredLogPath.startsWith("/") ? configuredLogPath : posixJoin(env.deployTo.trim(), "current", configuredLogPath))
                : null,
            posixJoin(env.deployTo.trim(), "current", "writable", "logs"), // CodeIgniter 4
            posixJoin(env.deployTo.trim(), "current", "storage", "logs"),  // Laravel
            posixJoin(env.deployTo.trim(), "shared", "logs"),             // Shared logs
            posixJoin(env.deployTo.trim(), "logs"),                       // Standard logs
        ].filter(Boolean) as string[];

        const scanScript = candidateDirs.map((dir) =>
            `if [ -d ${escapeShellArg(dir)} ]; then ls -lt ${escapeShellArg(dir)}/*.log ${escapeShellArg(dir)}/log-*.php ${escapeShellArg(dir)}/*.txt 2>/dev/null; fi`
        ).join("; ");

        const scanRes = await exec(bundle.ssh, `${sudoPrefix}bash -c ${escapeShellArg(scanScript)} 2>/dev/null || true`);
        const foundFiles: RemoteLogFile[] = [];
        for (const line of scanRes.stdout.split(/\r?\n/)) {
            const parsed = parseLsLtLine(line);
            if (parsed && !foundFiles.some((f) => f.path === parsed.path)) {
                foundFiles.push(parsed);
            }
        }

        if (foundFiles.length === 0) {
            // Fallback: tail wildcard
            targetCmd = `${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}` +
                `${candidateDirs.map((d) => `${escapeShellArg(d)}/*.log`).join(" ")} 2>/dev/null ` +
                `|| echo "No application log files found in ${candidateDirs.join(", ")}"`;
        } else if (foundFiles.length === 1 || opts.latest || !process.stdin.isTTY) {
            const selected = foundFiles[0];
            log.info(`Tailing latest log file: ${selected.name}${selected.size ? ` (${selected.size})` : ""}`);
            targetCmd = `${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}${escapeShellArg(selected.path)}`;
        } else {
            // Interactive log file picker
            const choices = foundFiles.slice(0, 15).map((f, i) => ({
                name: `${f.name.padEnd(28)} ${f.size ? `(${f.size}, ${f.date})` : ""}${i === 0 ? " [Latest]" : ""}`,
                value: f.path,
            }));
            choices.push({
                name: "All recent logs combined",
                value: "__ALL__",
            });

            const ans = await inquirer.prompt([
                {
                    type: "list",
                    name: "selectedLog",
                    message: `Found ${foundFiles.length} log file(s). Select which to view:`,
                    choices,
                    default: foundFiles[0].path,
                },
            ]);

            if (ans.selectedLog === "__ALL__") {
                targetCmd = `${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}${foundFiles.slice(0, 5).map((f) => escapeShellArg(f.path)).join(" ")}`;
            } else {
                const picked = foundFiles.find((f) => f.path === ans.selectedLog);
                log.info(`Tailing selected log: ${picked?.name || ans.selectedLog}`);
                targetCmd = `${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}${escapeShellArg(ans.selectedLog)}`;
            }
        }
    }

    log.debug(`Executing: ${targetCmd}`);

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
