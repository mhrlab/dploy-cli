import path from "node:path";
import fs from "fs-extra";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { configFiles } from "./config.js";


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

export function getReadableFileSize(sizeInBytes: number, decimals: number = 2): string {
    if (sizeInBytes === 0) {
        return '0 Bytes';
    }
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(sizeInBytes) / Math.log(k));
    return parseFloat((sizeInBytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}


/**
 * Reads the version from the project's package.json file.
 * @returns {string} The version string from package.json, or 'unknown' if not found.
 */
export function getAppVersion(): string {
    try {
        // Determine the directory of the current module's file.
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);

        // Construct the path to the package.json file, which is assumed to be
        // one directory level up from the current file.
        const packageJsonPath = join(__dirname, '..', '..', '..', 'package.json');

        // Read the file and parse the JSON.
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

        // Return the version.
        return packageJson.version;
    } catch (error: any) {
        console.error("Error reading package.json:", error.message);
        return "unknown";
    }
}


/**
 * Ignore configs files from indexing in git via adding them in `.gitignore`
 * keep it flexible for future exclude logic
 */
export async function updateGitignore() {
    const gitignore = path.resolve(process.cwd(), ".gitignore");
    const entries = configFiles.gitignore;

    // If file does not exist → create with all entries
    if (!(await fs.pathExists(gitignore))) {
        await fs.writeFile(gitignore, entries.join("\n") + "\n", "utf8");
        return;
    }

    // if file exits then read and update it
    let content = readFileSync(gitignore, "utf8");
    let updated = false;

    for (const entry of entries) {
        if (!content.split(/\r?\n/).includes(entry)) {
            content += (content.endsWith("\n") ? "" : "\n") + entry + "\n";
            updated = true;
        }
    }

    if (updated) {
        await fs.writeFile(gitignore, content, "utf8");
    }
}


