import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { test } from "node:test";

import { planBuildArtifact } from "../src/features/packager.js";
import { cleanupReleases } from "../src/features/cleaner.js";

test("planBuildArtifact resolves files without writing build output", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dploy-plan-"));

  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
  await writeFile(path.join(cwd, "dist.js"), "console.log('ok');", "utf8");

  const plan = await planBuildArtifact({
    cwd,
    buildDir: "build",
    version: "v1",
    cfg: {
      build: {
        strategy: "include",
        include: ["package.json", "dist.js"],
      },
    },
  });

  assert.equal(plan.artifactPath, path.join(cwd, "build", "release-v1.tar.gz"));
  assert.equal(plan.stagingDir, path.join(cwd, "build", "staging-v1"));
  assert.deepEqual(
    plan.files.map((file) => file.to).sort(),
    ["dist.js", "package.json"]
  );
});

test("cleanupReleases dry-run does not call remote delete commands", async () => {
  let execCalled = false;

  const bundle = {
    ssh: {
      exec: () => {
        execCalled = true;
        throw new Error("exec should not be called in dry-run");
      },
    },
    sftp: {
      list: async () => [
        { type: "d", name: "release-1", modifyTime: 10 },
        { type: "d", name: "release-2", modifyTime: 20 },
        { type: "d", name: "release-3", modifyTime: 30 },
      ],
    },
  } as any;

  await cleanupReleases(bundle, "/var/www/app/releases", 1, { dryRun: true });

  assert.equal(execCalled, false);
});

test("deploy throws if environment is missing required deployTo path", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dploy-deploy-to-"));
  await writeFile(
    path.join(cwd, "deploy.config.yml"),
    [
      "name: test",
      "environments:",
      "  production:",
      "    host: example.com",
      "    username: deploy",
    ].join("\n"),
    "utf8"
  );

  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    const { deploy } = await import("../src/commands/deploy.js");
    await assert.rejects(
      deploy({ env: "production", dryRun: true }),
      /missing required 'deployTo' path/
    );
  } finally {
    process.chdir(prevCwd);
  }
});
