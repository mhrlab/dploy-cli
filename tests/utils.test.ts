import assert from "node:assert/strict";
import { test } from "node:test";
import { assertValidVersion, detectVersion } from "../src/core/utils.js";

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
