import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { test } from "node:test";

import { resolveDeployArtifact } from "../src/features/deploy-artifact.js";

test("resolveDeployArtifact resolves a custom archive path", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dploy-artifact-"));
  const archivePath = path.join(cwd, "custom.tar.gz");

  await writeFile(archivePath, "archive", "utf8");

  const selection = await resolveDeployArtifact({
    cwd,
    cfg: {},
    version: "v1",
    archive: archivePath,
  });

  assert.equal(selection.source, "custom");
  assert.equal(selection.artifactPath, archivePath);
});

test("resolveDeployArtifact resolves the default prebuilt artifact path when skip-build is enabled", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dploy-skip-"));
  const buildDir = path.join(cwd, "build");
  const artifactPath = path.join(buildDir, "release-v1.tar.gz");

  await mkdir(buildDir, { recursive: true });
  await writeFile(artifactPath, "archive", "utf8");

  const selection = await resolveDeployArtifact({
    cwd,
    cfg: {
      build: {
        buildDir: "build",
      },
    },
    version: "v1",
    skipBuild: true,
  });

  assert.equal(selection.source, "prebuilt");
  assert.equal(selection.artifactPath, artifactPath);
});

test("resolveDeployArtifact throws if skip-build is enabled but the default artifact is missing", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dploy-skip-missing-"));

  await assert.rejects(
    resolveDeployArtifact({
      cwd,
      cfg: {
        build: {
          buildDir: "build",
        },
      },
      version: "v1",
      skipBuild: true,
    }),
    /No prebuilt artifact found/
  );
});
