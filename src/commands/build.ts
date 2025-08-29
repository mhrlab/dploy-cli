import path from "node:path";
import { loadConfig } from "../core/config.js";
import { buildArtifact } from "../core/packager.js";
import { detectVersion } from "../core/utils.js";
import { log } from "../core/logger.js";


export async function build(opts: { version?: string }) {
    const cwd = process.cwd();
    const cfg = await loadConfig(cwd);
    const version = detectVersion(opts.version);


    const spin = log.spinner("Building artifact");
    try {
        const { artifactPath } = await buildArtifact({
            cwd,
            buildDir: cfg.buildDir,
            version,
            cfg,
        });
        spin.succeed(`Built ${path.basename(artifactPath)}`);
    } catch (e: any) {
        spin.fail("Build failed");
        log.err(e.message || String(e));
        process.exit(1);
    }
}
