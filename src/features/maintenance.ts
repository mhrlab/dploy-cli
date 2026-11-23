import { Client } from "ssh2";
import { posixJoin, escapeShellArg } from "../core/utils.js";
import { exec } from "../core/ssh.js";

export interface MaintenancePayload {
    enabledAt: string;
    message?: string;
    retryAfter?: number;
}

export function formatMaintenancePayload(opts: { message?: string; retryAfter?: number }): string {
    const payload: MaintenancePayload = {
        enabledAt: new Date().toISOString(),
        message: opts.message || "Site undergoing scheduled maintenance.",
        retryAfter: opts.retryAfter || 300,
    };
    return JSON.stringify(payload, null, 2);
}

export async function enableMaintenance(
    ssh: Client,
    deployTo: string,
    opts: { message?: string; retryAfter?: number } = {}
): Promise<string> {
    const sharedDir = posixJoin(deployTo.trim(), "shared");
    const flagPath = posixJoin(sharedDir, "maintenance.json");
    const content = formatMaintenancePayload(opts);

    await exec(ssh, `mkdir -p ${escapeShellArg(sharedDir)}`);
    const cmd = `cat << 'EOF' > ${escapeShellArg(flagPath)}\n${content}\nEOF`;
    const res = await exec(ssh, cmd);

    if (res.code !== 0) {
        throw new Error(`Failed to create maintenance flag: ${res.stderr || `exit code ${res.code}`}`);
    }

    // Also symlink into current if current exists so web servers or frameworks can inspect it
    const currentLink = posixJoin(deployTo.trim(), "current");
    const currentFlag = posixJoin(currentLink, "down");
    await exec(ssh, `if [ -d ${escapeShellArg(currentLink)} ]; then ln -sfn ${escapeShellArg(flagPath)} ${escapeShellArg(currentFlag)} 2>/dev/null || true; fi`);

    return flagPath;
}

export async function disableMaintenance(ssh: Client, deployTo: string): Promise<void> {
    const sharedFlag = posixJoin(deployTo.trim(), "shared", "maintenance.json");
    const currentFlag = posixJoin(deployTo.trim(), "current", "down");

    await exec(ssh, `rm -f ${escapeShellArg(sharedFlag)} ${escapeShellArg(currentFlag)} 2>/dev/null || true`);
}

export async function checkMaintenance(ssh: Client, deployTo: string): Promise<MaintenancePayload | null> {
    const flagPath = posixJoin(deployTo.trim(), "shared", "maintenance.json");
    const { stdout, code } = await exec(ssh, `cat ${escapeShellArg(flagPath)} 2>/dev/null || true`);

    if (code !== 0 || !stdout.trim()) {
        return null;
    }

    try {
        return JSON.parse(stdout.trim()) as MaintenancePayload;
    } catch {
        return { enabledAt: "unknown", message: stdout.trim() };
    }
}
