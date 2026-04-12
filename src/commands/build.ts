import path from "node:path";
import { loadConfig } from "../core/config.js";
import { buildArtifact, planBuildArtifact } from "../features/packager.js";
import { detectVersion } from "../core/utils.js";
import { log } from "../core/logger.js";
import { runLocalHooks } from "../core/hooks.js";

export async function build(opts: { version?: string; dryRun?: boolean }) {
    log.debug(`Build started with options: ${JSON.stringify(opts)}`);
    const cwd = process.cwd();
    const cfg = await loadConfig(cwd);
    const version = detectVersion(opts.version);
    log.verbose(`Build version: ${version}`);

    log.info(`Starting build process for version ${version}`);

    if (opts.dryRun) {
        const plan = await planBuildArtifact({
            cwd,
            buildDir: cfg.build?.buildDir,
            version,
            cfg,
        });

        log.info(`[dry-run] Would package ${plan.files.length} file(s) into ${path.basename(plan.artifactPath)}`);
        log.info(`[dry-run] Output directory: ${plan.outDir}`);
        log.info(`[dry-run] Staging directory: ${plan.stagingDir}`);
        if (cfg.hooks?.preBuild?.length) {
            log.info(`[dry-run] Would run ${cfg.hooks.preBuild.length} preBuild hook(s)`);
        } else {
            log.info(`[dry-run] No preBuild hooks configured`);
        }
        if (cfg.hooks?.postBuild?.length) {
            log.info(`[dry-run] Would run ${cfg.hooks.postBuild.length} postBuild hook(s)`);
        } else {
            log.info(`[dry-run] No postBuild hooks configured`);
        }
        for (const file of plan.files) {
            log.verbose(`[dry-run] package ${file.from} -> ${file.to}`);
        }

        return { artifactPath: plan.artifactPath, files: plan.files };
    }

    log.verbose(`Running pre-build hooks`);
    await runLocalHooks("preBuild", cfg.hooks?.preBuild);

    log.info("Building artifact...");
    try {
        log.verbose(`Starting artifact build process`);
        const {artifactPath} = await buildArtifact({
            cwd,
            buildDir: cfg.build?.buildDir,
            version,
            cfg,
        });

        log.debug(`Artifact built successfully: ${artifactPath}`);
        log.verbose(`Running post-build hooks`);

        await runLocalHooks("postBuild", cfg.hooks?.postBuild);

        log.info(`Build completed successfully: ${path.basename(artifactPath)}`);

        return {artifactPath};
    } catch (e: any) {
        log.err(e.message || String(e));
        log.debug(`Build error details: ${e.stack || e}`);
        process.exit(1);
    }
}
