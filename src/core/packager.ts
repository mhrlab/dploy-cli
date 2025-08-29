import fs from "fs-extra";
import path from "node:path";
import * as tar from "tar";
import { CopyEntry } from "./config.js";
import { resolveFiles } from "./strategy.js";
import { DployConfig } from "./config.js";


export type BuildResult = {
    artifactPath: string; // path to .tar.gz
    stagingDir: string; // temp staging dir
};

export async function buildArtifact(options: {
    cwd: string;
    buildDir: string;
    version: string;
    cfg: DployConfig;
}): Promise<BuildResult> {
    const { cwd, buildDir, version, cfg } = options;


    const outDir = path.join(cwd, buildDir);
    await fs.ensureDir(outDir);
    const stagingDir = path.join(outDir, `staging-${version}`);
    await fs.emptyDir(stagingDir);


    const files = await resolveFiles(cwd, cfg);
    for (const f of files) {
        await fs.ensureDir(path.dirname(path.join(stagingDir, f.to)));
        await fs.copy(f.from, path.join(stagingDir, f.to), { dereference: true });
    }


    const artifactName = `release-${version}.tar.gz`;
    const artifactPath = path.join(outDir, artifactName);


    await tar.create({ gzip: true, file: artifactPath, cwd: stagingDir, portable: true, noMtime: true }, ["."]);
    return { artifactPath, stagingDir };
}
