import fs from "fs-extra";
import path from "node:path";
import * as tar from "tar";
import { resolveFiles } from "./strategy.js";
import { DeployConfig } from "../core/config.js";
import { log } from "../core/logger.js";
import { getReadableFileSize } from "../core/utils.js";
import { ItemProgressBar } from "../core/progress.js";


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
    const effectiveBuildDir = buildDir ? buildDir : (cfg.build?.buildDir ?? cfg.buildDir ?? "builds");
    const outDir = path.join(cwd, effectiveBuildDir);
    const stagingDir = path.join(outDir, `staging-${version}`);
    const artifactPath = path.join(outDir, `release-${version}.tar.gz`);
    const files = await resolveFiles(cwd, cfg);

    for (const f of files) {
        const destPath = path.resolve(stagingDir, f.to);
        const rel = path.relative(stagingDir, destPath);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
            throw new Error(`Path traversal detected: target path '${f.to}' resolves outside staging directory`);
        }
    }

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
        strategy: cfg.build?.strategy ?? cfg.strategy,
        include: cfg.build?.include ?? cfg.include,
        exclude: cfg.build?.exclude ?? cfg.exclude,
        copy: cfg.build?.copy ?? cfg.copy
    })}`);

    const plan = await planBuildArtifact({ cwd, buildDir, version, cfg });
    const { outDir, stagingDir, artifactPath, files } = plan;

    log.verbose(`Creating output directory: ${outDir}`);
    await fs.ensureDir(outDir);

    log.verbose(`Creating staging directory: ${stagingDir}`);
    await fs.emptyDir(stagingDir);

    log.debug(`Resolved ${files.length} files to copy`);
    log.verbose(`Copying ${files.length} files to staging directory...`);

    const progressBar = files.length > 5
        ? new ItemProgressBar({ total: files.length, label: "Staging files" })
        : null;

    if (!progressBar) {
        log.info(`Copying ${files.length} files to staging directory...`);
    }

    for (const f of files) {
        log.debug(`Copying file: ${f.from} -> ${f.to}`);
        const destPath = path.resolve(stagingDir, f.to);
        const rel = path.relative(stagingDir, destPath);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
            throw new Error(`Path traversal detected: target path '${f.to}' resolves outside staging directory`);
        }
        await fs.ensureDir(path.dirname(destPath));
        await fs.copy(f.from, destPath, { dereference: false });
        if (progressBar) {
            progressBar.tick(1, path.basename(f.to));
        }
    }

    if (progressBar) {
        progressBar.finish(`Staged ${files.length} files into ${path.basename(stagingDir)}`);
    }

    log.verbose(`Creating artifact: ${artifactPath}`);

    let sizeBytes = 0;
    const spin = log.spinner(`Compressing deployment archive (${path.basename(artifactPath)})...`);
    try {
        log.debug(`Creating tar archive with gzip compression`);
        await tar.create({ gzip: true, file: artifactPath, cwd: stagingDir, portable: true, noMtime: true }, ["."]);
        const stats = fs.statSync(artifactPath);
        sizeBytes = stats.size;
        spin.succeed(`Built ${path.basename(artifactPath)} [ ${getReadableFileSize(sizeBytes)} ]`);
        log.verbose(`Artifact created successfully: ${artifactPath}`);
    } catch (err) {
        spin.fail("Failed to create deployment archive");
        throw err;
    } finally {
        log.verbose(`Removing staging directory: ${stagingDir}`);
        await fs.remove(stagingDir);
    }

    return { artifactPath, stagingDir, sizeBytes, files };
}
