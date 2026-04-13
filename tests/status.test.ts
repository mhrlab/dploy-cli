import assert from "node:assert/strict";
import { test } from "node:test";

import { formatRemoteStatus } from "../src/features/status.js";

test("formatRemoteStatus renders current release and release list", () => {
  const lines = formatRemoteStatus({
    envName: "production",
    host: "server.example.com",
    username: "deploy",
    deployTo: "/var/www/app",
    currentTarget: "/var/www/app/releases/v2",
    currentRelease: "v2",
    lastDeployAt: new Date("2026-04-12T10:30:00.000Z"),
    currentReleaseMetadata: null,
    releases: [
      { name: "v2", mtime: new Date("2026-04-12T10:30:00.000Z"), metadata: null },
      { name: "v1", mtime: new Date("2026-04-11T09:15:00.000Z"), metadata: null },
    ],
  });

  assert.deepEqual(lines, [
    "Active environment: production",
    "Server: deploy@server.example.com",
    "Deploy path: /var/www/app",
    "Current release: v2",
    "Last deploy: 2026-04-12 10:30:00 UTC",
    "Available releases (2):",
    "  - v2 [current] (2026-04-12 10:30:00 UTC)",
    "  - v1 (2026-04-11 09:15:00 UTC)",
  ]);
});
