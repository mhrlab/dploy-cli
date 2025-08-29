import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close, listDirs, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin } from "../core/utils.js";

export async function rollback(opts: { env?: string }) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);

    const releasesDir = posixJoin(env.deployTo, "releases");
    const currentLink = posixJoin(env.deployTo, "current");

    const bundle = await connect(env);
    try {
        const { stdout } = await exec(bundle.ssh, `readlink -f "${currentLink}" || true`);
        const currentTarget = stdout.trim();

        const releases = (await listDirs(bundle.sftp, releasesDir)).sort();
        if (releases.length < 2) {
            log.warn("Not enough releases to rollback");
            return;
        }

        let target: string | undefined;
        for (let i = releases.length - 1; i >= 0; i--) {
            const candidate = posixJoin(releasesDir, releases[i]);
            if (!currentTarget || candidate !== currentTarget) {
                target = candidate;
                break;
            }
        }
        if (!target) {
            log.warn("No previous release found");
            return;
        }

        await exec(bundle.ssh, `ln -sfn "${target}" "${currentLink}"`);
        log.ok(`Rolled back to ${target.split("/").pop()}`);
    } finally {
        await close(bundle);
    }
}
