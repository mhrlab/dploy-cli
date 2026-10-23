import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatBytes,
  formatDuration,
  formatSpeed,
  ItemProgressBar,
  TransferProgressBar,
} from "../src/core/progress.js";

test("formatBytes formats byte values accurately", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1024 * 1024), "1 MB");
  assert.equal(formatBytes(1024 * 1024 * 15.5), "15.5 MB");
});

test("formatSpeed appends /s to formatted bytes", () => {
  assert.equal(formatSpeed(1024 * 1024 * 2.5), "2.5 MB/s");
});

test("formatDuration formats seconds into readable duration", () => {
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(65), "1m 5s");
  assert.equal(formatDuration(120), "2m 0s");
});

test("TransferProgressBar calculates percentage and finishes cleanly", () => {
  const bar = new TransferProgressBar({
    totalBytes: 1000,
    label: "Test Upload",
    width: 20,
  });

  // Updating progress should not throw
  bar.update(250);
  bar.update(500);
  bar.update(1000);
  bar.finish("Upload finished successfully");

  // Subsequent updates after finish should be no-ops
  bar.update(1000);
});

test("ItemProgressBar tracks ticks and finishes cleanly", () => {
  const bar = new ItemProgressBar({
    total: 10,
    label: "Staging files",
    width: 20,
  });

  bar.tick(1, "file1.txt");
  bar.tick(4, "file5.txt");
  bar.setProgress(8, "file8.txt");
  bar.finish("All items staged");
});
