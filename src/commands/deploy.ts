import path from "node:path";
import os from "node:os";
import { loadConfig, getEnvName, EnvironmentConfig, DeployConfig } from "../core/config.js";
import { detectVersion, posixJoin, safeExec, escapeShellArg } from "../core/utils.js";
import { buildArtifact, planBuildArtifact } from "../features/packager.js";
import { connect, close, ensureRemoteDirs, exec, uploadFile, switchCurrentSymlink } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { linkShared } from "../features/shared.js";
import { runLocalHooks, runRemoteHooks } from "../core/hooks.js";
import { cleanupReleases } from "../features/cleaner.js";
import { resolveDeployArtifact } from "../features/deploy-artifact.js";
import { verifyArtifactChecksum } from "../features/checksum.js";
import { performHealthCheckWithRetry } from "./health.js";
import fs from "fs-extra";
import { mkdtemp } from "node:fs/promises";
import { createReleaseMetadata, RELEASE_METADATA_FILE } from "../features/release-metadata.js";
import { enableMaintenance, disableMaintenance } from "../features/maintenance.js";
import { executeDatabaseBackup, DatabaseBackupConfig } from "../features/database-backup.js";
import { dispatchNotifications, NotificationPayload, NotificationTarget } from "../features/notifications.js";

export interface DeployOptions {
    env?: string;
    artifact?: string;
    archive?: string;
    version?: string;
    versionOverride?: string;
    dryRun?: boolean;
    skipBuild?: boolean;
    keepArtifact?: boolean;
    autoRollback?: boolean;
    healthGate?: boolean;
    healthRetries?: number;
    maintenance?: boolean;
    backupDb?: boolean;
    strategy?: "parallel" | "rolling";
}

/**
 * Execute deployment against a single target host.
 */
