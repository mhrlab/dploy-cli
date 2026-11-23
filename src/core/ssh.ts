import { Client } from "ssh2";
import SFTPClient from "ssh2-sftp-client";
import fs from "fs-extra";
import path from "node:path";
import inquirer from "inquirer";
import { EnvironmentConfig } from "./config.js";
import { log } from "./logger.js";
import { escapeShellArg } from "./utils.js";
import { TransferProgressBar } from "./progress.js";
import { withRetry } from "./retry.js";

export type SSHBundle = {
    ssh: Client;
    sftp: SFTPClient;
};

// In-memory cache for SSH passphrase so user isn't prompted repeatedly across multiple connections/hosts in one run
let cachedPassphrase: string | null = null;

export function setCachedPassphrase(passphrase: string | null) {
    cachedPassphrase = passphrase;
}

export function getCachedPassphrase(): string | null {
    return cachedPassphrase;
}

/**
 * Check if a private key string/buffer is encrypted and requires a passphrase.
 */
export function isEncryptedPrivateKey(keyContent: string | Buffer): boolean {
    const str = Buffer.isBuffer(keyContent) ? keyContent.toString("utf8") : String(keyContent);
    return (
        str.includes("ENCRYPTED") ||
        str.includes("Proc-Type: 4,ENCRYPTED") ||
        str.includes("BEGIN ENCRYPTED PRIVATE KEY")
    );
}

/**
 * Resolves the passphrase from config, environment, cached memory, or interactive prompt.
 */
export async function resolvePassphrase(env: EnvironmentConfig, keySource?: string): Promise<string | undefined> {
    if (env.passphrase) return env.passphrase;
    if (process.env.DPLOY_PASSPHRASE) return process.env.DPLOY_PASSPHRASE;
    if (process.env.SSH_PASSPHRASE) return process.env.SSH_PASSPHRASE;
    if (cachedPassphrase) return cachedPassphrase;

    // If running in an interactive terminal, prompt the user securely
    if (process.stdin.isTTY) {
        const promptLabel = keySource ? ` (${path.basename(keySource)})` : "";
        const { passphrase } = await inquirer.prompt([
            {
                type: "password",
                name: "passphrase",
                message: `Enter passphrase for encrypted SSH key${promptLabel}:`,
                mask: "*",
            },
        ]);
        cachedPassphrase = passphrase ?? null;
        return passphrase;
    }

    return undefined;
}

async function createConnection(env: EnvironmentConfig): Promise<SSHBundle> {
    log.debug(`SSH connect initiated for ${env.username}@${env.host}:${env.port || 22}`);

    const ssh = new Client();
    const sftp = new SFTPClient();

    const connectConfig: any = {
        host: env.host,
        port: env.port ?? 22,
        username: env.username,
    };
    if (env.password) connectConfig.password = env.password;

    let privateKeyContent: Buffer | string | undefined;
    if (env.ssh_key) {
        privateKeyContent = env.ssh_key;
    } else if (env.ssh_key_path) {
        privateKeyContent = await fs.readFile(env.ssh_key_path);
    }

    if (privateKeyContent) {
        connectConfig.privateKey = privateKeyContent;
        let passphrase: string | undefined =
            env.passphrase ||
            process.env.DPLOY_PASSPHRASE ||
            process.env.SSH_PASSPHRASE ||
            (cachedPassphrase ?? undefined);

        // If key is encrypted and no passphrase provided yet, prompt or resolve it
        if (!passphrase && isEncryptedPrivateKey(privateKeyContent)) {
            passphrase = await resolvePassphrase(env, env.ssh_key_path);
        }

        if (passphrase) {
            connectConfig.passphrase = passphrase;
        }
    }

    log.debug(`SSH connection config: ${JSON.stringify({
        host: connectConfig.host,
        port: connectConfig.port,
        username: connectConfig.username,
        hasPassword: !!connectConfig.password,
        hasPrivateKey: !!connectConfig.privateKey,
        hasPassphrase: !!connectConfig.passphrase,
    })}`);

    await new Promise<void>((resolve, reject) => {
        ssh
            .on("ready", () => {
                log.verbose(`SSH connection established`);
                resolve();
            })
            .on("error", async (err: any) => {
                log.debug(`SSH connection error: ${err.message}`);
                // If error indicates missing passphrase and we haven't prompted yet
                if (
                    /passphrase/i.test(err.message) &&
                    !connectConfig.passphrase &&
                    process.stdin.isTTY
                ) {
                    try {
                        const promptedPass = await resolvePassphrase(env, env.ssh_key_path);
                        if (promptedPass) {
                            connectConfig.passphrase = promptedPass;
                            // Retry connection with the entered passphrase
                            const retrySsh = new Client();
                            retrySsh
                                .on("ready", () => {
                                    // replace ssh instance
                                    (ssh as any)._sock = (retrySsh as any)._sock;
                                    resolve();
                                })
                                .on("error", reject)
                                .connect(connectConfig);
                            return;
                        }
                    } catch (promptErr) {
                        return reject(promptErr);
                    }
                }
                reject(err);
            })
            .connect(connectConfig);
    });

    log.verbose(`Connecting SFTP client`);
    try {
        await sftp.connect(connectConfig);
    } catch (err) {
        ssh.end();
        throw err;
    }
    log.verbose(`SFTP connection established`);

    return { ssh, sftp };
}

