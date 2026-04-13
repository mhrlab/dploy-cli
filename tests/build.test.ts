import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";

import { buildArtifact } from "../src/features/packager.js";

test("buildArtifact removes staging directory after creating the archive", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dploy-build-"));

  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "demo" }), "utf8");

  const result = await buildArtifact({
    cwd,
    buildDir: "build",
    version: "v1",
    cfg: {
      build: {
        strategy: "include",
        include: ["package.json"],
      },
    },
  });

  await assert.doesNotReject(readFile(result.artifactPath));
  await assert.rejects(
    readFile(path.join(cwd, "build", "staging-v1", "package.json")),
    /ENOENT/
  );
});