async function deployToHost(params: {
    targetHost: string;
    targetEnv: EnvironmentConfig;
    envName: string;
    version: string;
    artifactPath: string;
    opts: DeployOptions;
    cfg: DeployConfig;
    cwd: string;
    sharedItems: string[];
    sharedDefaults?: Record<string, string>;
    cleanAfterDeploy: boolean;
    isMaintenanceEnabled: boolean;
    isBackupDbEnabled: boolean;
    dbConfig?: DatabaseBackupConfig;
}) {
    const {
        targetHost,
        targetEnv,
        envName,
        version,
        artifactPath,
        opts,
        cfg,
        sharedItems,
        sharedDefaults,
        cleanAfterDeploy,
        isMaintenanceEnabled,
        isBackupDbEnabled,
        dbConfig,
    } = params;

    const remoteRoot = targetEnv.deployTo!.trim();
    const releases = posixJoin(remoteRoot, "releases");
    const currentLink = posixJoin(remoteRoot, "current");
    const tmp = posixJoin(remoteRoot, "tmp");
    const releaseDir = posixJoin(releases, version);
    const remoteTar = posixJoin(tmp, `release-${version}.tar.gz`);

    if (opts.dryRun) {
        log.info(`[dry-run] [${targetHost}] Would connect to ${targetEnv.username}@${targetHost}`);
        log.info(`[dry-run] [${targetHost}] Would upload ${path.basename(artifactPath)} to ${remoteTar}`);
        log.info(`[dry-run] [${targetHost}] Would write ${RELEASE_METADATA_FILE} into the release directory`);
        log.info(`[dry-run] [${targetHost}] Would extract into ${releaseDir}`);
        if (sharedItems.length) {
            log.info(`[dry-run] [${targetHost}] Would link shared items: ${sharedItems.join(", ")}`);
        }
        if (cfg.hooks?.preDeploy?.length) {
            log.info(`[dry-run] [${targetHost}] Would run ${cfg.hooks.preDeploy.length} preDeploy hook(s)`);
        }
        log.info(`[dry-run] [${targetHost}] Would switch 'current' symlink to ${releaseDir}`);
        if (cfg.hooks?.postDeploy?.length) {
            log.info(`[dry-run] [${targetHost}] Would run ${cfg.hooks.postDeploy.length} postDeploy hook(s)`);
        }
        log.info(`[dry-run] [${targetHost}] Would cleanup releases (keeping ${targetEnv.keepVersions ?? 5})`);
        return;
    }

    log.info(`Deploying to ${targetEnv.username}@${targetHost}:${remoteRoot}`);
    const hostEnvConfig = { ...targetEnv, host: targetHost };
    const spin = log.spinner(`[${targetHost}] Connecting to ${targetEnv.username}@${targetHost}`);
    const bundle = await connect(hostEnvConfig).catch((e) => {
        spin.fail(`[${targetHost}] SSH connect failed`);
        log.err(e.message || String(e));
        throw e;
    });
    spin.succeed(`[${targetHost}] Connected`);

    try {
        log.verbose(`[${targetHost}] Ensuring remote directories exist`);
        await ensureRemoteDirs(bundle.ssh, releases, tmp);

        log.verbose(`[${targetHost}] Uploading artifact to remote server`);
        await uploadFile(bundle.sftp, artifactPath, remoteTar, {
            label: `[${targetHost}] Uploading artifact (${path.basename(artifactPath)})`,
            showProgress: true,
        });

        log.verbose(`[${targetHost}] Verifying uploaded artifact checksum`);
        const checksum = log.spinner(`[${targetHost}] Verifying checksum...`);
        try {
            const { localHash, remoteHash } = await verifyArtifactChecksum({
                ssh: bundle.ssh,
                localPath: artifactPath,
                remotePath: remoteTar,
            });
            checksum.succeed(`[${targetHost}] Checksum verified`);
            log.ok(`[${targetHost}] Checksum verified (${localHash.slice(0, 12)}...)`);
        } catch (error) {
            checksum.fail(`[${targetHost}] Checksum verification failed`);
            throw error;
        }

        // Extract release
        const extract = log.spinner(`[${targetHost}] Extracting release...`);
        const { code, stderr } = await exec(
            bundle.ssh,
            `mkdir -p ${escapeShellArg(releaseDir)} && tar -xzf ${escapeShellArg(remoteTar)} -C ${escapeShellArg(releaseDir)} && rm -f ${escapeShellArg(remoteTar)}`
        );
        if (code !== 0) throw new Error(stderr || "remote extract failed");
        extract.succeed(`[${targetHost}] Extracted ${version}`);

        // Ensure framework runtime cache directories (e.g. Laravel bootstrap/cache) are group-writable
        // so both the deploy CLI user and the web server user (e.g. www-data) can write compiled manifests.
        const bootstrapCacheDir = posixJoin(releaseDir, "bootstrap/cache");
        await exec(
            bundle.ssh,
            `if [ -d ${escapeShellArg(bootstrapCacheDir)} ]; then find ${escapeShellArg(bootstrapCacheDir)} -type d -exec chmod 2775 {} + 2>/dev/null || true; find ${escapeShellArg(bootstrapCacheDir)} -type f -exec chmod 664 {} + 2>/dev/null || true; fi`
        );

        // Automated Pre-Deploy Database Backup
        if (isBackupDbEnabled && dbConfig) {
            const spinDb = log.spinner(`[${targetHost}] Creating pre-deploy database backup...`);
            try {
                const backupPath = await executeDatabaseBackup(bundle.ssh, remoteRoot, version, dbConfig, releaseDir);
                spinDb.succeed(`[${targetHost}] Pre-deploy database backup created (${path.posix.basename(backupPath)})`);
            } catch (dbErr: any) {
                spinDb.fail(`[${targetHost}] Database backup failed`);
                throw new Error(`Deployment aborted: ${dbErr.message}`);
            }
        }

        // Automatic Maintenance Mode
        if (isMaintenanceEnabled) {
            log.info(`[${targetHost}] Putting site into maintenance mode during deployment...`);
            await enableMaintenance(bundle.ssh, remoteRoot, {
                message: `Deploying release ${version}. We'll be right back!`,
                retryAfter: 120,
            });
        }

        // Link shared items
        if (sharedItems.length) {
            log.verbose(`[${targetHost}] Linking ${sharedItems.length} shared items`);
            const spinShared = log.spinner(`[${targetHost}] Linking shared items...`);
            await linkShared(bundle.ssh, remoteRoot, releaseDir, sharedItems, sharedDefaults);
            spinShared.succeed(`[${targetHost}] Linking completed for ${sharedItems.length} shared items`);
        }

        // Run PreDeploy hooks
        await runRemoteHooks(bundle.ssh, "preDeploy", cfg.hooks?.preDeploy, releaseDir);

        // Capture previous release target for safe health-gate auto-rollback
        const { stdout: previousTargetRaw } = await exec(bundle.ssh, `readlink ${escapeShellArg(currentLink)} || true`);
        const previousTarget = previousTargetRaw.trim() || null;

        // Switch current symlink atomically
        log.info(`[${targetHost}] Activating new release...`);
        await switchCurrentSymlink(bundle.ssh, releaseDir, currentLink);
        log.ok(`[${targetHost}] Activated ${version}`);

        // Run PostDeploy hooks
        await runRemoteHooks(bundle.ssh, "postDeploy", cfg.hooks?.postDeploy, releaseDir);

        // Disable Maintenance Mode
        if (isMaintenanceEnabled) {
            log.info(`[${targetHost}] Disabling deployment maintenance mode...`);
            await disableMaintenance(bundle.ssh, remoteRoot);
            log.ok(`[${targetHost}] Maintenance mode disabled`);
        }

        // Optional post-deployment health check & auto-rollback gating
        const baseUrl = targetEnv.baseUrl || process.env.DPLOY_BASE_URL;
        if (baseUrl) {
            const healthPath = targetEnv.healthCheckPath || "/health";
            const url = new URL(healthPath, baseUrl).toString();
            const timeoutMs = Number(targetEnv.healthCheckTimeout ?? process.env.DPLOY_HEALTH_CHECK_TIMEOUT ?? 10000);
            const retries = Number(opts.healthRetries ?? targetEnv.healthCheckRetries ?? 3);
            const intervalMs = Number(targetEnv.healthCheckInterval ?? 2000);
            const isGated = opts.healthGate !== false && targetEnv.healthGate !== false;
            const shouldAutoRollback = opts.autoRollback !== false && targetEnv.autoRollback !== false;

            log.info(`[${targetHost}] Verifying deployment health: GET ${url}`);
            const spinHealth = log.spinner(`[${targetHost}] Verifying service health...`);

            const healthResult = await performHealthCheckWithRetry(url, {
                timeoutMs,
                retries,
                intervalMs,
                onRetry: (err, attempt, nextDelay) => {
                    log.warn(`[${targetHost}] Health check attempt ${attempt}/${retries} failed (${err.message}). Retrying in ${nextDelay}ms...`);
                },
            });

            if (healthResult.ok) {
                spinHealth.succeed(`[${targetHost}] Post-deployment health check passed (${healthResult.status})`);
            } else {
                spinHealth.fail(`[${targetHost}] Post-deployment health check failed (status: ${healthResult.status || "unreachable"})`);
                log.err(`[${targetHost}] Health check failed for ${url}: status ${healthResult.status || "unreachable"}`);

                if (isGated) {
                    if (shouldAutoRollback && previousTarget) {
                        log.warn(`[${targetHost}] Initiating automatic rollback to previous release (${path.posix.basename(previousTarget)})...`);
                        const spinRollback = log.spinner(`[${targetHost}] Rolling back symlink to previous release...`);
                        await switchCurrentSymlink(bundle.ssh, previousTarget, currentLink);
                        spinRollback.succeed(`[${targetHost}] Rolled back 'current' symlink to ${path.posix.basename(previousTarget)}`);
                        throw new Error(
                            `Health gate failed on ${targetHost}: GET ${url} returned status ${healthResult.status || "unreachable"}. Automatically rolled back to ${path.posix.basename(previousTarget)}.`
                        );
                    } else if (shouldAutoRollback && !previousTarget) {
                        throw new Error(
                            `Health gate failed on ${targetHost}: GET ${url} returned status ${healthResult.status || "unreachable"}. No previous release available to rollback.`
                        );
                    } else {
                        throw new Error(
                            `Health gate failed on ${targetHost}: GET ${url} returned status ${healthResult.status || "unreachable"}.`
                        );
                    }
                }
            }
        }

        // Upload release metadata
        const metadataTmpDir = await mkdtemp(path.join(os.tmpdir(), "dploy-release-"));
        const metadataTmpFile = path.join(metadataTmpDir, RELEASE_METADATA_FILE);
        const metadata = createReleaseMetadata({
            version,
            environment: envName,
            gitCommit: safeExec("git rev-parse HEAD") ?? null,
            deployedAt: new Date(),
            artifactName: path.basename(artifactPath),
        });
        try {
            await fs.writeJson(metadataTmpFile, metadata, { spaces: 2 });
            await uploadFile(bundle.sftp, metadataTmpFile, posixJoin(releaseDir, RELEASE_METADATA_FILE), {
                showProgress: false,
            });
        } finally {
            await fs.remove(metadataTmpDir);
        }

        // Clean old releases
        const keep = targetEnv.keepVersions ?? 5;
        log.verbose(`[${targetHost}] Cleaning old releases, keeping ${keep} versions`);
        await cleanupReleases(bundle, releases, keep, { strict: true });
        if (cleanAfterDeploy && tmp && tmp !== "/") {
            log.verbose(`[${targetHost}] Cleaning temporary uploaded directory & files`);
            await exec(bundle.ssh, `rm -rf ${escapeShellArg(tmp)}`);
        }
    } finally {
        log.verbose(`[${targetHost}] Closing SSH connection`);
        await close(bundle);
    }
}

