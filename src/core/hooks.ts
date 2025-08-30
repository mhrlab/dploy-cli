import { execSync } from "node:child_process";
import { exec } from "./ssh.js";
import { Client } from "ssh2";
import { log } from "./logger.js";
import * as os from "node:os";
import chalk from "chalk";


export async function runLocalHooks(phase: string, hooks?: string[]) {
    if (!hooks?.length) {
        log.verbose(`No local ${phase} hooks configured`);
        return;
    }

    log.info(chalk.blue(`Running local ${phase} hooks...`));
    log.debug(`Local ${phase} hooks: ${JSON.stringify(hooks)}`);

    for (const cmd of hooks) {
        log.info(chalk.inverse(` → ${cmd} `));

        try {
            execSync(cmd, {
                stdio: "inherit",
                shell: os.platform() === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/bash",
            });
            log.debug(`Local hook command completed successfully: ${cmd}`);
            log.info(chalk.inverse(` → Hook command completed successfully: ${cmd} `));
        } catch (error) {
            log.debug(`Local hook command failed: ${cmd}, error: ${error}`);
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
        log.verbose(`No remote ${phase} hooks configured`);
        return;
    }

    log.info(chalk.blue(`[remote] Running ${phase} hooks...`));
    log.debug(`Remote ${phase} hooks: ${JSON.stringify(hooks)}`);
    if (cwd) log.debug(`Remote hook working directory: ${cwd}`);

    for (const cmd of hooks) {
        const fullCmd = cwd ? `cd "${cwd}" && ${cmd}` : cmd;

        // Command itself
        log.info(chalk.inverse(`[remote] → ${fullCmd} `));

        const { code, stdout, stderr } = await exec(ssh, fullCmd);

        if (stdout) {
            log.debug(`Remote hook stdout: ${stdout}`);
            process.stdout.write(`${stdout}`);
        }
        if (stderr) {
            log.debug(`Remote hook stderr: ${stderr}`);
            process.stderr.write(chalk.red(`[remote] ${stderr}`));
        }

        if (code !== 0) {
            log.debug(`Remote hook failed with code ${code}: ${cmd}`);
            throw new Error(
                chalk.redBright(`[remote] Hook failed: ${cmd}`)
            );
        }else {
            log.info(chalk.inverse(`[remote] → Remote hook command completed successfully: ${cmd} `));
        }

        log.debug(`Remote hook command completed successfully: ${cmd}`);
    }
}
