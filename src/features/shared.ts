import { Client } from "ssh2";
import { posixJoin } from "../core/utils.js";
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
    await exec(ssh, `mkdir -p "${sharedDir}"`);

    for (const item of shared) {
        log.verbose(`Processing shared item: ${item}`);
        const sharedPath = posixJoin(sharedDir, item);
        const releasePath = posixJoin(releaseDir, item);
        log.debug(`Shared path: ${sharedPath}, Release path: ${releasePath}`);

        // Ensure parent directory for sharedPath exists
        log.debug(`Ensuring parent directory exists for: ${sharedPath}`);
        await exec(ssh, `mkdir -p "$(dirname \\"${sharedPath}\\")"`);

        // Check if shared already exists
        log.debug(`Checking if shared item exists: ${sharedPath}`);
        const { stdout } = await exec(ssh, `[ -e "${sharedPath}" ] && echo 1 || echo 0`);
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
                    `if [ -e "${defaultSourcePath}" ]; then cp -r "${defaultSourcePath}" "${sharedPath}"; else touch "${sharedPath}"; fi`
                );
                log.debug(`Seeded shared item from default source`);
            } else {
                // create empty dir or file
                log.verbose(`Creating empty shared item: ${item}`);
                await exec(
                    ssh,
                    `if [[ "${item}" == */ ]]; then mkdir -p "${sharedPath}"; else touch "${sharedPath}"; fi`
                );
                log.debug(`Created empty shared item`);
            }
        } else {
            log.verbose(`Shared item already exists, skipping creation`);
        }

        // Always remove release copy and link to shared
        log.verbose(`Removing release copy and creating symlink for: ${item}`);
        log.debug(`Removing: ${releasePath}, Linking to: ${sharedPath}`);
        await exec(
            ssh,
            `rm -rf "${releasePath}" && ln -sfn "${sharedPath}" "${releasePath}"`
        );
        log.debug(`Successfully linked shared item: ${item}`);
    }

    log.verbose(`Completed linking ${shared.length} shared items`);
}
