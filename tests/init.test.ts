import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { init } from "../src/commands/init.js";

async function createTempWorkspace() {
  return await mkdtemp(path.join(os.tmpdir(), "dploy-init-test-"));
}

test("init command copies deploy config and .env.dploy.example for yaml template", async () => {
  const originalCwd = process.cwd();
  const cwd = await createTempWorkspace();

  try {
    process.chdir(cwd);
    await init({ template: "fastapi" });

    const fs = await import("fs-extra");
    const configExists = await fs.default.pathExists(path.join(cwd, "deploy.config.yaml"));
    const envExampleExists = await fs.default.pathExists(path.join(cwd, ".env.dploy.example"));
    assert.equal(configExists, true, "deploy.config.yaml should be created");
    assert.equal(envExampleExists, true, ".env.dploy.example should be created for yaml template");
  } finally {
    process.chdir(originalCwd);
  }
});
