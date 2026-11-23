import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { assertValidVersion, detectVersion } from "../src/core/utils.js";

async function createTempWorkspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "dploy-utils-test-"));
}

test("assertValidVersion rejects directory traversal tokens and non-alphanumeric starts", () => {
  assert.throws(() => assertValidVersion("."), /Invalid version format/);
  assert.throws(() => assertValidVersion(".."), /Invalid version format/);
  assert.throws(() => assertValidVersion("-v1.0.0"), /Invalid version format/);
  assert.throws(() => assertValidVersion(".1.0"), /Invalid version format/);

  // Valid versions should not throw
  assert.doesNotThrow(() => assertValidVersion("v1.0.0"));
  assert.doesNotThrow(() => assertValidVersion("1.0.0"));
  assert.doesNotThrow(() => assertValidVersion("release-2026-10-22"));
  assert.doesNotThrow(() => assertValidVersion("v1.2.3-alpha.1"));
});

test("detectVersion rejects directory traversal and command injection in override", () => {
  assert.throws(() => detectVersion("."), /Invalid version format/);
  assert.throws(() => detectVersion(".."), /Invalid version format/);
  assert.throws(() => detectVersion("-v1.0.0"), /Invalid version format/);
  assert.throws(() => detectVersion('v1.0.0"; rm -rf /; echo "'), /Invalid version format/);
  assert.throws(() => detectVersion("v1.0.0`whoami`"), /Invalid version format/);
  assert.throws(() => detectVersion("v1.0.0$(id)"), /Invalid version format/);
});

test("detectVersion uses versionCommand when provided", () => {
  const version = detectVersion({
    versionCommand: "node -e \"console.log('v2.5.9')\"",
  });
  assert.equal(version, "v2.5.9");
});

test("detectVersion prioritizes custom versionFile over VERSION, composer.json and package.json", async () => {
  const cwd = await createTempWorkspace();
  await writeFile(path.join(cwd, "custom-ver.txt"), "9.9.9\n", "utf8");
  await writeFile(path.join(cwd, "VERSION"), "8.8.8\n", "utf8");
  await writeFile(path.join(cwd, "composer.json"), JSON.stringify({ version: "7.7.7" }), "utf8");
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ version: "6.6.6" }), "utf8");

  const version = detectVersion({ cwd, versionFile: "custom-ver.txt" });
  assert.match(version, /^v9\.9\.9-/);
});

test("detectVersion supports JSON versionFile", async () => {
  const cwd = await createTempWorkspace();
  await writeFile(path.join(cwd, "version.json"), JSON.stringify({ version: "5.5.5" }), "utf8");

  const version = detectVersion({ cwd, versionFile: "version.json" });
  assert.match(version, /^v5\.5\.5-/);
});

test("detectVersion prioritizes VERSION file over composer.json and package.json", async () => {
  const cwd = await createTempWorkspace();
  await writeFile(path.join(cwd, "VERSION"), "4.0.0\n", "utf8");
  await writeFile(path.join(cwd, "composer.json"), JSON.stringify({ version: "3.0.0" }), "utf8");
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ version: "1.0.0" }), "utf8");

  const version = detectVersion({ cwd });
  assert.match(version, /^v4\.0\.0-/);
});

test("detectVersion prioritizes composer.json over package.json when VERSION is absent", async () => {
  const cwd = await createTempWorkspace();
  await writeFile(path.join(cwd, "composer.json"), JSON.stringify({ version: "3.2.1" }), "utf8");
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ version: "1.0.0" }), "utf8");

  const version = detectVersion({ cwd });
  assert.match(version, /^v3\.2\.1-/);
});

test("detectVersion falls back to package.json when VERSION and composer.json are absent", async () => {
  const cwd = await createTempWorkspace();
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ version: "2.1.0" }), "utf8");

  const version = detectVersion({ cwd });
  assert.match(version, /^v2\.1\.0-/);
});

