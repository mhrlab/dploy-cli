import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { build } from "../src/commands/build.js";
import { health } from "../src/commands/health.js";

async function createTempWorkspace() {
  return await mkdtemp(path.join(os.tmpdir(), "dploy-cmd-"));
}

test("build command executes with --dry-run without creating artifact", async () => {
  const originalCwd = process.cwd();
  const cwd = await createTempWorkspace();

  try {
    process.chdir(cwd);
    await writeFile(
      path.join(cwd, "deploy.config.json"),
      JSON.stringify({
        name: "Test App",
        build: {
          strategy: "copy",
          copy: [{ from: "sample.txt", to: "sample.txt" }],
        },
      }),
      "utf8"
    );
    await writeFile(path.join(cwd, "sample.txt"), "hello", "utf8");

    await build({ dryRun: true });

    // In dry-run mode, no build directory should be created
    const fs = await import("fs-extra");
    const buildExists = await fs.default.pathExists(path.join(cwd, "builds"));
    assert.equal(buildExists, false);
  } finally {
    process.chdir(originalCwd);
  }
});

test("build command creates artifact archive when executed", async () => {
  const originalCwd = process.cwd();
  const cwd = await createTempWorkspace();

  try {
    process.chdir(cwd);
    await writeFile(
      path.join(cwd, "deploy.config.json"),
      JSON.stringify({
        name: "Test App",
        build: {
          strategy: "copy",
          copy: [{ from: "sample.txt", to: "sample.txt" }],
        },
      }),
      "utf8"
    );
    await writeFile(path.join(cwd, "sample.txt"), "hello", "utf8");

    await build({ version: "v1.0.0" });

    const fs = await import("fs-extra");
    const artifactPath = path.join(cwd, "builds", "release-v1.0.0.tar.gz");
    const exists = await fs.default.pathExists(artifactPath);
    assert.equal(exists, true);
  } finally {
    process.chdir(originalCwd);
  }
});

test("health command throws error when baseUrl is missing", async () => {
  const originalCwd = process.cwd();
  const cwd = await createTempWorkspace();

  try {
    process.chdir(cwd);
    await writeFile(
      path.join(cwd, "deploy.config.json"),
      JSON.stringify({
        name: "Test App",
        environments: {
          production: {
            deployTo: "/var/www/app",
          },
        },
      }),
      "utf8"
    );

    await assert.rejects(
      async () => {
        await health({ env: "production" });
      },
      /Missing baseUrl/
    );
  } finally {
    process.chdir(originalCwd);
  }
});
