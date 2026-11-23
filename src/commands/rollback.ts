import { loadConfig, getEnvName } from "../core/config.js";
import { connect, close, switchCurrentSymlink } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { posixJoin } from "../core/utils.js";
import { collectRemoteStatus } from "../features/status.js";
import { currentReleaseNameFromTarget, resolveRollbackTarget } from "../features/rollback.js";
import inquirer from "inquirer";

export async function rollback(opts: {
    env?: string;
    latest?: boolean;
    to?: string;
    dryRun?: boolean;
    yes?: boolean;
    nonInteractive?: boolean;
}) {
    log.debug(`Rollback command started with options: ${JSON.stringify(opts)}`);

    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);

    const env = cfg.environments?.[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);
    if (!env.deployTo) throw new Error(`Environment '${envName}' is missing deployTo`);

    const releasesDir = posixJoin((env.deployTo ? env.deployTo : ''), "releases");
    const currentLink = posixJoin((env.deployTo ? env.deployTo : ''), "current");
    log.debug(`Releases directory: ${releasesDir}, Current link: ${currentLink}`);

    log.info(`Connecting to ${env.username}@${env.host} to perform rollback`);
    const spin = log.spinner(`Connecting to ${env.username}@${env.host}`);
    const bundle = await connect(env).catch((e) => {
        spin.fail("SSH connect failed");
        log.err(e.message || String(e));
        throw e;
    });
    spin.succeed("Connected");
    try {
        const remoteStatus = await collectRemoteStatus(bundle, envName, env.deployTo);
        const sortedReleases = remoteStatus.releases;
        const currentRelease = currentReleaseNameFromTarget(remoteStatus.currentTarget);
        log.debug(`Current symlink target: ${remoteStatus.currentTarget ?? ""}`);
        log.debug(`Current release: ${currentRelease ?? ""}`);

        if (!sortedReleases.length) {
            log.warn("No releases found");
            return;
        }

        const wantsAutomaticTarget = !!opts.latest || !!opts.to;
        const isNonInteractive = !!opts.yes || !!opts.nonInteractive || !process.stdin.isTTY;

        if (sortedReleases.length < 2 && !opts.to && !opts.latest) {
            log.warn(`Not enough releases to rollback (found ${sortedReleases.length}, need at least 2)`);
            return;
        }

        let targetRelease = resolveRollbackTarget(sortedReleases, currentRelease, {
            latest: opts.latest,
            to: opts.to,
        });

        if (!targetRelease) {
            if (wantsAutomaticTarget) {
                log.warn("No rollback target could be resolved");
                return;
            }

            if (isNonInteractive) {
                log.info("Non-interactive mode enabled: selecting previous release automatically");
                targetRelease = resolveRollbackTarget(sortedReleases, currentRelease, { latest: true });
                if (!targetRelease) {
                    throw new Error("No previous release available for non-interactive rollback");
                }
            } else {
                const choices = sortedReleases.map((release) => ({
                    name: `${release.name} (${release.mtime.toLocaleString()})${release.name === currentRelease ? " [current]" : ""}`,
                    value: release.name,
                    disabled: release.name === currentRelease ? "Already active" : false,
                }));

                const { target } = await inquirer.prompt([
                    {
                        type: "list",
                        name: "target",
                        message: "Select a release to rollback to:",
                        choices,
                    },
                ]);

                targetRelease = sortedReleases.find((release) => release.name === target) ?? null;
            }
        }

        if (!targetRelease) {
            log.warn("No rollback target could be selected");
            return;
        }

        if (targetRelease.name === currentRelease) {
            log.warn(`${targetRelease.name} is already active`);
            return;
        }

        const targetPath = posixJoin(releasesDir, targetRelease.name);

        if (opts.dryRun) {
            log.ok(`Dry run: would roll back to ${targetRelease.name}`);
            log.info(`Would switch ${currentLink} -> ${targetPath}`);
            return;
        }

        log.info(`Rolling back to: ${targetRelease.name}`);
        await switchCurrentSymlink(bundle.ssh, targetPath, currentLink);
        log.ok(`Successfully rolled back to ${targetRelease.name}`);
    } finally {
        log.verbose(`Closing SSH connection`);
        await close(bundle);
    }
}