export async function deploy(opts: DeployOptions) {
    const startTime = Date.now();
    log.debug(`Deploy command started with options: ${JSON.stringify(opts)}`);

    const cwd = process.cwd();
    const cfg = await loadConfig(cwd);
    const envName = getEnvName(opts.env);
    log.verbose(`Using environment: ${envName}`);

    const env = cfg.environments?.[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);
    if (!env.deployTo || typeof env.deployTo !== "string" || !env.deployTo.trim()) {
        throw new Error(`Environment '${envName}' is missing required 'deployTo' path`);
    }
    const remoteRoot = env.deployTo.trim();
    if (remoteRoot === "/") {
        throw new Error(`Invalid deployTo path: cannot deploy directly to root '/'`);
    }

    // Determine target hosts
    const hosts: string[] = env.hosts && env.hosts.length > 0 ? env.hosts : env.host ? [env.host] : [];
    if (hosts.length === 0) {
        throw new Error(`Environment '${envName}' has no target host(s) configured`);
    }

    const clusterStrategy = opts.strategy ?? env.strategy ?? "parallel";
    const sharedItems: string[] = cfg.shared ?? cfg.build?.shared ?? [];
    const sharedDefaults: Record<string, string> | undefined = cfg.sharedDefaults ?? cfg.build?.sharedDefaults;
    const cleanAfterDeploy: boolean = cfg.cleanAfterDeploy ?? cfg.build?.cleanAfterDeploy ?? false;
    const keepLocalArtifact: boolean = opts.keepArtifact ?? cfg.keepArtifact ?? env.keepArtifact ?? false;
    const isMaintenanceEnabled: boolean = opts.maintenance ?? cfg.maintenanceMode ?? env.maintenanceMode ?? false;
    const isBackupDbEnabled: boolean = opts.backupDb ?? cfg.database?.enabled ?? env.database?.enabled ?? false;
    const dbConfig: DatabaseBackupConfig | undefined = env.database ?? cfg.database;
    const notificationTargets: NotificationTarget[] | undefined = env.notifications ?? cfg.notifications;

    const gitCommit = safeExec("git rev-parse HEAD") ?? null;
    const commitMessage = safeExec("git log -1 --pretty=%B")?.trim() ?? null;
    const deployer = process.env.USER || process.env.USERNAME || "unknown";

    const version = detectVersion({
        override: opts.versionOverride || opts.version,
        versionCommand: cfg.versionCommand,
        versionFile: cfg.versionFile,
    });
    log.verbose(`Deployment version: ${version}`);

    const baseNotificationPayload: Omit<NotificationPayload, "event"> = {
        environment: envName,
        version,
        host: hosts.join(", "),
        gitCommit,
        commitMessage,
        deployer,
    };

    if (hosts.length > 1) {
        log.info(`Starting cluster deployment to [${envName}] (${hosts.length} hosts: ${hosts.join(", ")}) [strategy: ${clusterStrategy}]`);
    } else {
        log.info(`Starting deployment to [${envName}] environment (${hosts[0]})`);
    }

    // Dispatch "start" notification
    if (!opts.dryRun) {
        await dispatchNotifications(notificationTargets, {
            ...baseNotificationPayload,
            event: "start",
        });
    }

    const customArtifact = opts.artifact ?? opts.archive;
    const shouldBuild = !customArtifact && !opts.skipBuild;
    let artifactPath: string;

    if (opts.dryRun) {
        if (shouldBuild) {
            const plan = await planBuildArtifact({
                cwd,
                buildDir: cfg.build?.buildDir,
                version,
                cfg,
            });

            log.info(`[dry-run] Would package ${plan.files.length} file(s) into ${path.basename(plan.artifactPath)}`);
            if (cfg.hooks?.preBuild?.length) {
                log.info(`[dry-run] Would run ${cfg.hooks.preBuild.length} local preBuild hook(s)`);
            } else {
                log.info(`[dry-run] No local preBuild hooks configured`);
            }
            if (cfg.hooks?.postBuild?.length) {
                log.info(`[dry-run] Would run ${cfg.hooks.postBuild.length} local postBuild hook(s)`);
            } else {
                log.info(`[dry-run] No local postBuild hooks configured`);
            }
            artifactPath = plan.artifactPath;
        } else {
            const selection = await resolveDeployArtifact({
                cwd,
                cfg,
                version,
                artifact: opts.artifact,
                archive: opts.archive,
                skipBuild: opts.skipBuild,
                strict: false,
            });
            artifactPath = selection.artifactPath;
            log.info(`[dry-run] Would skip build phase`);
            log.info(`[dry-run] Would use ${selection.source === "custom" ? "provided artifact" : "existing prebuilt artifact"}: ${path.basename(artifactPath)}`);
        }
    } else if (shouldBuild) {
        log.info(`No artifact provided, building from source`);

        log.verbose(`Running pre-build hooks`);
        await runLocalHooks("preBuild", cfg.hooks?.preBuild);

        const result = await buildArtifact({
            cwd,
            buildDir: cfg.build?.buildDir,
            version,
            cfg,
        });
        artifactPath = result.artifactPath;

        log.debug(`Artifact built successfully: ${artifactPath}`);
        log.verbose(`Running post-build hooks`);
        await runLocalHooks("postBuild", cfg.hooks?.postBuild);
    } else {
        const selection = await resolveDeployArtifact({
            cwd,
            cfg,
            version,
            artifact: opts.artifact,
            archive: opts.archive,
            skipBuild: opts.skipBuild,
            strict: true,
        });
        artifactPath = selection.artifactPath;
        log.info(selection.source === "custom" ? `Using provided artifact: ${path.basename(artifactPath)}` : `Using prebuilt artifact: ${path.basename(artifactPath)}`);
        log.verbose(`Using artifact path: ${artifactPath}`);
    }

    try {
        const hostDeployParams = (targetHost: string) => ({
            targetHost,
            targetEnv: env,
            envName,
            version,
            artifactPath,
            opts,
            cfg,
            cwd,
            sharedItems,
            sharedDefaults,
            cleanAfterDeploy,
            isMaintenanceEnabled,
            isBackupDbEnabled,
            dbConfig,
        });

        if (clusterStrategy === "rolling" && hosts.length > 1) {
            log.info(`Executing rolling deployment across ${hosts.length} hosts`);
            for (let i = 0; i < hosts.length; i++) {
                const targetHost = hosts[i];
                log.info(`[rolling ${i + 1}/${hosts.length}] Deploying to host: ${targetHost}`);
                await deployToHost(hostDeployParams(targetHost));
                log.ok(`[rolling ${i + 1}/${hosts.length}] Host ${targetHost} deployment complete`);
            }
        } else {
            // Parallel deployment (default)
            if (hosts.length > 1) {
                log.info(`Executing parallel deployment across ${hosts.length} hosts`);
            }
            await Promise.all(hosts.map((targetHost) => deployToHost(hostDeployParams(targetHost))));
        }

        const durationMs = Date.now() - startTime;
        log.ok(`Successfully deployed release ${version} to [${envName}] (${hosts.length} host(s)) in ${(durationMs / 1000).toFixed(1)}s`);

        if (!opts.dryRun) {
            await dispatchNotifications(notificationTargets, {
                ...baseNotificationPayload,
                event: "success",
                durationMs,
            });
        }

        // Clean up or keep local artifact
        if (shouldBuild && artifactPath) {
            if (!keepLocalArtifact) {
                log.verbose(`Cleaning up local build artifact: ${artifactPath}`);
                await fs.remove(artifactPath).catch(() => {});
            } else {
                log.ok(`Preserved local build artifact: ${path.basename(artifactPath)}`);
            }
        }
    } catch (deployErr: any) {
        const durationMs = Date.now() - startTime;
        const isRollback = deployErr?.message?.includes("rolled back") || deployErr?.message?.includes("rollback");
        const eventType = isRollback ? "rollback" : "failure";

        if (!opts.dryRun) {
            await dispatchNotifications(notificationTargets, {
                ...baseNotificationPayload,
                event: eventType,
                durationMs,
                error: deployErr?.message || String(deployErr),
            });
        }

        throw deployErr;
    }
}
