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

    for (const item of shared) {
        log.verbose(`Processing shared item: ${item}`);
        const sharedPath = posixJoin(sharedDir, item);
        const releasePath = posixJoin(releaseDir, item);
        log.debug(`Shared path: ${sharedPath}, Release path: ${releasePath}`);

        // Ensure parent directory for sharedPath exists
        const parentDir = posixJoin(sharedDir, item.replace(/\/[^/]*$/, ""));
        log.debug(`Ensuring parent directory exists for: ${sharedPath}`);
        await exec(ssh, `mkdir -p ${escapeShellArg(parentDir)}`);

        // Check if shared already exists
        log.debug(`Checking if shared item exists: ${sharedPath}`);
        const { stdout } = await exec(ssh, `[ -e ${escapeShellArg(sharedPath)} ] && echo 1 || echo 0`);
        const exists = stdout.trim() === "1";
        log.debug(`Shared item exists: ${exists}`);

        if (!exists) {
            const defaultSource = sharedDefaults?.[item];
            log.debug(`Default source for ${item}: ${defaultSource}`);

            if (defaultSource) {
                // seed from artifact release
                log.verbose(`Seeding shared item from default source: ${defaultSource}`);
                const defaultSourcePath = posixJoin(releaseDir, defaultSource);
                log.debug(`Default source path: ${defaultSourcePath}`);

                await exec(
                    ssh,
                    `if [ -e ${escapeShellArg(defaultSourcePath)} ]; then cp -r ${escapeShellArg(defaultSourcePath)} ${escapeShellArg(sharedPath)}; else touch ${escapeShellArg(sharedPath)}; fi`
                );
                log.debug(`Seeded shared item from default source`);
            } else {
                // create empty dir or file
                log.verbose(`Creating empty shared item: ${item}`);
                if (item.endsWith("/")) {
                    await exec(ssh, `mkdir -p ${escapeShellArg(sharedPath)}`);
                } else {
                    await exec(ssh, `touch ${escapeShellArg(sharedPath)}`);
                }
                log.debug(`Created empty shared item`);
            }
        } else {
            log.verbose(`Shared item already exists, skipping creation`);
        }

        // Always remove release copy and link to shared
        // Strip trailing slash for symlink paths to avoid ln command issues
        const cleanSharedPath = sharedPath.replace(/\/$/, "");
        const cleanReleasePath = releasePath.replace(/\/$/, "");

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
