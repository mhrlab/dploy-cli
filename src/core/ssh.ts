import { Client } from "ssh2";
import SFTPClient from "ssh2-sftp-client";
import fs from "fs-extra";
import path from "node:path";
import { EnvironmentConfig } from "./config.js";
import { log } from "./logger.js";

export type SSHBundle = {
    ssh: Client;
    sftp: SFTPClient;
};

export async function connect(env: EnvironmentConfig): Promise<SSHBundle> {
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
                .stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        });
    });
}

export async function ensureRemoteDirs(ssh: Client, ...dirs: string[]) {
    log.verbose(`Ensuring remote directories exist: ${dirs.join(', ')}`);
    const cmd = dirs.map((d) => `mkdir -p "${d}"`).join(" && ");
    log.debug(`Directory creation command: ${cmd}`);
    await exec(ssh, cmd);
}

export async function uploadFile(sftp: SFTPClient, localPath: string, remotePath: string) {
    log.verbose(`Uploading file: ${localPath} -> ${remotePath}`);
    const remoteDir = path.posix.dirname(remotePath);
    log.debug(`Ensuring remote directory: ${remoteDir}`);
    await sftp.mkdir(remoteDir, true).catch(() => { });
    log.debug(`Starting file upload`);
    await sftp.fastPut(localPath, remotePath);
    log.verbose(`File upload completed`);
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
            mtime: new Date((e.modifyTime || e.accessTime) ?? Date.now()) // ssh2-sftp-client gives modifyTime in ms
        }));
    log.debug(`Found directories: ${JSON.stringify(dirs)}`);
    return dirs;
}

export async function removePath(ssh: Client, remotePath: string) {
    log.debug(`Removing remote path: ${remotePath}`);
    await exec(ssh, `rm -rf "${remotePath}"`);
}
