import assert from "node:assert/strict";
import { test } from "node:test";
import { withRetry } from "../src/core/retry.js";

test("withRetry succeeds immediately when operation succeeds on first attempt", async () => {
  let attempts = 0;
  const result = await withRetry(async (attempt) => {
    attempts++;
    return `success-${attempt}`;
  });

  assert.equal(attempts, 1);
  assert.equal(result, "success-1");
});

test("withRetry recovers after transient failures and succeeds", async () => {
  let attempts = 0;
  const onRetryCalls: number[] = [];

  const result = await withRetry(
    async (attempt) => {
      attempts++;
      if (attempt < 3) {
        throw new Error(`Transient failure ${attempt}`);
      }
      return "recovered";
    },
    {
      retries: 3,
      delayMs: 10,
      backoffFactor: 1.0,
      onRetry: (err, attempt) => {
        onRetryCalls.push(attempt);
      },
    }
  );

  assert.equal(attempts, 3);
  assert.equal(result, "recovered");
  assert.deepEqual(onRetryCalls, [1, 2]);
});

test("withRetry exhausts all retries and rethrows the final error", async () => {
  let attempts = 0;

  await assert.rejects(
    async () => {
      await withRetry(
        async () => {
          attempts++;
          throw new Error("Persistent network error");
        },
        {
          retries: 3,
          delayMs: 5,
        }
      );
    },
    /Persistent network error/
  );

  assert.equal(attempts, 3);
});
