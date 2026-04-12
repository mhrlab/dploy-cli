import fs from "fs-extra";
import path from "node:path";
import * as tar from "tar";
import { resolveFiles } from "./strategy.js";
import { DeployConfig } from "../core/config.js";
import { log } from "../core/logger.js";
import {getReadableFileSize} from "../core/utils.js";


export type BuildResult = {
    artifactPath: string; // path to .tar.gz
    stagingDir: string; // temp staging dir
    sizeBytes: number; // size of artifact
    files: { from: string; to: string }[];
};

export type BuildPlan = {
    outDir: string;
    stagingDir: string;
    artifactPath: string;
    files: { from: string; to: string }[];
};

export async function planBuildArtifact(options: {
    cwd: string;
    buildDir: string | undefined;
    version: string;
    cfg: DeployConfig;
}): Promise<BuildPlan> {
    const { cwd, buildDir, version, cfg } = options;
    const outDir = path.join(cwd, buildDir ? buildDir : "builds");
    const stagingDir = path.join(outDir, `staging-${version}`);
    const artifactPath = path.join(outDir, `release-${version}.tar.gz`);
    const files = await resolveFiles(cwd, cfg);

    return { outDir, stagingDir, artifactPath, files };
}

export async function buildArtifact(options: {
    cwd: string;
    buildDir: string | undefined;
    version: string;
    cfg: DeployConfig;
}): Promise<BuildResult> {
    const { cwd, buildDir, version, cfg } = options;

    log.debug(`Build artifact started - cwd: ${cwd}, buildDir: ${buildDir}, version: ${version}`);
    log.debug(`Build config: ${JSON.stringify({
        strategy: cfg.build?.strategy,
        include: cfg.build?.include,
        exclude: cfg.build?.exclude,
        copy: cfg.build?.copy
    })}`);

    const plan = await planBuildArtifact({ cwd, buildDir, version, cfg });
    const { outDir, stagingDir, artifactPath, files } = plan;

    log.verbose(`Creating output directory: ${outDir}`);
    await fs.ensureDir(outDir);

    log.verbose(`Creating staging directory: ${stagingDir}`);
    await fs.emptyDir(stagingDir);

    log.debug(`Resolved ${files.length} files to copy`);
    log.verbose(`Copying ${files.length} files to staging directory...`);
    log.info(`Copying ${files.length} files to staging directory...`);

    for (const f of files) {
        log.debug(`Copying file: ${f.from} -> ${f.to}`);
        await fs.ensureDir(path.dirname(path.join(stagingDir, f.to)));
        await fs.copy(f.from, path.join(stagingDir, f.to), { dereference: true });
    }

    log.verbose(`Creating artifact: ${artifactPath}`);

    log.debug(`Creating tar archive with gzip compression`);
    log.info(`Creating deployment archive...`);
    await tar.create({ gzip: true, file: artifactPath, cwd: stagingDir, portable: true, noMtime: true }, ["."]);
    const stats = fs.statSync(artifactPath);
    const sizeBytes = stats.size;
    log.verbose(`Artifact created successfully: ${artifactPath}`);

    log.ok(`Built ${path.basename(artifactPath)} [ ${getReadableFileSize(sizeBytes)} ]`);

    return { artifactPath, stagingDir, sizeBytes, files };
}
