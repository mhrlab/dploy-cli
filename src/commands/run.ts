import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin, escapeShellArg } from "../core/utils.js";

export async function run(command: string, opts: { env?: string; release?: string }) {
    if (!command || !command.trim()) {
        throw new Error("No command specified to run");
    }

    log.debug(`Run command initiated: "${command}" with options: ${JSON.stringify(opts)}`);
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];

    if (!env) {
        throw new Error(`Unknown environment: ${envName}`);
    }
    if (!env.host || !env.username) {
        throw new Error(`Environment '${envName}' is missing required 'host' or 'username'`);
    }

    let targetDir: string | undefined;
    if (env.deployTo) {
        const root = env.deployTo.trim();
        targetDir = opts.release
            ? posixJoin(root, "releases", opts.release)
            : posixJoin(root, "current");
    }

    const remoteCmd = targetDir
        ? `cd ${escapeShellArg(targetDir)} && ${command}`
        : command;

    log.info(`Executing on ${env.username}@${env.host}${targetDir ? ` (${targetDir})` : ""}:`);
    log.info(`$ ${command}`);

    const bundle = await connect(env);
    try {
        const result = await exec(bundle.ssh, remoteCmd);
        if (result.stdout.trim()) {
            console.log(result.stdout);
        }
        if (result.stderr.trim()) {
            console.error(result.stderr);
        }
        if (result.code !== 0) {
            process.exitCode = result.code;
            log.warn(`Remote command exited with code ${result.code}`);
        } else {
            log.ok(`Command completed successfully`);
        }
    } finally {
        await close(bundle);
    }
}
