import { loadConfig, getEnvName, EnvironmentConfig } from "../core/config.js";
import { connect, close, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin, escapeShellArg, expandTilde } from "../core/utils.js";

export async function run(command: string, opts: {
    env?: string;
    release?: string;
    asAdmin?: boolean;
    asSudo?: boolean;
    adminUser?: string;
    adminKey?: string;
    adminPassword?: string;
}) {
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

    // Resolve privileged admin connection if requested
    const isExplicitAdmin = Boolean(opts.asAdmin || opts.asSudo || opts.adminUser || opts.adminKey || opts.adminPassword);
    const adminUser = opts.adminUser || process.env.DPLOY_ADMIN_USER || (isExplicitAdmin ? env.admin?.username : undefined);

    if ((opts.asAdmin || opts.asSudo) && !adminUser) {
        throw new Error(`Admin credentials not found in 'admin' block of deploy.config.yml for environment '${envName}'. Please configure 'admin:' or pass --admin-user.`);
    }

    let connConfig: EnvironmentConfig = env;
    if (adminUser) {
        const adminKey = opts.adminKey || process.env.DPLOY_ADMIN_KEY || env.admin?.ssh_key_path;
        const adminPassword = opts.adminPassword || process.env.DPLOY_ADMIN_PASSWORD || env.admin?.password;
        connConfig = {
            ...env,
            username: adminUser,
            ssh_key_path: adminKey ? expandTilde(adminKey) : (adminUser === env.username ? env.ssh_key_path : (env.admin?.ssh_key_path ? expandTilde(env.admin.ssh_key_path) : env.ssh_key_path)),
            password: adminPassword || (adminUser === env.username ? env.password : env.admin?.password),
            passphrase: env.admin?.passphrase || env.passphrase,
        };
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

    log.info(`Executing on ${connConfig.username}@${connConfig.host}${targetDir ? ` (${targetDir})` : ""}:`);
    log.info(`$ ${command}`);

    const bundle = await connect(connConfig);
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
