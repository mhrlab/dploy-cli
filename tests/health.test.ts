import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { performHealthCheck } from "../src/commands/health.js";

test("performHealthCheck successfully returns status and body for healthy endpoint", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/health`;

  try {
    const result = await performHealthCheck(url, 2000);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), { status: "healthy" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("performHealthCheck times out when server response exceeds configured timeout", async () => {
  const server = http.createServer((req, res) => {
    // Intentionally delay responding to trigger timeout
    setTimeout(() => {
      res.writeHead(200);
      res.end("too late");
    }, 500);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/health`;

  try {
    await assert.rejects(
      async () => {
        await performHealthCheck(url, 50);
      },
      (err: any) => {
        return err.name === "TimeoutError" || err.name === "AbortError";
      }
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
