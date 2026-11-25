import { Client } from "ssh2";
import { posixJoin, escapeShellArg } from "../core/utils.js";
import { exec } from "../core/ssh.js";
import { log } from "../core/logger.js";

export function assertValidSharedItem(item: string): void {
    const clean = item.replace(/\/+$/, "").trim();
    if (
        !clean ||
        clean === "." ||
        clean === ".." ||
        clean.startsWith("/") ||
        clean.startsWith("\\") ||
        clean.split(/[/\\]/).some((segment) => segment === ".." || segment === ".")
    ) {
        throw new Error(
            `Invalid shared item '${item}': must be a relative path strictly contained within the release directory.`
        );
    }
}

export async function linkShared(
    ssh: Client,
    root: string,
    releaseDir: string,
    shared: string[],
    sharedDefaults: Record<string, string> | undefined
) {
    log.debug(`Linking shared files - root: ${root}, releaseDir: ${releaseDir}`);
    log.debug(`Shared items: ${JSON.stringify(shared)}`);
    log.debug(`Shared defaults: ${JSON.stringify(sharedDefaults)}`);

    const sharedDir = posixJoin(root, "shared");
    log.verbose(`Creating shared directory: ${sharedDir}`);
    const mkRes = await exec(ssh, `mkdir -p ${escapeShellArg(sharedDir)}`);
    if (mkRes.code !== 0) {
        throw new Error(
            `Failed to create remote shared directory '${sharedDir}': ${mkRes.stderr.trim() || `exit code ${mkRes.code}`}`
        );
    }

    for (const rawItem of shared) {
        assertValidSharedItem(rawItem);

        // Normalize wildcards like "writable/*" to directory "writable/"
        const item = rawItem.endsWith("/*") ? rawItem.slice(0, -1) : rawItem;
        log.verbose(`Processing shared item: ${item}`);
        const sharedPath = posixJoin(sharedDir, item);
        const releasePath = posixJoin(releaseDir, item);
        const cleanSharedPath = sharedPath.replace(/\/$/, "");
        const cleanReleasePath = releasePath.replace(/\/$/, "");
        const isDirHint = item.endsWith("/") ? "1" : "0";
        log.debug(`Shared path: ${sharedPath}, Release path: ${releasePath}`);

        // Ensure parent directory for sharedPath exists ONLY if item contains subdirectories
        const cleanItem = item.replace(/\/$/, "");
        if (cleanItem.includes("/")) {
            const parentRel = cleanItem.substring(0, cleanItem.lastIndexOf("/"));
            const parentDir = posixJoin(sharedDir, parentRel);
            log.debug(`Ensuring parent directory exists for: ${sharedPath}`);
            const parentRes = await exec(ssh, `mkdir -p ${escapeShellArg(parentDir)}`);
            if (parentRes.code !== 0) {
                throw new Error(
                    `Failed to create parent shared directory '${parentDir}': ${parentRes.stderr.trim() || `exit code ${parentRes.code}`}`
                );
            }
        }

        // If item is expected to be a file, heal any empty directory mistakenly created by prior runs
        if (!item.endsWith("/")) {
            await exec(
                ssh,
                `if [ -d ${escapeShellArg(cleanSharedPath)} ] && [ ! -d ${escapeShellArg(cleanReleasePath)} ]; then rmdir ${escapeShellArg(cleanSharedPath)} 2>/dev/null || true; fi`
            );
        }

        // Check if shared item already exists
        log.debug(`Checking if shared item exists: ${cleanSharedPath}`);
        const { stdout } = await exec(ssh, `[ -e ${escapeShellArg(cleanSharedPath)} ] && echo 1 || echo 0`);
        const exists = stdout.trim() === "1";
        log.debug(`Shared item exists: ${exists}`);

        if (!exists) {
            const defaultSource = sharedDefaults?.[rawItem] ?? sharedDefaults?.[item];
            log.debug(`Default source for ${item}: ${defaultSource}`);

            if (defaultSource) {
                // Seed from specified default source in release (e.g. .env -> .env.example or .env -> env)
                log.verbose(`Seeding shared item from default source: ${defaultSource}`);
                const defaultSourcePath = posixJoin(releaseDir, defaultSource);
                log.debug(`Default source path: ${defaultSourcePath}`);

                await exec(
                    ssh,
                    `if [ -e ${escapeShellArg(defaultSourcePath)} ]; then cp -r ${escapeShellArg(defaultSourcePath)} ${escapeShellArg(cleanSharedPath)}; elif [ "${isDirHint}" = "1" ]; then mkdir -p ${escapeShellArg(sharedPath)}; else touch ${escapeShellArg(sharedPath)}; fi`
                );
                log.debug(`Seeded shared item from default source`);
            } else {
                // 1. If release artifact contains initial files/directories (e.g. writable/cache, writable/logs),
                //    copy them to shared so starter contents are preserved rather than overwritten by an empty dir.
                // 2. Auto-detect if release item is a directory [ -d ... ] even if user omitted trailing slash.
                // 3. If neither exists, fallback to mkdir -p or touch based on trailing slash / directory detection.
                log.verbose(`Initializing shared item from release or defaults: ${item}`);
                await exec(
                    ssh,
                    `if [ -e ${escapeShellArg(cleanReleasePath)} ]; then cp -r ${escapeShellArg(cleanReleasePath)} ${escapeShellArg(cleanSharedPath)}; elif [ -d ${escapeShellArg(cleanReleasePath)} ] || [ "${isDirHint}" = "1" ]; then mkdir -p ${escapeShellArg(sharedPath)}; else touch ${escapeShellArg(sharedPath)}; fi`
                );
                log.debug(`Initialized shared item`);
            }
        } else {
            log.verbose(`Shared item already exists: ${cleanSharedPath}`);
            // If item is a directory (or known app writable dir) and already exists, sync across any missing initial files/subdirectories without overwriting existing files
            if (item.endsWith("/") || cleanItem === "writable" || cleanItem === "storage") {
                await exec(
                    ssh,
                    `if [ -d ${escapeShellArg(cleanReleasePath)} ] && [ -d ${escapeShellArg(cleanSharedPath)} ]; then cp -rn ${escapeShellArg(cleanReleasePath)}/. ${escapeShellArg(cleanSharedPath)}/ 2>/dev/null || rsync -a --ignore-existing ${escapeShellArg(cleanReleasePath)}/ ${escapeShellArg(cleanSharedPath)}/ 2>/dev/null || true; fi`
                );
            }
        }

        // Special handling for CodeIgniter 4 writable directory: ensure standard subdirectories exist
        if (cleanItem === "writable") {
            log.verbose(`Ensuring CodeIgniter 4 writable subdirectories in: ${cleanSharedPath}`);
            await exec(
                ssh,
                `mkdir -p ${escapeShellArg(cleanSharedPath)}/cache ${escapeShellArg(cleanSharedPath)}/logs ${escapeShellArg(cleanSharedPath)}/session ${escapeShellArg(cleanSharedPath)}/uploads ${escapeShellArg(cleanSharedPath)}/debugbar`
            );
        }

        // Special handling for Laravel storage directory: ensure standard subdirectories exist
        if (cleanItem === "storage") {
            log.verbose(`Ensuring Laravel storage subdirectories in: ${cleanSharedPath}`);
            await exec(
                ssh,
                `mkdir -p ${escapeShellArg(cleanSharedPath)}/app/public ${escapeShellArg(cleanSharedPath)}/framework/cache/data ${escapeShellArg(cleanSharedPath)}/framework/sessions ${escapeShellArg(cleanSharedPath)}/framework/views ${escapeShellArg(cleanSharedPath)}/logs`
            );
        }

        // Ensure group-writable permissions (2775 on dirs, 664 on files) for app runtime writable directories
        // so both the deploy CLI user and the web server user (e.g. www-data) can write cache/log files.
        if (cleanItem === "storage" || cleanItem === "writable") {
            log.verbose(`Ensuring group-writable permissions (2775/664) on: ${cleanSharedPath}`);
            await exec(
                ssh,
                `find ${escapeShellArg(cleanSharedPath)} -type d -exec chmod 2775 {} + 2>/dev/null || true; find ${escapeShellArg(cleanSharedPath)} -type f -exec chmod 664 {} + 2>/dev/null || true`
            );
        }

        // Always remove release copy and link to shared
        log.verbose(`Removing release copy and creating symlink for: ${item}`);
        log.debug(`Removing: ${cleanReleasePath}, Linking to: ${cleanSharedPath}`);
        const linkRes = await exec(
            ssh,
            `rm -rf ${escapeShellArg(cleanReleasePath)} && ln -sfn ${escapeShellArg(cleanSharedPath)} ${escapeShellArg(cleanReleasePath)}`
        );
        if (linkRes.code !== 0) {
            throw new Error(
                `Failed to link shared item '${item}' (${cleanReleasePath} -> ${cleanSharedPath}): ${linkRes.stderr.trim() || `exit code ${linkRes.code}`}`
            );
        }
        log.debug(`Successfully linked shared item: ${item}`);
    }

    log.verbose(`Completed linking ${shared.length} shared items`);
}
