import path from "node:path";
import os from "node:os";
import { loadConfig, getEnvName } from "../core/config.js";
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

export async function deploy(opts: {
    env?: string;
    artifact?: string;
    archive?: string;
    version?: string;
    dryRun?: boolean;
    skipBuild?: boolean;
    keepArtifact?: boolean;
    autoRollback?: boolean;
    healthGate?: boolean;
    healthRetries?: number;
    maintenance?: boolean;
    backupDb?: boolean;
}) {
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

    const sharedItems: string[] = cfg.shared ?? cfg.build?.shared ?? [];
    const sharedDefaults: Record<string, string> | undefined = cfg.sharedDefaults ?? cfg.build?.sharedDefaults;
    const cleanAfterDeploy: boolean = cfg.cleanAfterDeploy ?? cfg.build?.cleanAfterDeploy ?? false;
    const keepLocalArtifact: boolean = opts.keepArtifact ?? cfg.keepArtifact ?? env.keepArtifact ?? false;
    const isMaintenanceEnabled: boolean = opts.maintenance ?? cfg.maintenanceMode ?? env.maintenanceMode ?? false;
    const isBackupDbEnabled: boolean = opts.backupDb ?? cfg.database?.enabled ?? env.database?.enabled ?? false;
    const dbConfig: DatabaseBackupConfig | undefined = env.database ?? cfg.database;

    const version = detectVersion({
        override: opts.version,
        versionCommand: cfg.versionCommand,
        versionFile: cfg.versionFile,
    });
    log.verbose(`Deployment version: ${version}`);

    log.info(`Starting deployment to [${envName}] environment (${env.host})`);

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
            for (const file of plan.files) {
                log.verbose(`[dry-run] package ${file.from} -> ${file.to}`);
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
            buildDir:  cfg.build?.buildDir,
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

    if (opts.dryRun) {
        const releases = posixJoin(remoteRoot, "releases");
        const currentLink = posixJoin(remoteRoot, "current");
        const tmp = posixJoin(remoteRoot, "tmp");
        const releaseDir = posixJoin(releases, version);
        const remoteTar = posixJoin(tmp, `release-${version}.tar.gz`);
        const keep = env.keepVersions ?? 5;

        log.info(`[dry-run] Would connect to ${env.username}@${env.host}`);
        log.info(`[dry-run] Would upload ${path.basename(artifactPath!)} to ${remoteTar}`);
        log.info(`[dry-run] Would write ${RELEASE_METADATA_FILE} into the release directory`);
        log.info(`[dry-run] Would extract into ${releaseDir}`);
        if (sharedItems.length) {
            log.info(`[dry-run] Would link shared items: ${sharedItems.join(", ")}`);
        }
        if (cfg.hooks?.preDeploy?.length) {
            log.info(`[dry-run] Would run ${cfg.hooks.preDeploy.length} preDeploy hook(s)`);
        } else {
            log.info(`[dry-run] No preDeploy hooks configured`);
        }
        log.info(`[dry-run] Would switch current symlink atomically to ${currentLink}`);
        if (cfg.hooks?.postDeploy?.length) {
            log.info(`[dry-run] Would run ${cfg.hooks.postDeploy.length} postDeploy hook(s)`);
        } else {
            log.info(`[dry-run] No postDeploy hooks configured`);
        }
        log.info(`[dry-run] Would clean old releases, keeping ${keep} version(s)`);
        if (cleanAfterDeploy && tmp && tmp !== "/") {
            log.info(`[dry-run] Would remove temporary upload directory ${tmp}`);
        }
        log.info(`[dry-run] Would verify SHA256 checksum after upload`);
        if (shouldBuild) {
            if (keepLocalArtifact) {
                log.info(`[dry-run] Would preserve local build artifact: ${path.basename(artifactPath!)}`);
            } else {
                log.info(`[dry-run] Would remove local build artifact: ${path.basename(artifactPath!)}`);
            }
        }
        return;
    }

    log.verbose(`Preparing for artifact uploading to remote server.`);

    const releases = posixJoin(remoteRoot, "releases");
    const currentLink = posixJoin(remoteRoot, "current");
    const tmp = posixJoin(remoteRoot, "tmp");
    const releaseDir = posixJoin(releases, version);
    const remoteTar = posixJoin(tmp, `release-${version}.tar.gz`);

    log.debug(`Remote paths - Root: ${remoteRoot}, Releases: ${releases}, Current: ${currentLink}, Tmp: ${tmp}`);
    log.debug(`Release directory: ${releaseDir}, Remote tar: ${remoteTar}`);
    log.verbose(`SSH connection config - Host: ${env.host}, Port: ${env.port || 22}, User: ${env.username}`);
    const spin = log.spinner(`Connecting to ${env.username}@${env.host}`);
    const bundle = await connect(env).catch((e) => {
        spin.fail("SSH connect failed");
        log.err(e.message || String(e));
        process.exit(1);
    });
    spin.succeed("Connected");

    try {
        log.verbose(`Ensuring remote directories exist`);
        await ensureRemoteDirs(bundle.ssh, releases, tmp);

        log.verbose(`Uploading artifact to remote server`);
        await uploadFile(bundle.sftp, artifactPath!, remoteTar, {
            label: `Uploading artifact (${path.basename(artifactPath!)})`,
            showProgress: true,
        });

        log.verbose(`Verifying uploaded artifact checksum`);
        const checksum = log.spinner("Verifying checksum...");
        try {
            const { localHash, remoteHash } = await verifyArtifactChecksum({
                ssh: bundle.ssh,
                localPath: artifactPath!,
                remotePath: remoteTar,
            });
            checksum.succeed("Checksum verified");
            log.ok(`Checksum verified (${localHash.slice(0, 12)}...)`);
            log.debug(`Local checksum: ${localHash}`);
            log.debug(`Remote checksum: ${remoteHash}`);
        } catch (error) {
            checksum.fail("Checksum verification failed");
            throw error;
        }

        // Extract release
        log.debug(`Executing extract command: mkdir -p ${escapeShellArg(releaseDir)} && tar -xzf ${escapeShellArg(remoteTar)} -C ${escapeShellArg(releaseDir)} && rm -f ${escapeShellArg(remoteTar)}`);
        const extract = log.spinner("Extracting release...");

        const { code, stderr } = await exec(
            bundle.ssh,
            `mkdir -p ${escapeShellArg(releaseDir)} && tar -xzf ${escapeShellArg(remoteTar)} -C ${escapeShellArg(releaseDir)} && rm -f ${escapeShellArg(remoteTar)}`
        );
        if (code !== 0) throw new Error(stderr || "remote extract failed");
        extract.succeed(`Extracted ${version}`);

        // Automated Pre-Deploy Database Backup
        if (isBackupDbEnabled && dbConfig) {
            const spinDb = log.spinner("Creating pre-deploy database backup...");
            try {
                const backupPath = await executeDatabaseBackup(bundle.ssh, remoteRoot, version, dbConfig, releaseDir);
                spinDb.succeed(`Pre-deploy database backup created (${path.posix.basename(backupPath)})`);
            } catch (dbErr: any) {
                spinDb.fail("Database backup failed");
                throw new Error(`Deployment aborted: ${dbErr.message}`);
            }
        }

        // Automatic Maintenance Mode: Enable before preDeploy hooks & release cutover
        if (isMaintenanceEnabled) {
            log.info("Putting site into maintenance mode during deployment...");
            await enableMaintenance(bundle.ssh, remoteRoot, {
                message: `Deploying release ${version}. We'll be right back!`,
                retryAfter: 120,
            });
        }

        // Link shared items (must happen before preDeploy so .env and storage are accessible)
        if (sharedItems.length) {
            log.verbose(`Linking ${sharedItems.length} shared items`);
            log.debug(`Shared items: ${JSON.stringify(sharedItems)}`);
            const spinShared = log.spinner("Linking shared items...");
            await linkShared(bundle.ssh, remoteRoot, releaseDir, sharedItems, sharedDefaults);
            spinShared.succeed(`Linking completed for ${sharedItems.length} shared items`);
        } else {
            log.verbose(`No shared items to link`);
        }

        // run PreDeploy hooks (runs in unzipped releaseDir with shared items linked)
        log.verbose(`Running pre-deploy hooks after extraction and shared linking.`);
        await runRemoteHooks(bundle.ssh, "preDeploy", cfg.hooks?.preDeploy, releaseDir);

        // Capture previous release target for safe health-gate auto-rollback
        const { stdout: previousTargetRaw } = await exec(bundle.ssh, `readlink ${escapeShellArg(currentLink)} || true`);
        const previousTarget = previousTargetRaw.trim() || null;
        log.debug(`Previous release symlink target: ${previousTarget || "(none)"}`);

        // Switch current symlink atomically (activate release)
        log.verbose(`Switching current symlink to new release`);
        log.info(`Activating new release...`);

        await switchCurrentSymlink(bundle.ssh, releaseDir, currentLink);

        log.ok(`Activated ${version}`);
        log.ok(`Deployed ${version} to [${envName}]`);

        // run PostDeploy hooks (after release is activated, e.g. restart service)
        log.verbose(`Running post-deploy hooks`);
        await runRemoteHooks(bundle.ssh, "postDeploy", cfg.hooks?.postDeploy, releaseDir);

        // Disable Maintenance Mode if it was enabled during deploy
        if (isMaintenanceEnabled) {
            log.info("Disabling deployment maintenance mode...");
            await disableMaintenance(bundle.ssh, remoteRoot);
            log.ok("Maintenance mode disabled");
        }

        // Optional post-deployment health check & auto-rollback gating
        const baseUrl = env.baseUrl || process.env.DPLOY_BASE_URL;
        if (baseUrl) {
            const healthPath = env.healthCheckPath || "/health";
            const url = new URL(healthPath, baseUrl).toString();
            const timeoutMs = Number(env.healthCheckTimeout ?? process.env.DPLOY_HEALTH_CHECK_TIMEOUT ?? 10000);
            const retries = Number(opts.healthRetries ?? env.healthCheckRetries ?? 3);
            const intervalMs = Number(env.healthCheckInterval ?? 2000);
            const isGated = opts.healthGate !== false && env.healthGate !== false;
            const shouldAutoRollback = opts.autoRollback !== false && env.autoRollback !== false;

            log.info(`Verifying deployment health: GET ${url} (timeout: ${timeoutMs}ms, retries: ${retries})`);
            const spinHealth = log.spinner("Verifying service health...");

            const healthResult = await performHealthCheckWithRetry(url, {
                timeoutMs,
                retries,
                intervalMs,
                onRetry: (err, attempt, nextDelay) => {
                    log.warn(`Health check attempt ${attempt}/${retries} failed (${err.message}). Retrying in ${nextDelay}ms...`);
                },
            });

            if (healthResult.ok) {
                spinHealth.succeed(`Post-deployment health check passed (${healthResult.status})`);
                log.ok(`Service verified healthy on [${envName}]`);
            } else {
                spinHealth.fail(`Post-deployment health check failed (status: ${healthResult.status || "unreachable"})`);
                log.err(`❌ Health check failed for ${url}: status ${healthResult.status || "unreachable"}`);

                if (isGated) {
                    if (shouldAutoRollback && previousTarget) {
                        log.warn(`Initiating automatic rollback to previous release (${path.posix.basename(previousTarget)})...`);
                        const spinRollback = log.spinner("Rolling back symlink to previous release...");
                        await switchCurrentSymlink(bundle.ssh, previousTarget, currentLink);
                        spinRollback.succeed(`Rolled back 'current' symlink to ${path.posix.basename(previousTarget)}`);
                        log.ok(`✓ Successfully restored previous release: ${path.posix.basename(previousTarget)}`);

                        throw new Error(
                            `Health gate failed: GET ${url} returned status ${healthResult.status || "unreachable"}. Automatically rolled back to ${path.posix.basename(previousTarget)}.`
                        );
                    } else if (shouldAutoRollback && !previousTarget) {
                        throw new Error(
                            `Health gate failed: GET ${url} returned status ${healthResult.status || "unreachable"}. No previous release available to rollback.`
                        );
                    } else {
                        throw new Error(
                            `Health gate failed: GET ${url} returned status ${healthResult.status || "unreachable"}.`
                        );
                    }
                } else {
                    log.warn(`⚠️ Post-deployment health check failed, but health-gating is disabled`);
                }
            }
        }

        const metadataTmpDir = await mkdtemp(path.join(os.tmpdir(), "dploy-release-"));
        const metadataTmpFile = path.join(metadataTmpDir, RELEASE_METADATA_FILE);
        const metadata = createReleaseMetadata({
            version,
            environment: envName,
            gitCommit: safeExec("git rev-parse HEAD") ?? null,
            deployedAt: new Date(),
            artifactName: path.basename(artifactPath!),
        });
        try {
            await fs.writeJson(metadataTmpFile, metadata, { spaces: 2 });
            log.verbose(`Uploading release metadata to ${posixJoin(releaseDir, RELEASE_METADATA_FILE)}`);
            await uploadFile(bundle.sftp, metadataTmpFile, posixJoin(releaseDir, RELEASE_METADATA_FILE), {
                showProgress: false,
            });
        } finally {
            await fs.remove(metadataTmpDir);
        }

        // Clean old releases
        const keep = env.keepVersions ?? 5;
        log.verbose(`Cleaning old releases, keeping ${keep} versions`);
        await cleanupReleases(bundle, releases, keep, { strict: true });
        if (cleanAfterDeploy && tmp && tmp !== "/") {
            log.verbose(`Cleaning temporary uploaded directory & files`);
            await exec(bundle.ssh, `rm -rf ${escapeShellArg(tmp)}`);
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

    } finally {
        log.verbose(`Closing SSH connection`);
        await close(bundle);
    }
}
