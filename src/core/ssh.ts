import { Client } from "ssh2";
import SFTPClient from "ssh2-sftp-client";
import fs from "fs-extra";
import path from "node:path";
import { EnvironmentConfig } from "./config.js";
import { log } from "./logger.js";
import { escapeShellArg } from "./utils.js";
import { TransferProgressBar } from "./progress.js";
import { withRetry } from "./retry.js";

export type SSHBundle = {
    ssh: Client;
    sftp: SFTPClient;
};

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
    if (env.ssh_key) connectConfig.privateKey = env.ssh_key;
    if (env.ssh_key_path) connectConfig.privateKey = await fs.readFile(env.ssh_key_path);

    log.debug(`SSH connection config: ${JSON.stringify({
        host: connectConfig.host,
        port: connectConfig.port,
        username: connectConfig.username,
        hasPassword: !!connectConfig.password,
        hasPrivateKey: !!connectConfig.privateKey
    })}`);

    await new Promise<void>((resolve, reject) => {
        ssh
            .on("ready", () => {
                log.verbose(`SSH connection established`);
                resolve();
            })
            .on("error", (err) => {
                log.debug(`SSH connection error: ${err.message}`);
                reject(err);
            })
            .connect(connectConfig);
    });

    log.verbose(`Connecting SFTP client`);
    await sftp.connect(connectConfig);
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
    await exec(ssh, cmd);
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
    await exec(ssh, `rm -rf ${escapeShellArg(remotePath)}`);
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
    const cmd = `(ln -sfn ${escapeShellArg(targetPath)} ${escapeShellArg(tmpLink)} && mv -Tf ${escapeShellArg(tmpLink)} ${escapeShellArg(currentLink)} 2>/dev/null) || ln -sfn ${escapeShellArg(targetPath)} ${escapeShellArg(currentLink)}`;
    return await exec(ssh, cmd);
}
