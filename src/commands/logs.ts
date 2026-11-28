import chalk from "chalk";
import { loadConfig, getEnvName, EnvironmentConfig, DeployConfig } from "../core/config.js";
import { connect, close, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin, escapeShellArg, expandTilde, getReadableFileSize } from "../core/utils.js";

/**
 * Colorize `tail` file header titles (`==> path <==`) so error logs stand out in red
 * and access/stdout logs stand out in blue.
 */
export function colorizeLogLine(line: string): string {
    const headerMatch = line.match(/^==> (.+?) <==$/);
    if (headerMatch) {
        const filePath = headerMatch[1].toLowerCase();
        if (/(?:^|[/._-])(error|err|stderr)(?:[/._-]|$)/.test(filePath)) {
            return chalk.bold.red(line);
        }
        if (/(?:^|[/._-])(access|out|stdout)(?:[/._-]|$)/.test(filePath)) {
            return chalk.bold.blue(line);
        }
        return chalk.bold.green(line);
    }
    return line;
}

/**
 * Resolve configured log path for a given log type from environment or top-level config.
 */
export function resolveConfiguredLogPath(
    env: EnvironmentConfig,
    cfg: DeployConfig,
    logType = "app"
): string | undefined {
    const envAny = env as any;
    const cfgAny = cfg as any;
    if (logType === "app") {
        return (
            envAny.logsPath ||
            envAny.logPath ||
            envAny.logs?.app ||
            cfgAny.logsPath ||
            cfgAny.logPath ||
            cfgAny.logs?.app
        );
    }
    return envAny.logs?.[logType] || cfgAny.logs?.[logType];
}

const LOG_ENTRY_START_REGEX =
    /^(?:\[\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}|\d{4}[/-]\d{2}[/-]\d{2}[T\s]\d{2}:\d{2}:\d{2}|(?:EMERGENCY|ALERT|CRITICAL|ERROR|WARNING|NOTICE|INFO|DEBUG)\s+-\s+\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}|\S+\s+\S+\s+\S+\s+\[\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2}|\d+\|[^|]+\|\s)/i;

export function isLogEntryStart(line: string): boolean {
    return LOG_ENTRY_START_REGEX.test(line);
}

/**
 * Split raw log output into logical multi-line log entries and return the last `count` entries
 * (preserving `==> file <==` headers per section when multiple files are tailed).
 */
