import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { test } from "node:test";
import { performHealthCheckWithRetry } from "../src/commands/health.js";
import { resolveRollbackTarget } from "../src/features/rollback.js";
import { switchCurrentSymlink, removePath } from "../src/core/ssh.js";

test("performHealthCheckWithRetry retries until server returns 200 OK", async () => {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    callCount++;
    if (callCount < 3) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Warming up");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const url = `http://127.0.0.1:${port}/health`;

  try {
    const res = await performHealthCheckWithRetry(url, {
      timeoutMs: 2000,
      retries: 4,
      intervalMs: 15,
    });

    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.match(res.text, /healthy/);
    assert.equal(callCount, 3);
  } finally {
    server.close();
  }
});

test("performHealthCheckWithRetry captures error status when retries are exhausted", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal error");
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const url = `http://127.0.0.1:${port}/health`;

  try {
    const res = await performHealthCheckWithRetry(url, {
      timeoutMs: 2000,
      retries: 2,
      intervalMs: 10,
    });

    assert.equal(res.ok, false);
    assert.equal(res.status, 500);
    assert.match(res.text, /Internal error/);
  } finally {
    server.close();
  }
});

test("rollback non-interactive mode automatically resolves previous release", () => {
  const releases = [
    { name: "v3", mtime: new Date("2026-01-03") },
    { name: "v2", mtime: new Date("2026-01-02") },
    { name: "v1", mtime: new Date("2026-01-01") },
  ];

  // Current release is v3
  const target = resolveRollbackTarget(releases, "v3", { latest: true });
  assert.equal(target?.name, "v2");
});

function createMockSSHClient(exitCode: number = 0, stderrOutput: string = "") {
  return {
    exec: (command: string, cb: (err: any, stream: any) => void) => {
      const stream = new EventEmitter() as any;
      stream.stderr = new EventEmitter();
      cb(null, stream);

      process.nextTick(() => {
        if (stderrOutput) {
          stream.stderr.emit("data", Buffer.from(stderrOutput));
        }
        stream.emit("close", exitCode);
      });
    },
  } as any;
}

test("switchCurrentSymlink succeeds when exit code is 0", async () => {
  const ssh = createMockSSHClient(0);
  await assert.doesNotReject(
    switchCurrentSymlink(ssh, "/var/www/app/releases/v1", "/var/www/app/current")
  );
});

test("switchCurrentSymlink throws Error when cutover exit code is non-zero", async () => {
  const ssh = createMockSSHClient(1, "ln: failed to create symlink: Permission denied");
  await assert.rejects(
    switchCurrentSymlink(ssh, "/var/www/app/releases/v1", "/var/www/app/current"),
    /Failed to switch active symlink.*Permission denied/
  );
});

test("removePath throws Error when remote rm fails with non-zero exit code", async () => {
  const ssh = createMockSSHClient(1, "rm: cannot remove: Operation not permitted");
  await assert.rejects(
    removePath(ssh, "/var/www/app/releases/old-release"),
    /Failed to remove remote path.*Operation not permitted/
  );
});
