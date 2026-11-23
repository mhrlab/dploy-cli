import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin, escapeShellArg } from "../core/utils.js";

export async function logs(opts: {
    env?: string;
    follow?: boolean;
    lines?: string | number;
    file?: string;
    type?: "app" | "nginx" | "pm2" | "systemd" | string;
}) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];

    if (!env || !env.deployTo) {
        throw new Error(`Environment '${envName}' is missing or lacks deployTo path`);
    }

    const lineCount = Number(opts.lines) || 50;
    const isFollow = opts.follow ?? false;

    let targetCmd: string;

    if (opts.file) {
        targetCmd = `tail -n ${lineCount} ${isFollow ? "-f " : ""}${escapeShellArg(opts.file)}`;
    } else if (opts.type === "nginx") {
        targetCmd = `tail -n ${lineCount} ${isFollow ? "-f " : ""}/var/log/nginx/error.log /var/log/nginx/access.log 2>/dev/null || tail -n ${lineCount} ${isFollow ? "-f " : ""}/var/log/nginx/error.log`;
    } else if (opts.type === "pm2") {
        const appName = cfg.name || "all";
        targetCmd = `pm2 logs ${appName} --lines ${lineCount} ${isFollow ? "" : "--nostream"}`;
    } else if (opts.type === "systemd") {
        const serviceName = cfg.name ? `${cfg.name}.service` : "";
        targetCmd = `journalctl -n ${lineCount} ${isFollow ? "-f " : ""}${serviceName ? `-u ${serviceName}` : ""}`;
    } else {
        // Default: tail application log in <deployTo>/logs or <deployTo>/shared/logs
        const appLogDir = posixJoin(env.deployTo.trim(), "logs");
        const sharedLogDir = posixJoin(env.deployTo.trim(), "shared", "logs");
        targetCmd = `tail -n ${lineCount} ${isFollow ? "-f " : ""}${escapeShellArg(appLogDir)}/*.log ${escapeShellArg(sharedLogDir)}/*.log 2>/dev/null || echo "No application logs found in ${appLogDir} or ${sharedLogDir}"`;
    }

    log.info(`Streaming logs from ${env.username}@${env.host}:`);
    log.debug(`Executing: ${targetCmd}`);

    const bundle = await connect(env);

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