export function extractLastLogEntries(raw: string, count: number): string[] {
    if (count <= 0 || !raw.trim()) return [];
    const lines = raw.replace(/\r\n/g, "\n").split("\n");

    const sections: Array<{ header?: string; entries: string[][] }> = [];
    let currentSection: { header?: string; entries: string[][] } = { entries: [] };

    for (const line of lines) {
        if (/^==> .+? <==$/.test(line)) {
            if (currentSection.header || currentSection.entries.length) {
                sections.push(currentSection);
            }
            currentSection = { header: line, entries: [] };
            continue;
        }

        if (isLogEntryStart(line) || currentSection.entries.length === 0) {
            if (line === "" && currentSection.entries.length === 0) continue;
            currentSection.entries.push([line]);
        } else {
            currentSection.entries[currentSection.entries.length - 1].push(line);
        }
    }

    if (currentSection.header || currentSection.entries.length) {
        sections.push(currentSection);
    }

    const result: string[] = [];
    for (const sec of sections) {
        const nonEmpty = sec.entries.filter((e) => e.some((l) => l.trim() !== ""));
        const sliced = nonEmpty.slice(-count);
        if (sec.header && sliced.length) {
            result.push(sec.header);
        }
        for (const entry of sliced) {
            result.push(entry.join("\n").replace(/\n+$/, ""));
        }
    }
    return result;
}

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
    entries?: string | number;
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

    const isFollow = opts.follow ?? false;
    const entriesCount = opts.entries !== undefined ? Math.max(1, Number(opts.entries) || 4) : 0;
    const lineCount = entriesCount > 0 && !isFollow ? Math.max(entriesCount * 80, 1000) : Number(opts.lines) || 50;

    // Connect to server early so we can scan directories if needed
    const connSpin = log.spinner(`Connecting to ${connConfig.username}@${connConfig.host} to inspect logs...`);
    let bundle;
    try {
        bundle = await connect(connConfig);
        connSpin.succeed(`Connected to ${connConfig.host}`);
    } catch (err) {
        connSpin.fail(`Failed to connect to ${connConfig.host}`);
        throw err;
    }

    let targetCmd: string;

    const requestedType = opts.type || "app";
    const builtInTypes = new Set(["app", "nginx", "pm2", "systemd"]);
    const customLogTarget = !builtInTypes.has(requestedType)
        ? resolveConfiguredLogPath(env, cfg, requestedType)
        : undefined;

    if (!builtInTypes.has(requestedType) && !customLogTarget && !opts.file) {
        const customKeys = Object.keys({
            ...((cfg as any).logs || {}),
            ...((env as any).logs || {}),
        });
        const available = ["app", "nginx", "pm2", "systemd", ...customKeys].filter(
            (v, i, a) => a.indexOf(v) === i
        );
        await close(bundle);
        throw new Error(
            `Unknown log type '${requestedType}'. Available types: ${available.join(", ")}`
        );
    }

    const configuredLogPath = customLogTarget || resolveConfiguredLogPath(env, cfg, "app");

    if (opts.file) {
        targetCmd = `${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}${escapeShellArg(opts.file)}`;
    } else if (requestedType === "nginx") {
        const domain = env.domain || (env.domains && env.domains[0]) || cfg.domain || (cfg.domains && cfg.domains[0]);
        if (domain) {
            const domainErrorLog = escapeShellArg(`/var/log/nginx/${domain}.error.log`);
            const domainAccessLog = escapeShellArg(`/var/log/nginx/${domain}.access.log`);
            targetCmd = `${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}${domainErrorLog} ${domainAccessLog} 2>/dev/null || ${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}/var/log/nginx/error.log /var/log/nginx/access.log 2>/dev/null || ${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}/var/log/nginx/error.log`;
        } else {
            targetCmd = `${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}/var/log/nginx/error.log /var/log/nginx/access.log 2>/dev/null || ${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}/var/log/nginx/error.log`;
        }
    } else if (requestedType === "pm2") {
        const appName = cfg.name || "all";
        targetCmd = `${sudoPrefix}pm2 logs ${appName} --lines ${lineCount} ${isFollow ? "" : "--nostream"}`;
    } else if (requestedType === "systemd") {
        const serviceName = cfg.name ? `${cfg.name}.service` : "";
        targetCmd = `${sudoPrefix}journalctl -n ${lineCount} ${isFollow ? "-f " : ""}${serviceName ? `-u ${serviceName}` : ""}`;
    } else if (customLogTarget && /\.(log|txt|php)$/i.test(customLogTarget.trim())) {
        const resolvedFile = customLogTarget.startsWith("/")
            ? customLogTarget
            : posixJoin(env.deployTo.trim(), "current", customLogTarget);
        log.info(`Tailing configured '${requestedType}' log file: ${resolvedFile}`);
        targetCmd = `${sudoPrefix}tail -n ${lineCount} ${isFollow ? "-f " : ""}${escapeShellArg(resolvedFile)}`;
    } else {
        // App or custom directory logs: scan candidate directories for daily or rotating log files
        const candidateDirs = customLogTarget
            ? [
                  customLogTarget.startsWith("/")
                      ? customLogTarget
                      : posixJoin(env.deployTo.trim(), "current", customLogTarget),
              ]
            : ([
                  configuredLogPath
                      ? (configuredLogPath.startsWith("/") ? configuredLogPath : posixJoin(env.deployTo.trim(), "current", configuredLogPath))
                      : null,
                  posixJoin(env.deployTo.trim(), "current", "writable", "logs"), // CodeIgniter 4
                  posixJoin(env.deployTo.trim(), "current", "storage", "logs"),  // Laravel
                  posixJoin(env.deployTo.trim(), "shared", "logs"),             // Shared logs
                  posixJoin(env.deployTo.trim(), "logs"),                       // Standard logs
              ].filter(Boolean) as string[]);

        const scanScript = candidateDirs.map((dir) =>
            `if [ -d ${escapeShellArg(dir)} ]; then ls -lt ${escapeShellArg(dir)}/*.log ${escapeShellArg(dir)}/log-*.php ${escapeShellArg(dir)}/*.txt 2>/dev/null; fi`
        ).join("; ");

        const scanSpin = log.spinner("Scanning remote log directories...");
        const scanRes = await exec(bundle.ssh, `${sudoPrefix}bash -c ${escapeShellArg(scanScript)} 2>/dev/null || true`);
        scanSpin.stop();
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

            const { default: inquirer } = await import("inquirer");
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

            let lineBuffer = "";
            let collectedStdout = "";
            stream.on("data", (data: Buffer) => {
                if (entriesCount > 0 && !isFollow) {
                    collectedStdout += data.toString();
                    return;
                }
                lineBuffer += data.toString();
                const lines = lineBuffer.split(/\r?\n/);
                lineBuffer = lines.pop() ?? "";
                for (const line of lines) {
                    process.stdout.write(`${colorizeLogLine(line)}\n`);
                }
            });

            stream.stderr.on("data", (data: Buffer) => {
                process.stderr.write(chalk.red(data.toString()));
            });

            const flushRemaining = () => {
                if (entriesCount > 0 && !isFollow) {
                    if (collectedStdout) {
                        const entries = extractLastLogEntries(collectedStdout, entriesCount);
                        for (const entry of entries) {
                            for (const l of entry.split("\n")) {
                                process.stdout.write(`${colorizeLogLine(l)}\n`);
                            }
                        }
                        collectedStdout = "";
                    }
                    return;
                }
                if (lineBuffer) {
                    process.stdout.write(colorizeLogLine(lineBuffer));
                    lineBuffer = "";
                }
            };

            const cleanup = async () => {
                flushRemaining();
                try {
                    stream.end();
                    await close(bundle);
                } catch {}
                resolve();
            };

            process.on("SIGINT", cleanup);

            stream.on("close", async () => {
                flushRemaining();
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
