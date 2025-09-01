import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close, listDirs, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin } from "../core/utils.js";
import inquirer from "inquirer";

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
        // list releases with timestamps
        const releases = await listDirs(bundle.sftp, releasesDir);
        const sortedReleases = releases.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        if (sortedReleases.length < 2) {
            log.warn(`Not enough releases to rollback (found ${sortedReleases.length}, need at least 2)`);
            return;
        }

        // build choices for prompt
        const choices = sortedReleases.map(r => ({
            name: `${r.name} (${r.mtime.toLocaleString()})${currentTarget.endsWith(r.name) ? " [current]" : ""}`,
            value: posixJoin(releasesDir, r.name),
            disabled: currentTarget.endsWith(r.name) ? "Already active" : false
        }));

        // prompt user
        const { target } = await inquirer.prompt([
            {
                type: "list",
                name: "target",
                message: "Select a release to rollback to:",
                choices
            }
        ]);

        // switch symlink
        const targetVersion = target.split("/").pop();
        log.info(`Rolling back to: ${targetVersion}`);
        await exec(bundle.ssh, `ln -sfn "${target}" "${currentLink}"`);
        log.ok(`Successfully rolled back to ${targetVersion}`);
    } finally {
        log.verbose(`Closing SSH connection`);
        await close(bundle);
    }
}
