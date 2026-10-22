import fs from "fs-extra";
import path from "node:path";
import { DeployConfig } from "../core/config.js";
import { planBuildArtifact } from "./packager.js";

export type DeployArtifactSelection = {
    artifactPath: string;
    source: "custom" | "prebuilt";
};

export async function resolveDeployArtifact(options: {
    cwd: string;
    cfg: DeployConfig;
    version: string;
    artifact?: string;
    archive?: string;
    skipBuild?: boolean;
    strict?: boolean;
}): Promise<DeployArtifactSelection> {
    const { cwd, cfg, version, artifact, archive, skipBuild = false, strict = true } = options;
    const customPath = artifact ?? archive;

    if (customPath) {
        const artifactPath = path.resolve(customPath);
        if (strict && !(await fs.pathExists(artifactPath))) {
            throw new Error(`Artifact not found: ${artifactPath}`);
        }

        return { artifactPath, source: "custom" };
    }

    if (skipBuild) {
        const plan = await planBuildArtifact({
            cwd,
            buildDir: cfg.build?.buildDir,
            version,
            cfg,
        });

        if (strict && !(await fs.pathExists(plan.artifactPath))) {
            throw new Error(
                `No prebuilt artifact found at ${plan.artifactPath}. Run build first or pass --artifact <path>.`
            );
        }

        return { artifactPath: plan.artifactPath, source: "prebuilt" };
    }

    throw new Error("No deploy artifact could be resolved");
}
