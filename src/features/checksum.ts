import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Client } from "ssh2";
import { exec } from "../core/ssh.js";
import { escapeShellArg } from "../core/utils.js";

export async function sha256File(filePath: string): Promise<string> {
    const hash = createHash("sha256");

    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve());
    });

    return hash.digest("hex");
}

async function remoteSha256(ssh: Client, remotePath: string): Promise<string> {
    const command = [
        `if command -v sha256sum >/dev/null 2>&1; then`,
        `  sha256sum ${escapeShellArg(remotePath)} | cut -d' ' -f1;`,
        `elif command -v shasum >/dev/null 2>&1; then`,
        `  shasum -a 256 ${escapeShellArg(remotePath)} | cut -d' ' -f1;`,
        `else`,
        `  echo "__NO_SHA256_TOOL__";`,
        `fi`,
    ].join(" ");

    const { code, stdout, stderr } = await exec(ssh, command);
    const digest = stdout.trim();

    if (code !== 0) {
        throw new Error(stderr || "remote checksum command failed");
    }
    if (!digest || digest === "__NO_SHA256_TOOL__") {
        throw new Error("Remote host does not have sha256sum or shasum installed");
    }

    return digest;
}

export async function verifyArtifactChecksum(options: {
    ssh: Client;
    localPath: string;
    remotePath: string;
}): Promise<{ localHash: string; remoteHash: string }> {
    const localHash = await sha256File(options.localPath);
    const remoteHash = await remoteSha256(options.ssh, options.remotePath);

    if (localHash !== remoteHash) {
        throw new Error(
            `Artifact checksum mismatch: local ${localHash} does not match remote ${remoteHash}`
        );
    }

    return { localHash, remoteHash };
}
