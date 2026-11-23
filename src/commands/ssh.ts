import { spawn } from "node:child_process";
import { loadConfig, getEnvName } from "../core/config.js";
import { log } from "../core/logger.js";
import { posixJoin, escapeShellArg } from "../core/utils.js";

export async function ssh(opts: { env?: string }) {
    log.debug(`SSH command initiated with options: ${JSON.stringify(opts)}`);
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];

    if (!env) {
        throw new Error(`Unknown environment: ${envName}`);
    }
    if (!env.host || !env.username) {
        throw new Error(`Environment '${envName}' is missing required 'host' or 'username'`);
    }

    const remoteCwd = env.deployTo ? posixJoin(env.deployTo.trim(), "current") : undefined;
    const sshArgs: string[] = [];

    if (env.port && env.port !== 22) {
        sshArgs.push("-p", String(env.port));
    }
    if (env.ssh_key_path) {
        sshArgs.push("-i", env.ssh_key_path);
    }

    // Force pseudo-terminal allocation for interactive session
    sshArgs.push("-t");

    const destination = `${env.username}@${env.host}`;
    sshArgs.push(destination);

    if (remoteCwd) {
        sshArgs.push(`cd ${escapeShellArg(remoteCwd)} 2>/dev/null || cd ${escapeShellArg(env.deployTo!.trim())} 2>/dev/null || true; exec $SHELL -l`);
    }

    log.info(`Connecting to ${destination}${remoteCwd ? ` at ${remoteCwd}` : ""}...`);

    return new Promise<void>((resolve, reject) => {
        const child = spawn("ssh", sshArgs, {
            stdio: "inherit",
        });

        child.on("error", (err) => {
            log.err(`Failed to spawn native ssh: ${err.message}`);
            reject(err);
        });

        child.on("close", (code) => {
            if (code !== 0 && code !== null) {
                log.debug(`SSH session exited with code ${code}`);
            }
            resolve();
        });
    });
}
