import fs from "fs-extra";
import path from "node:path";
import * as tar from "tar";
import { CopyEntry } from "./config.js";


export type BuildResult = {
    artifactPath: string; // path to .tar.gz
    stagingDir: string; // temp staging dir
};


export async function buildArtifact(options: {
    cwd: string;
    buildDir: string;
    copy: CopyEntry[];
    version: string;
}): Promise<BuildResult> {
    const { cwd, buildDir, copy, version } = options;


    const outDir = path.join(cwd, buildDir);
    await fs.ensureDir(outDir);


    const stagingDir = path.join(outDir, `staging-${version}`);
    await fs.emptyDir(stagingDir);


// Copy entries (dirs/files) into staging
    for (const entry of copy) {
        const fromAbs = path.join(cwd, entry.from);
        const toAbs = path.join(stagingDir, entry.to);
        const exists = await fs.pathExists(fromAbs);
        if (!exists) {
            if (entry.optional) continue;
            throw new Error(`Missing path: ${entry.from}`);
        }
        await fs.ensureDir(path.dirname(toAbs));
        await fs.copy(fromAbs, toAbs, { dereference: true });
    }


    const artifactName = `release-${version}.tar.gz`;
    const artifactPath = path.join(outDir, artifactName);


// Create tarball from staging contents (pack without including staging root)
    await tar.create(
        {
            gzip: true,
            file: artifactPath,
            cwd: stagingDir,
            portable: true,
            noMtime: true,
        },
        ["."]
    );


    return { artifactPath, stagingDir };
}
