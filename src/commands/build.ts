import path from "node:path";
import { loadConfig } from "../core/config.js";
import { buildArtifact } from "../core/packager.js";
import { detectVersion } from "../core/utils.js";
import { log } from "../core/logger.js";
import { runLocalHooks } from "../core/hooks.js";

export async function build(opts: { version?: string }) {
    const cwd = process.cwd();
    const cfg = await loadConfig(cwd);
    const version = detectVersion(opts.version);

    log.info(`Starting build process for version ${version}`);

    await runLocalHooks("preBuild", cfg.hooks?.preBuild);

    log.info("Building artifact...");
    try {
        const { artifactPath } = await buildArtifact({
            cwd,
            buildDir: cfg.buildDir,
            version,
            cfg,
        });
        log.ok(`Built ${path.basename(artifactPath)}`);

        await runLocalHooks("postBuild", cfg.hooks?.postBuild);

        log.info(`Build completed successfully: ${path.basename(artifactPath)}`);
        return { artifactPath };
    } catch (e: any) {
        log.err(e.message || String(e));
        process.exit(1);
    }
}
