import path from "node:path";
import { loadConfig } from "../core/config.js";
import { buildArtifact } from "../features/packager.js";
import { detectVersion } from "../core/utils.js";
import { log } from "../core/logger.js";
import { runLocalHooks } from "../core/hooks.js";

export async function build(opts: { version?: string }) {
    log.debug(`Build started with options: ${JSON.stringify(opts)}`);
    const cwd = process.cwd();
    const cfg = await loadConfig(cwd);
    const version = detectVersion(opts.version);
    log.verbose(`Build version: ${version}`);

    log.info(`Starting build process for version ${version}`);

    log.verbose(`Running pre-build hooks`);
    await runLocalHooks("preBuild", cfg.hooks?.preBuild);

    log.info("Building artifact...");
    try {
        log.verbose(`Starting artifact build process`);
        const {artifactPath} = await buildArtifact({
            cwd,
            buildDir: cfg.buildDir,
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
