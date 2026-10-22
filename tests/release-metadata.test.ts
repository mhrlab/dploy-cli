import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  createReleaseMetadata,
  fetchRemoteReleases,
  formatReleaseLabel,
  formatReleaseMetadata,
  parseReleaseMetadata,
} from "../src/features/release-metadata.js";
import { mapConcurrent } from "../src/core/utils.js";

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

test("mapConcurrent processes items in order and honors concurrency limit", async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  let active = 0;
  let maxActive = 0;

  const results = await mapConcurrent(items, 3, async (item) => {
    active++;
    if (active > maxActive) maxActive = active;
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return item * 2;
  });

  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(maxActive <= 3, `Max active (${maxActive}) should not exceed concurrency limit 3`);
  assert.ok(maxActive > 1, `Max active (${maxActive}) should be greater than 1 for concurrent execution`);
});

test("fetchRemoteReleases sorts releases by mtime and attaches parsed metadata", async () => {
  const mockSFTP: any = {
    list: async () => [
      { name: "release-1", type: "d", modifyTime: 1000 },
      { name: "release-2", type: "d", modifyTime: 2000 },
    ],
  };
  const mockBundle: any = {
    sftp: mockSFTP,
    ssh: {
      exec: (cmd: string, cb: any) => {
        const stream = new EventEmitter() as any;
        stream.stderr = new EventEmitter();
        cb(null, stream);
        process.nextTick(() => {
          stream.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                version: "v1.0.0",
                deployedAt: "2025-01-01T00:00:00.000Z",
                environment: "prod",
              })
            )
          );
          stream.emit("close", 0);
        });
      },
    },
  };

  const releases = await fetchRemoteReleases(mockBundle, "/var/www/app/releases", 2);
  assert.equal(releases.length, 2);
  assert.equal(releases[0].name, "release-2");
  assert.equal(releases[1].name, "release-1");
  assert.equal(releases[0].metadata?.version, "v1.0.0");
});
