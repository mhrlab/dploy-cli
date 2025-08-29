import { execSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";


export function expandTilde(p?: string): string | undefined {
    if (!p) return p;
    if (p.startsWith("~")) return path.join(homedir(), p.slice(1));
    return p;
}


export function safeExec(cmd: string): string | undefined {
    try {
        return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
        return undefined;
    }
}


export function detectVersion(override?: string): string {
    if (override) return override;
    const pkgVersion = safeExec("node -p \"require('./package.json').version\"");
    const shortSha = safeExec("git rev-parse --short HEAD");
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14); // YYYYMMDDHHMMSS
    if (pkgVersion) return `v${pkgVersion}-${shortSha ?? stamp}`;
    return `v${stamp}${shortSha ? `-${shortSha}` : ""}`;
}


export function posixJoin(...parts: string[]): string {
    return parts.join("/").replace(/\\/g, "/");
}
