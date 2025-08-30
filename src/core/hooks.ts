import { execSync } from "node:child_process";
import { exec } from "./ssh.js";
import { Client } from "ssh2";
import { log } from "./logger.js";
import * as os from "node:os";
import chalk from "chalk";


export async function runLocalHooks(phase: string, hooks?: string[]) {
    if (!hooks?.length) {
        return;
    }

    log.info(`Running local ${phase} hooks...`);
    for (const cmd of hooks) {
        log.info(`→ ${cmd}`);
        try {
            execSync(cmd, {
                stdio: "inherit",
                shell: os.platform() === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/bash",
            });
        } catch (error) {
            throw error;
        }
    }
}


export async function runRemoteHooks(
    ssh: Client,
    phase: string,
    hooks?: string[],
    cwd?: string
) {
    if (!hooks?.length) {
        return;
    }

    log.info(chalk.cyan(`[remote] Running ${phase} hooks...`));

    for (const cmd of hooks) {
        const fullCmd = cwd ? `cd "${cwd}" && ${cmd}` : cmd;

        // Command itself
        log.info(chalk.yellow(`[remote] → ${fullCmd}`));

        const { code, stdout, stderr } = await exec(ssh, fullCmd);

        if (stdout) {
            process.stdout.write(`${stdout}`);
        }
        if (stderr) {
            process.stderr.write(chalk.red(`[remote] ${stderr}`));
        }

        if (code !== 0) {
            throw new Error(
                chalk.redBright(`[remote] Hook failed: ${cmd}`)
            );
        }
    }
}