export async function connect(
    env: EnvironmentConfig,
    options?: { retries?: number; delayMs?: number }
): Promise<SSHBundle> {
    const retries = options?.retries ?? env.retries ?? 3;
    const delayMs = options?.delayMs ?? 1500;

    return withRetry(() => createConnection(env), {
        retries,
        delayMs,
        onRetry: (err, attempt, nextDelay) => {
            log.warn(`SSH connection attempt ${attempt}/${retries} failed (${err.message || String(err)}). Retrying in ${nextDelay}ms...`);
        },
    });
}

export async function close(bundle: SSHBundle) {
    log.debug(`Closing SSH connections`);
    await bundle.sftp.end().catch(() => { });
    bundle.ssh.end();
}

export function exec(ssh: Client, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    log.debug(`Executing SSH command: ${command}`);

    return new Promise((resolve, reject) => {
        ssh.exec(command, (err, stream) => {
            if (err) {
                log.debug(`SSH exec error: ${err.message}`);
                return reject(err);
            }
            let stdout = "";
            let stderr = "";
            stream
                .on("close", (code: number) => {
                    log.debug(`SSH command completed with code: ${code}`);
                    if (stdout) log.debug(`SSH stdout: ${stdout}`);
                    if (stderr) log.debug(`SSH stderr: ${stderr}`);
                    resolve({ code: code ?? 0, stdout, stderr });
                })
                .on("data", (d: Buffer) => (stdout += d.toString()))
                .on("error", (streamErr: Error) => {
                    log.debug(`SSH stream error: ${streamErr.message}`);
                    reject(streamErr);
                });
            stream.stderr
                .on("data", (d: Buffer) => (stderr += d.toString()))
                .on("error", (stderrErr: Error) => {
                    log.debug(`SSH stderr stream error: ${stderrErr.message}`);
                    reject(stderrErr);
                });
        });
    });
}

export async function ensureRemoteDirs(ssh: Client, ...dirs: string[]) {
    log.verbose(`Ensuring remote directories exist: ${dirs.join(', ')}`);
    const cmd = dirs.map((d) => `mkdir -p ${escapeShellArg(d)}`).join(" && ");
    log.debug(`Directory creation command: ${cmd}`);
    const { code, stderr } = await exec(ssh, cmd);
    if (code !== 0) {
        throw new Error(
            `Failed to create remote directories on server (${dirs.join(', ')}): ${stderr.trim() || `exit code ${code}`}.\n` +
            `Please check that the remote user has permission to create directories inside the target path, or run 'dploy provision'.`
        );
    }
}

export interface UploadFileOptions {
    showProgress?: boolean;
    label?: string;
    retries?: number;
    onProgress?: (transferred: number, chunk: number, total: number) => void;
}

