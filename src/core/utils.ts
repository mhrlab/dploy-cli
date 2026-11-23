import path from "node:path";
import fs from "fs-extra";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { configFiles } from "./config.js";
import {log} from "./logger.js";


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

export function isValidVersionString(version: string): boolean {
    return version !== "." && version !== ".." && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(version);
}

export function assertValidVersion(version: string): void {
    if (!isValidVersionString(version)) {
        throw new Error(
            `Invalid version format: '${version}'. Must start with an alphanumeric character and contain only alphanumeric, '.', '_', and '-'.`
        );
    }
}

export function escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
}

export interface DetectVersionOptions {
    override?: string;
    versionCommand?: string;
    versionFile?: string;
    cwd?: string;
}

export function detectVersion(
    overrideOrOptions?: string | DetectVersionOptions,
    versionCommandArg?: string,
    cwdArg?: string
): string {
    const opts: DetectVersionOptions =
        typeof overrideOrOptions === "object" && overrideOrOptions !== null
            ? overrideOrOptions
            : {
                  override: overrideOrOptions,
                  versionCommand: versionCommandArg,
                  cwd: cwdArg,
              };

    const cwd = opts.cwd ?? process.cwd();

    // 1. Explicit CLI override
    if (opts.override) {
        assertValidVersion(opts.override);
        return opts.override;
    }

    // 2. Custom versionCommand configured in deploy.config.yml
    if (opts.versionCommand) {
        const cmdOutput = safeExec(opts.versionCommand);
        if (cmdOutput) {
            const candidate = cmdOutput.split(/\r?\n/)[0].trim();
            if (candidate) {
                assertValidVersion(candidate);
                return candidate;
            }
        }
    }

    // 3. Git tag check: exact match first, then nearest tag
    const gitExactTag = safeExec("git describe --tags --exact-match 2>/dev/null");
    if (gitExactTag) {
        const candidate = gitExactTag.trim();
        if (candidate && isValidVersionString(candidate)) {
            return candidate;
        }
    }

    const gitNearestTag = safeExec("git describe --tags 2>/dev/null");
    if (gitNearestTag) {
        const candidate = gitNearestTag.trim();
        if (candidate && isValidVersionString(candidate)) {
            return candidate;
        }
    }

    // 4. Manifest / File detection
    // Priority order:
    // a. Custom versionFile from deploy.config.yml
    // b. VERSION / version.txt (explicit version tracking file)
    // c. composer.json ("version" field)
    // d. package.json ("version" field)
    let manifestVersion: string | undefined;

    // 4a. Custom versionFile
    if (opts.versionFile) {
        const customPath = path.isAbsolute(opts.versionFile)
            ? opts.versionFile
            : path.resolve(cwd, opts.versionFile);
        if (fs.existsSync(customPath)) {
            try {
                if (customPath.endsWith(".json")) {
                    const parsed = JSON.parse(readFileSync(customPath, "utf8"));
                    if (typeof parsed.version === "string" && parsed.version.trim()) {
                        manifestVersion = parsed.version.trim();
                    }
                } else {
                    const raw = readFileSync(customPath, "utf8").trim().split(/\r?\n/)[0].trim();
                    if (raw && isValidVersionString(raw)) {
                        manifestVersion = raw;
                    }
                }
            } catch {}
        }
    }

    // 4b. VERSION or version.txt file
    if (!manifestVersion) {
        for (const filename of ["VERSION", "version.txt"]) {
            const vFile = path.resolve(cwd, filename);
            if (fs.existsSync(vFile)) {
                try {
                    const raw = readFileSync(vFile, "utf8").trim().split(/\r?\n/)[0].trim();
                    if (raw && isValidVersionString(raw)) {
                        manifestVersion = raw;
                        break;
                    }
                } catch {}
            }
        }
    }

    // 4c. composer.json (PHP)
    if (!manifestVersion) {
        const localComposer = path.resolve(cwd, "composer.json");
        if (fs.existsSync(localComposer)) {
            try {
                const parsed = JSON.parse(readFileSync(localComposer, "utf8"));
                if (typeof parsed.version === "string" && parsed.version.trim()) {
                    manifestVersion = parsed.version.trim();
                }
            } catch {}
        }
    }

    // 4d. package.json (Node)
    if (!manifestVersion) {
        const localPkg = path.resolve(cwd, "package.json");
        if (fs.existsSync(localPkg)) {
            try {
                const parsed = JSON.parse(readFileSync(localPkg, "utf8"));
                if (typeof parsed.version === "string" && parsed.version.trim()) {
                    manifestVersion = parsed.version.trim();
                }
            } catch {}
        }
    }

    // 5. Existing fallback: manifestVersion + shortSha, or timestamp + shortSha
    const shortSha = safeExec("git rev-parse --short HEAD");
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14); // YYYYMMDDHHMMSS

    let version: string;
    if (manifestVersion) {
        const prefix = manifestVersion.startsWith("v") ? manifestVersion : `v${manifestVersion}`;
        version = `${prefix}-${shortSha ?? stamp}`;
    } else {
        version = `v${stamp}${shortSha ? `-${shortSha}` : ""}`;
    }

    assertValidVersion(version);
    return version;
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
 * Traverse upward to find the root directory containing package.json
 */
export function findPackageRoot(startDir: string = dirname(fileURLToPath(import.meta.url))): string {
    let current = path.resolve(startDir);
    while (true) {
        if (fs.existsSync(path.join(current, "package.json"))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return startDir;
        }
        current = parent;
    }
}

/**
 * Reads the version from the project's package.json file.
 * @returns {string} The version string from package.json, or 'unknown' if not found.
 */
export function getAppVersion(): string {
    try {
        const root = findPackageRoot();
        const packageJsonPath = path.join(root, "package.json");
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        return packageJson.version || "unknown";
    } catch (error: any) {
        return "unknown";
    }
}


/**
 * Ignore config files from git indexing by adding them to `.gitignore`.
 * Designed to stay flexible for future exclude logic.
 */
export async function updateGitignore() {
    const gitignore = path.resolve(process.cwd(), ".gitignore");
    const entries = configFiles.gitignore;

    // If file does not exist → create with all entries
    if (!(await fs.pathExists(gitignore))) {
        log.warn(".gitignore file not found. Creating a new one...");
        await fs.writeFile(gitignore, entries.join("\n") + "\n", "utf8");
        log.ok(".gitignore created with default entries.");
        return;
    }

    // if file exits then read and update it
    let content = readFileSync(gitignore, "utf8");
    let updated = false;

    for (const entry of entries) {
        if (!content.split(/\r?\n/).includes(entry)) {
            log.debug(`Adding '${entry}' to .gitignore`);
            content += (content.endsWith("\n") ? "" : "\n") + entry + "\n";
            updated = true;
        } else {
            log.debug(`'${entry}' already present in .gitignore`);
        }
    }


    if (updated) {
        await fs.writeFile(gitignore, content, "utf8");
        log.verbose(".gitignore updated with new entries.");
    } else {
        log.verbose(".gitignore already contains all required entries. No changes made.");
    }
}

/**
 * Maps items asynchronously with a concurrency limit.
 */
export async function mapConcurrent<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) return [];
    const concurrency = Math.max(1, Math.min(limit, items.length));
    const results: R[] = new Array(items.length);
    let index = 0;

    const workers = Array.from({ length: concurrency }, async () => {
        while (index < items.length) {
            const currentIndex = index++;
            results[currentIndex] = await fn(items[currentIndex], currentIndex);
        }
    });

    await Promise.all(workers);
    return results;
}
