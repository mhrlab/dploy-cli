import { Client } from "ssh2";
import { posixJoin } from "../core/utils.js";
import { exec } from "../core/ssh.js";

export async function linkShared(
    ssh: Client,
    root: string,
    releaseDir: string,
    shared: string[],
    sharedDefaults: Record<string, string> | undefined
) {
    const sharedDir = posixJoin(root, "shared");
    await exec(ssh, `mkdir -p "${sharedDir}"`);

    for (const item of shared) {
        const sharedPath = posixJoin(sharedDir, item);
        const releasePath = posixJoin(releaseDir, item);

        // Ensure parent directory for sharedPath exists
        await exec(ssh, `mkdir -p "$(dirname \\"${sharedPath}\\")"`);

        // Check if shared already exists
        const { stdout } = await exec(ssh, `[ -e "${sharedPath}" ] && echo 1 || echo 0`);
        const exists = stdout.trim() === "1";

        if (!exists) {
            const defaultSource = sharedDefaults?.[item];
            if (defaultSource) {
                // seed from artifact release
                await exec(
                    ssh,
                    `if [ -e "${posixJoin(releaseDir, defaultSource)}" ]; then cp -r "${posixJoin(
                        releaseDir,
                        defaultSource
                    )}" "${sharedPath}"; else touch "${sharedPath}"; fi`
                );
            } else {
                // create empty dir or file
                await exec(
                    ssh,
                    `if [[ "${item}" == */ ]]; then mkdir -p "${sharedPath}"; else touch "${sharedPath}"; fi`
                );
            }
        }

        // Always remove release copy and link to shared
        // await exec(ssh, `rm -rf "${releasePath}" && ln -s "${sharedPath}" "${releasePath}"`);
        await exec(
            ssh,
            `rm -rf "${releasePath}" && ln -sfn "${sharedPath}" "${releasePath}"`
        );
    }
}