export async function uploadFile(
    sftp: SFTPClient,
    localPath: string,
    remotePath: string,
    options?: UploadFileOptions
) {
    log.verbose(`Uploading file: ${localPath} -> ${remotePath}`);
    const remoteDir = path.posix.dirname(remotePath);
    log.debug(`Ensuring remote directory: ${remoteDir}`);
    await sftp.mkdir(remoteDir, true).catch(() => { });
    log.debug(`Starting file upload`);

    let progress: TransferProgressBar | null = null;
    let size = 0;
    try {
        const stat = await fs.stat(localPath);
        size = stat.size;
    } catch {
        // file might be in-memory or not stat-able
    }

    const showProgress = options?.showProgress ?? (size > 8192);
    if (showProgress) {
        progress = new TransferProgressBar({
            totalBytes: size,
            label: options?.label ?? `Uploading ${path.basename(localPath)}`,
        });
    }

    const retries = options?.retries ?? 2;
    await withRetry(
        async () => {
            try {
                await sftp.fastPut(localPath, remotePath, {
                    step: (transferred: number, chunk: number, total: number) => {
                        if (progress) {
                            progress.update(transferred);
                        }
                        if (options?.onProgress) {
                            options.onProgress(transferred, chunk, total);
                        }
                    },
                });
            } catch (err: any) {
                if (err?.message?.includes("No such file") || err?.code === 2) {
                    const localExists = await fs.pathExists(localPath);
                    if (localExists) {
                        throw new Error(
                            `Remote destination directory '${remoteDir}' does not exist or is not writable on the server (SFTP error: No such file).\n` +
                            `Please ensure '${remoteDir}' exists and is owned/writable by the SSH user (e.g. run 'dploy provision' or 'sudo mkdir -p ${remoteDir} && sudo chown -R $USER:$USER ${remoteDir}').`
                        );
                    } else {
                        throw new Error(`Local file '${localPath}' does not exist on disk.`);
                    }
                }
                throw err;
            }
        },
        {
            retries,
            delayMs: 1000,
            onRetry: (err, attempt, nextDelay) => {
                log.warn(`SFTP upload attempt ${attempt}/${retries} failed (${err.message || String(err)}). Retrying in ${nextDelay}ms...`);
            },
        }
    );

    if (progress) {
        progress.finish();
    } else {
        log.verbose(`File upload completed: ${localPath}`);
    }
}

export type RemoteDir = {
    name: string;
    mtime: Date;
};

export async function listDirs(sftp: SFTPClient, remotePath: string): Promise<RemoteDir[]> {
    log.debug(`Listing directories in: ${remotePath}`);
    const list = await sftp.list(remotePath).catch(() => []);
    const dirs: RemoteDir[] = list
        .filter((e) => e.type === "d")
        .map((e) => ({
            name: e.name,
            mtime: new Date((e.modifyTime || e.accessTime) ?? Date.now())
        }));
    log.debug(`Found directories: ${JSON.stringify(dirs)}`);
    return dirs;
}

export async function removePath(ssh: Client, remotePath: string) {
    log.debug(`Removing remote path: ${remotePath}`);
    const { code, stderr } = await exec(ssh, `rm -rf ${escapeShellArg(remotePath)}`);
    if (code !== 0) {
        throw new Error(`Failed to remove remote path '${remotePath}': ${stderr.trim() || `exit code ${code}`}`);
    }
}

/**
 * Switch the 'current' symlink atomically using the POSIX rename pattern.
 * Creates a temporary symlink and replaces the target via 'mv -Tf' (with fallback to 'ln -sfn').
 * The 'rename' syscall is guaranteed atomic in POSIX kernels, preventing transient 404/ENOENT errors during cutover.
 */
export async function switchCurrentSymlink(
    ssh: Client,
    targetPath: string,
    currentLink: string
): Promise<{ code: number; stdout: string; stderr: string }> {
    log.debug(`Switching current symlink atomically: ${currentLink} -> ${targetPath}`);
    const tmpLink = `${currentLink}_tmp_${Date.now()}`;
    const cmd = `(ln -sfn ${escapeShellArg(targetPath)} ${escapeShellArg(tmpLink)} && mv -Tf ${escapeShellArg(tmpLink)} ${escapeShellArg(currentLink)} 2>/dev/null) || (rm -f ${escapeShellArg(tmpLink)} 2>/dev/null; ln -sfn ${escapeShellArg(targetPath)} ${escapeShellArg(currentLink)})`;
    const res = await exec(ssh, cmd);
    if (res.code !== 0) {
        throw new Error(
            `Failed to switch active symlink (${currentLink} -> ${targetPath}): ${res.stderr.trim() || `exit code ${res.code}`}`
        );
    }
    return res;
}
