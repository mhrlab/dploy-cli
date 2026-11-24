import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { loadConfig } from "../src/core/config.js";
import { detectVersion, escapeShellArg, findPackageRoot, getAppVersion } from "../src/core/utils.js";

async function createTempProject(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "dploy-test-"));
}

test("loadConfig parses yaml deploy configuration with environment extension", async () => {
  const cwd = await createTempProject();

  await writeFile(
    path.join(cwd, "deploy.config.yml"),
    `
name: "Test App"
environments:
  default:
    keepVersions: 5
    deployTo: "/var/www/default"
    env:
      NODE_ENV: "production"
  staging:
    extends: default
    host: "staging.example.com"
    deployTo: "/var/www/staging"
    env:
      NODE_ENV: "staging"
`,
    "utf8"
  );

  const config = await loadConfig(cwd);

  assert.equal(config.name, "Test App");
  assert.ok(config.environments);
  assert.equal(config.environments.staging.deployTo, "/var/www/staging");
  assert.equal(config.environments.staging.keepVersions, 5);
  assert.equal(config.environments.staging.env?.NODE_ENV, "staging");
});

test("loadConfig substitutes environment variables with fallback values", async () => {
  const cwd = await createTempProject();
  process.env.TEST_HOST_OVERRIDE = "custom.server.com";

  await writeFile(
    path.join(cwd, "deploy.config.json"),
    JSON.stringify({
      environments: {
        prod: {
          host: "${TEST_HOST_OVERRIDE:-default.server.com}",
          username: "${TEST_USER_UNSET:-fallback_user}",
          deployTo: "/var/www/test",
        },
      },
    }),
    "utf8"
  );

  const config = await loadConfig(cwd);
  assert.equal(config.environments?.prod.host, "custom.server.com");
  assert.equal(config.environments?.prod.username, "fallback_user");
});

test("loadConfig prioritizes .env.dploy over .env", async () => {
  const cwd = await createTempProject();

  await writeFile(path.join(cwd, ".env"), "TEST_VAR_A=from_env\nTEST_VAR_B=from_env", "utf8");
  await writeFile(path.join(cwd, ".env.dploy"), "TEST_VAR_B=from_dploy", "utf8");

  await writeFile(
    path.join(cwd, "deploy.config.json"),
    JSON.stringify({
      environments: {
        production: {
          host: "${TEST_VAR_A}",
          username: "${TEST_VAR_B}",
          deployTo: "/var/www/test",
        },
      },
    }),
    "utf8"
  );

  const config = await loadConfig(cwd);
  assert.equal(config.environments?.production.host, "from_env");
  assert.equal(config.environments?.production.username, "from_dploy");
  assert.equal(process.env.TEST_VAR_A, "from_env");
});

test("loadConfig automatically falls back to DPLOY_HOST and DPLOY_USER when host is omitted", async () => {
  const cwd = await createTempProject();

  await writeFile(
    path.join(cwd, ".env.dploy"),
    "DPLOY_HOST=104.103.92.102\nDPLOY_USER=deploy\n",
    "utf8"
  );

  await writeFile(
    path.join(cwd, "deploy.config.yml"),
    `
environments:
  production:
    deployTo: "/var/www/my-app"
`,
    "utf8"
  );

  const config = await loadConfig(cwd);
  assert.equal(config.environments?.production.host, "104.103.92.102");
  assert.equal(config.environments?.production.username, "deploy");
});

test("resolveFiles resolves files with root-level config options (legacy/JSON compatibility)", async () => {
  const cwd = await createTempProject();
  await writeFile(path.join(cwd, "test.txt"), "hello", "utf8");

  const { resolveFiles } = await import("../src/features/strategy.js");
  const files = await resolveFiles(cwd, {
    strategy: "include",
    include: ["test.txt"],
  } as any);

  assert.equal(files.length, 1);
  assert.equal(files[0].from, path.join(cwd, "test.txt"));
});

test("escapeShellArg escapes special characters safely", () => {
  assert.equal(escapeShellArg("simple"), "'simple'");
  assert.equal(escapeShellArg("with space"), "'with space'");
  assert.equal(escapeShellArg("foo'bar"), "'foo'\\''bar'");
  assert.equal(escapeShellArg("$(rm -rf /)"), "'$(rm -rf /)'");
  assert.equal(escapeShellArg("`reboot`"), "'`reboot`'");
});

test("detectVersion validates version override format and rejects injection attempts", () => {
  assert.equal(detectVersion("v1.0.0"), "v1.0.0");
  assert.equal(detectVersion("release-2026-10-22"), "release-2026-10-22");
  assert.equal(detectVersion("v1.2.3-alpha.1"), "v1.2.3-alpha.1");
  assert.throws(() => detectVersion('v1.0.0"; rm -rf /; echo "'), /Invalid version format/);
  assert.throws(() => detectVersion("v1.0.0`whoami`"), /Invalid version format/);
  assert.throws(() => detectVersion("v1.0.0$(id)"), /Invalid version format/);
});

test("loadConfig ignores prototype pollution keys", async () => {
  const cwd = await createTempProject();

  await writeFile(
    path.join(cwd, "deploy.config.json"),
    JSON.stringify({
      name: "Pollution Test",
      __proto__: { polluted: true },
      environments: {
        base: {
          deployTo: "/var/www/base",
        },
        staging: {
          extends: "base",
          constructor: { polluted: true },
        },
      },
    }),
    "utf8"
  );

  const config = await loadConfig(cwd);
  assert.equal((Object.prototype as any).polluted, undefined);
  assert.equal(config.name, "Pollution Test");
});

test("findPackageRoot discovers directory containing package.json", () => {
  const root = findPackageRoot();
  assert.ok(root.length > 0);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(getAppVersion(), pkg.version);
});
