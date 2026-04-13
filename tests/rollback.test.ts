import assert from "node:assert/strict";
import { test } from "node:test";

import { currentReleaseNameFromTarget, resolveRollbackTarget } from "../src/features/rollback.js";

test("currentReleaseNameFromTarget returns the final directory name", () => {
  assert.equal(currentReleaseNameFromTarget("/var/www/app/releases/v1"), "v1");
  assert.equal(currentReleaseNameFromTarget("/var/www/app/releases/v1/"), "v1");
});

test("resolveRollbackTarget picks the previous release when latest is set", () => {
  const releases = [
    { name: "v3", mtime: new Date("2025-01-03T00:00:00Z") },
    { name: "v2", mtime: new Date("2025-01-02T00:00:00Z") },
    { name: "v1", mtime: new Date("2025-01-01T00:00:00Z") },
  ];

  const target = resolveRollbackTarget(releases, "v3", { latest: true });

  assert.equal(target?.name, "v2");
});

test("resolveRollbackTarget matches an explicit release name", () => {
  const releases = [
    { name: "v3", mtime: new Date("2025-01-03T00:00:00Z") },
    { name: "v2", mtime: new Date("2025-01-02T00:00:00Z") },
  ];

  const target = resolveRollbackTarget(releases, "v3", { to: "v2" });

  assert.equal(target?.name, "v2");
});
