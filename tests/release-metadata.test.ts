import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createReleaseMetadata,
  formatReleaseLabel,
  formatReleaseMetadata,
  parseReleaseMetadata,
} from "../src/features/release-metadata.js";

test("createReleaseMetadata captures the expected fields", () => {
  const metadata = createReleaseMetadata({
    version: "v1.2.3",
    environment: "production",
    gitCommit: "abcdef1234567890",
    deployedAt: new Date("2025-01-10T06:36:22Z"),
    artifactName: "release-v1.2.3.tar.gz",
  });

  assert.equal(metadata.version, "v1.2.3");
  assert.equal(metadata.environment, "production");
  assert.equal(metadata.gitCommit, "abcdef1234567890");
  assert.equal(metadata.artifactName, "release-v1.2.3.tar.gz");
  assert.equal(metadata.deployedAt, "2025-01-10T06:36:22.000Z");
});

test("parseReleaseMetadata and format helpers round-trip", () => {
  const metadata = parseReleaseMetadata(
    JSON.stringify({
      version: "v1.2.3",
      deployedAt: "2025-01-10T06:36:22.000Z",
      gitCommit: "abcdef1234567890",
      environment: "production",
      artifactName: "release-v1.2.3.tar.gz",
    })
  );

  assert.ok(metadata);
  assert.equal(formatReleaseMetadata(metadata), "version v1.2.3, env production, deployed 2025-01-10 06:36:22 UTC, commit abcdef123456, artifact release-v1.2.3.tar.gz");
  assert.equal(
    formatReleaseLabel(
      {
        name: "v1.2.3",
        mtime: new Date("2025-01-10T06:36:22Z"),
        metadata,
      },
      "v1.2.3"
    ),
    "v1.2.3 [current] (version v1.2.3, env production, deployed 2025-01-10 06:36:22 UTC, commit abcdef123456, artifact release-v1.2.3.tar.gz)"
  );
});
