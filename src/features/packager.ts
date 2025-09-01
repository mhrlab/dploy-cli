import fs from "fs-extra";
import path from "node:path";
import * as tar from "tar";
import { resolveFiles } from "./strategy.js";
import { DployConfig } from "../core/config.js";
import { log } from "../core/logger.js";
import {getReadableFileSize} from "../core/utils.js";


export type BuildResult = {
    artifactPath: string; // path to .tar.gz
    stagingDir: string; // temp staging dir
    sizeBytes: number; // size of artifact
};

export async function buildArtifact(options: {
    cwd: string;
    buildDir: string;
    version: string;
    cfg: DployConfig;
}): Promise<BuildResult> {
    const { cwd, buildDir, version, cfg } = options;

    log.debug(`Build artifact started - cwd: ${cwd}, buildDir: ${buildDir}, version: ${version}`);
    log.debug(`Build config: ${JSON.stringify({
        strategy: cfg.strategy,
        include: cfg.include,
        exclude: cfg.exclude,
        copy: cfg.copy
    })}`);

    const outDir = path.join(cwd, buildDir);
    log.verbose(`Creating output directory: ${outDir}`);
    await fs.ensureDir(outDir);

    const stagingDir = path.join(outDir, `staging-${version}`);
    log.verbose(`Creating staging directory: ${stagingDir}`);
    await fs.emptyDir(stagingDir);

    log.verbose(`Resolving files to include in artifact`);
    const files = await resolveFiles(cwd, cfg);
    log.debug(`Resolved ${files.length} files to copy`);
    log.verbose(`Copying ${files.length} files to staging directory...`);
    log.info(`Copying ${files.length} files to staging directory...`);

    for (const f of files) {
        log.debug(`Copying file: ${f.from} -> ${f.to}`);
        await fs.ensureDir(path.dirname(path.join(stagingDir, f.to)));
        await fs.copy(f.from, path.join(stagingDir, f.to), { dereference: true });
    }

    const artifactName = `release-${version}.tar.gz`;
    const artifactPath = path.join(outDir, artifactName);
    log.verbose(`Creating artifact: ${artifactPath}`);

    log.debug(`Creating tar archive with gzip compression`);
    log.info(`Creating deployment archive...`);
    await tar.create({ gzip: true, file: artifactPath, cwd: stagingDir, portable: true, noMtime: true }, ["."]);
    const stats = fs.statSync(artifactPath);
    const sizeBytes = stats.size;
    log.verbose(`Artifact created successfully: ${artifactPath}`);

    log.ok(`Built ${path.basename(artifactPath)} [ ${getReadableFileSize(sizeBytes)} ]`);

    return { artifactPath, stagingDir, sizeBytes };
}
