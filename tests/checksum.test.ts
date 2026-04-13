import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { test } from "node:test";

import { sha256File } from "../src/features/checksum.js";

test("sha256File returns the expected digest", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dploy-checksum-"));
  const filePath = path.join(cwd, "artifact.tar.gz");

  await writeFile(filePath, "hello world", "utf8");

  const digest = await sha256File(filePath);

  assert.equal(
    digest,
    "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
  );
});
