import { Client } from "ssh2";
import SFTPClient from "ssh2-sftp-client";
import fs from "fs-extra";
import path from "node:path";
import { EnvConfig } from "./config.js";

export type SSHBundle = {
    ssh: Client;
    sftp: SFTPClient;
};

export async function connect(env: EnvConfig): Promise<SSHBundle> {
    const ssh = new Client();
    const sftp = new SFTPClient();

    const connectConfig: any = {
        host: env.host,
        port: env.port ?? 22,
        username: env.username,
    };
    if (env.password) connectConfig.password = env.password;
    if (env.privateKeyPath) connectConfig.privateKey = await fs.readFile(env.privateKeyPath);

    await new Promise<void>((resolve, reject) => {
        ssh
            .on("ready", () => resolve())
            .on("error", reject)
            .connect(connectConfig);
    });

    await sftp.connect(connectConfig);

    return { ssh, sftp };
}

export async function close(bundle: SSHBundle) {
    await bundle.sftp.end().catch(() => {});
    bundle.ssh.end();
}

export function exec(ssh: Client, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        ssh.exec(command, (err, stream) => {
            if (err) return reject(err);
            let stdout = "";
            let stderr = "";
            stream
                .on("close", (code: number) => resolve({ code: code ?? 0, stdout, stderr }))
                .on("data", (d: Buffer) => (stdout += d.toString()))
                .stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        });
    });
}

export async function ensureRemoteDirs(ssh: Client, ...dirs: string[]) {
    const cmd = dirs.map((d) => `mkdir -p "${d}"`).join(" && ");
    await exec(ssh, cmd);
}

export async function uploadFile(sftp: SFTPClient, localPath: string, remotePath: string) {
    const remoteDir = path.posix.dirname(remotePath);
    await sftp.mkdir(remoteDir, true).catch(() => {});
    await sftp.fastPut(localPath, remotePath);
}

export async function listDirs(sftp: SFTPClient, remotePath: string): Promise<string[]> {
    const list = await sftp.list(remotePath).catch(() => []);
    return list.filter((e) => e.type === "d").map((e) => e.name);
}

export async function removePath(ssh: Client, remotePath: string) {
    await exec(ssh, `rm -rf "${remotePath}"`);
}
