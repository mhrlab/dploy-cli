import { Client } from "ssh2";
import { posixJoin, escapeShellArg } from "../core/utils.js";
import { exec } from "../core/ssh.js";
import { log } from "../core/logger.js";

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
    await exec(ssh, `mkdir -p ${escapeShellArg(sharedDir)}`);

    for (const rawItem of shared) {
        // Normalize wildcards like "writable/*" to directory "writable/"
        const item = rawItem.endsWith("/*") ? rawItem.slice(0, -1) : rawItem;
        log.verbose(`Processing shared item: ${item}`);
        const sharedPath = posixJoin(sharedDir, item);
        const releasePath = posixJoin(releaseDir, item);
        const cleanSharedPath = sharedPath.replace(/\/$/, "");
        const cleanReleasePath = releasePath.replace(/\/$/, "");
        const isDirHint = item.endsWith("/") ? "1" : "0";
        log.debug(`Shared path: ${sharedPath}, Release path: ${releasePath}`);

        // Ensure parent directory for sharedPath exists
        const parentDir = posixJoin(sharedDir, item.replace(/\/$/, "").replace(/\/[^/]*$/, ""));
        log.debug(`Ensuring parent directory exists for: ${sharedPath}`);
        await exec(ssh, `mkdir -p ${escapeShellArg(parentDir)}`);

        // Check if shared item already exists
        log.debug(`Checking if shared item exists: ${cleanSharedPath}`);
        const { stdout } = await exec(ssh, `[ -e ${escapeShellArg(cleanSharedPath)} ] && echo 1 || echo 0`);
        const exists = stdout.trim() === "1";
        log.debug(`Shared item exists: ${exists}`);

        if (!exists) {
            const defaultSource = sharedDefaults?.[rawItem] ?? sharedDefaults?.[item];
            log.debug(`Default source for ${item}: ${defaultSource}`);

            if (defaultSource) {
                // Seed from specified default source in release (e.g. .env -> .env.example)
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
            log.verbose(`Shared item already exists, skipping creation`);
        }

        // Always remove release copy and link to shared
        log.verbose(`Removing release copy and creating symlink for: ${item}`);
        log.debug(`Removing: ${cleanReleasePath}, Linking to: ${cleanSharedPath}`);
        await exec(
            ssh,
            `rm -rf ${escapeShellArg(cleanReleasePath)} && ln -sfn ${escapeShellArg(cleanSharedPath)} ${escapeShellArg(cleanReleasePath)}`
        );
        log.debug(`Successfully linked shared item: ${item}`);
    }

    log.verbose(`Completed linking ${shared.length} shared items`);
}
