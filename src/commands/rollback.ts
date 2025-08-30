import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close, listDirs, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin } from "../core/utils.js";

export async function rollback(opts: { env?: string }) {
    log.debug(`Rollback command started with options: ${JSON.stringify(opts)}`);

    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);

    const env = cfg.environments[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);

    const releasesDir = posixJoin(env.deployTo, "releases");
    const currentLink = posixJoin(env.deployTo, "current");
    log.debug(`Releases directory: ${releasesDir}, Current link: ${currentLink}`);

    log.info(`Connecting to ${env.username}@${env.host} to perform rollback`);
    const bundle = await connect(env);
    try {
        log.verbose(`Reading current symlink target`);
        const { stdout } = await exec(bundle.ssh, `readlink -f "${currentLink}" || true`);
        const currentTarget = stdout.trim();
        log.debug(`Current symlink target: ${currentTarget}`);

        log.verbose(`Listing available releases`);
        const releases = (await listDirs(bundle.sftp, releasesDir)).sort();
        log.debug(`Available releases: ${JSON.stringify(releases)}`);

        if (releases.length < 2) {
            log.warn(`Not enough releases to rollback (found ${releases.length}, need at least 2)`);
            return;
        }

        log.verbose(`Finding previous release to rollback to`);
        let target: string | undefined;
        for (let i = releases.length - 1; i >= 0; i--) {
            const candidate = posixJoin(releasesDir, releases[i]);
            log.debug(`Checking candidate: ${candidate} vs current: ${currentTarget}`);
            if (!currentTarget || candidate !== currentTarget) {
                target = candidate;
                log.debug(`Selected rollback target: ${target}`);
                break;
            }
        }

        if (!target) {
            log.warn("No previous release found to rollback to");
            return;
        }

        const targetVersion = target.split("/").pop();
        log.info(`Rolling back from current to: ${targetVersion}`);
        await exec(bundle.ssh, `ln -sfn "${target}" "${currentLink}"`);
        log.ok(`Successfully rolled back to ${targetVersion}`);
    } finally {
        log.verbose(`Closing SSH connection`);
        await close(bundle);
    }
}
