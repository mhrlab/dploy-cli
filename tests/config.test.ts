import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { test } from "node:test";

import { loadConfig } from "../src/core/config.js";

async function createTempProject() {
  return await mkdtemp(path.join(os.tmpdir(), "dploy-config-"));
}

test("loadConfig reads deploy.config.yml and substitutes values from .env", async () => {
  const cwd = await createTempProject();

  await writeFile(
    path.join(cwd, ".env"),
    [
      "DPLOY_HOST=yml.example.test",
      "DPLOY_USER=deploy",
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    path.join(cwd, "deploy.config.yml"),
    [
      "name: YAML deployment",
      "build:",
      "  strategy: include",
      "  include:",
      "    - dist/**",
      "environments:",
      "  production:",
      "    host: \"${DPLOY_HOST:-fallback.example.test}\"",
      "    username: \"${DPLOY_USER:-fallback-user}\"",
      "    deployTo: /var/www/app",
    ].join("\n"),
    "utf8"
  );

  const config = await loadConfig(cwd);

  assert.equal(config.name, "YAML deployment");
  assert.equal(config.build?.strategy, "include");
  assert.deepEqual(config.build?.include, ["dist/**"]);
  assert.equal(config.environments?.production.host, "yml.example.test");
  assert.equal(config.environments?.production.username, "deploy");
});

test("loadConfig reads deploy.config.yaml and uses fallback values when env vars are missing", async () => {
  const cwd = await createTempProject();

  await writeFile(
    path.join(cwd, "deploy.config.yaml"),
    [
      "name: YAML fallback deployment",
      "build:",
      "  strategy: include",
      "  include:",
      "    - dist/**",
      "environments:",
      "  production:",
      "    host: \"${MISSING_HOST:-fallback.example.test}\"",
      "    username: \"${MISSING_USER:-fallback-user}\"",
      "    deployTo: /var/www/app",
    ].join("\n"),
    "utf8"
  );

  const config = await loadConfig(cwd);

  assert.equal(config.name, "YAML fallback deployment");
  assert.equal(config.environments?.production.host, "fallback.example.test");
  assert.equal(config.environments?.production.username, "fallback-user");
});
