import fs from "fs-extra";
import path from "node:path";
import inquirer from "inquirer";
import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin, escapeShellArg } from "../core/utils.js";
import { updateOrAppendEnv } from "../features/env-sync.js";

function getRemoteSharedEnvPath(deployTo: string): string {
    return posixJoin(deployTo.trim(), "shared", ".env");
}

export async function envPush(opts: {
    env?: string;
    file?: string;
    force?: boolean;
    yes?: boolean;
}) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];

    if (!env || !env.deployTo) {
        throw new Error(`Environment '${envName}' is missing or lacks deployTo path`);
    }

    const localFile = opts.file
        ? path.resolve(process.cwd(), opts.file)
        : (await fs.pathExists(path.resolve(process.cwd(), `.env.${envName}`)))
        ? path.resolve(process.cwd(), `.env.${envName}`)
        : path.resolve(process.cwd(), ".env");

    if (!(await fs.pathExists(localFile))) {
        throw new Error(`Local env file not found: ${localFile}`);
    }

    const remoteEnvPath = getRemoteSharedEnvPath(env.deployTo);
    log.info(`Pushing ${path.basename(localFile)} to ${env.username}@${env.host}:${remoteEnvPath}`);

    const bundle = await connect(env);
    try {
        const sharedDir = posixJoin(env.deployTo.trim(), "shared");
        await exec(bundle.ssh, `mkdir -p ${escapeShellArg(sharedDir)}`);

        // Check if remote file exists and create backup
        const checkRes = await exec(bundle.ssh, `[ -f ${escapeShellArg(remoteEnvPath)} ] && echo "exists" || true`);
        const remoteExists = checkRes.stdout.trim() === "exists";

        if (remoteExists && !opts.force && !opts.yes && process.stdin.isTTY) {
            const answer = await inquirer.prompt([
                {
                    type: "confirm",
                    name: "overwrite",
                    message: `Remote ${remoteEnvPath} already exists. Overwrite?`,
                    default: false,
                },
            ]);
            if (!answer.overwrite) {
                log.warn("Env push aborted by user");
                return;
            }
        }

        if (remoteExists) {
            const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
            const backupPath = `${remoteEnvPath}.bak.${stamp}`;
            log.verbose(`Creating remote backup: ${backupPath}`);
            await exec(bundle.ssh, `cp ${escapeShellArg(remoteEnvPath)} ${escapeShellArg(backupPath)}`);
            log.ok(`Backed up remote env to ${path.posix.basename(backupPath)}`);
        }

        await bundle.sftp.fastPut(localFile, remoteEnvPath);
        await exec(bundle.ssh, `chmod 600 ${escapeShellArg(remoteEnvPath)} 2>/dev/null || true`);
        log.ok(`Successfully pushed ${path.basename(localFile)} to remote shared environment`);
    } finally {
        await close(bundle);
    }
}

export async function envPull(opts: {
    env?: string;
    out?: string;
    force?: boolean;
    yes?: boolean;
}) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];

    if (!env || !env.deployTo) {
        throw new Error(`Environment '${envName}' is missing or lacks deployTo path`);
    }

    const defaultOut = `.env.${envName}.remote`;
    const destFile = path.resolve(process.cwd(), opts.out || defaultOut);

    if ((await fs.pathExists(destFile)) && !opts.force && !opts.yes && process.stdin.isTTY) {
        const answer = await inquirer.prompt([
            {
                type: "confirm",
                name: "overwrite",
                message: `Local file ${path.basename(destFile)} already exists. Overwrite?`,
                default: false,
            },
        ]);
        if (!answer.overwrite) {
            log.warn("Env pull aborted by user");
            return;
        }
    }

    const remoteEnvPath = getRemoteSharedEnvPath(env.deployTo);
    log.info(`Pulling from ${env.username}@${env.host}:${remoteEnvPath} -> ${path.basename(destFile)}`);

    const bundle = await connect(env);
    try {
        const checkRes = await exec(bundle.ssh, `[ -f ${escapeShellArg(remoteEnvPath)} ] && echo "exists" || true`);
        if (checkRes.stdout.trim() !== "exists") {
            throw new Error(`Remote env file does not exist at ${remoteEnvPath}`);
        }

        await bundle.sftp.fastGet(remoteEnvPath, destFile);
        log.ok(`Successfully pulled remote env to ${path.basename(destFile)}`);
    } finally {
        await close(bundle);
    }
}

export async function envSet(keyValuePair: string, opts: { env?: string }) {
    const eqIdx = keyValuePair.indexOf("=");
    if (eqIdx === -1) {
        throw new Error("Invalid KEY=VALUE format. Expected syntax: dploy env:set KEY=VALUE");
    }

    const key = keyValuePair.slice(0, eqIdx).trim();
    const val = keyValuePair.slice(eqIdx + 1).trim();

    if (!key) {
        throw new Error("Variable key cannot be empty");
    }

    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];

    if (!env || !env.deployTo) {
        throw new Error(`Environment '${envName}' is missing or lacks deployTo path`);
    }

    const remoteEnvPath = getRemoteSharedEnvPath(env.deployTo);
    log.info(`Setting ${key} in remote ${env.username}@${env.host}:${remoteEnvPath}`);

    const bundle = await connect(env);
    try {
        const sharedDir = posixJoin(env.deployTo.trim(), "shared");
        await exec(bundle.ssh, `mkdir -p ${escapeShellArg(sharedDir)}`);

        // Read existing remote .env if present
        let currentContent = "";
        const readRes = await exec(bundle.ssh, `cat ${escapeShellArg(remoteEnvPath)} 2>/dev/null || true`);
        currentContent = readRes.stdout;

        const updatedContent = updateOrAppendEnv(currentContent, key, val);

        // Upload updated content via temporary file or stream
        const tmpRemote = `${remoteEnvPath}.tmp`;
        const buffer = Buffer.from(updatedContent, "utf8");
        await bundle.sftp.put(buffer, tmpRemote);
        await exec(bundle.ssh, `mv -f ${escapeShellArg(tmpRemote)} ${escapeShellArg(remoteEnvPath)} && chmod 600 ${escapeShellArg(remoteEnvPath)} 2>/dev/null || true`);

        log.ok(`Successfully set ${key} on remote shared environment`);
    } finally {
        await close(bundle);
    }
}
