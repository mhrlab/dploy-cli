import { execSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";


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

/**
 * Reads the version from the project's package.json file.
 * This is designed for an ES module environment.
 * @returns {string} The version string from package.json, or 'unknown' if not found.
 */
export function getAppVersion(): string {
    try {
        // Determine the directory of the current module's file.
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);

        // Construct the path to the package.json file, which is assumed to be
        // one directory level up from the current file.
        const packageJsonPath = join(__dirname, '..','..', '..', 'package.json');

        // Read the file and parse the JSON.
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

        // Return the version.
        return packageJson.version;
    } catch (error: any) {
        console.error("Error reading package.json:", error.message);
        return "unknown";
    }
}
