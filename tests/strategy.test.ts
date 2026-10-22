import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { resolveFiles } from "../src/features/strategy.js";

async function createTempWorkspace() {
  return await mkdtemp(path.join(os.tmpdir(), "dploy-strategy-"));
}

test("strategy: copy resolves existing files and skips missing optional files", async () => {
  const cwd = await createTempWorkspace();
  await writeFile(path.join(cwd, "fileA.txt"), "A", "utf8");

  const files = await resolveFiles(cwd, {
    build: {
      strategy: "copy",
      copy: [
        { from: "fileA.txt", to: "renamedA.txt" },
        { from: "optionalMissing.txt", to: "opt.txt", optional: true },
      ],
    },
  });

  assert.equal(files.length, 1);
  assert.equal(files[0].to, "renamedA.txt");
  assert.equal(files[0].from, path.join(cwd, "fileA.txt"));
});

test("strategy: copy throws when required file is missing", async () => {
  const cwd = await createTempWorkspace();

  await assert.rejects(
    async () => {
      await resolveFiles(cwd, {
        build: {
          strategy: "copy",
          copy: [{ from: "doesNotExist.txt", to: "dest.txt" }],
        },
      });
    },
    /Missing path: doesNotExist\.txt/
  );
});

test("strategy: exclude includes all files except excluded patterns", async () => {
  const cwd = await createTempWorkspace();
  await mkdir(path.join(cwd, "src"));
  await mkdir(path.join(cwd, "tests"));
  await writeFile(path.join(cwd, "src", "index.ts"), "code", "utf8");
  await writeFile(path.join(cwd, "tests", "index.test.ts"), "test", "utf8");
  await writeFile(path.join(cwd, ".env"), "secret", "utf8");

  const files = await resolveFiles(cwd, {
    build: {
      strategy: "exclude",
      exclude: ["tests/**", ".env"],
    },
  });

  const relativePaths = files.map((f) => path.relative(cwd, f.from).replace(/\\/g, "/")).sort();
  assert.deepEqual(relativePaths, ["src/index.ts"]);
});

test("strategy: hybrid resolves both copy entries and include patterns", async () => {
  const cwd = await createTempWorkspace();
  await mkdir(path.join(cwd, "dist"));
  await writeFile(path.join(cwd, "dist", "bundle.js"), "code", "utf8");
  await writeFile(path.join(cwd, "dist", "bundle.map"), "sourcemap", "utf8");
  await writeFile(path.join(cwd, "config.json"), "{}", "utf8");

  const files = await resolveFiles(cwd, {
    build: {
      strategy: "hybrid",
      include: ["dist/**"],
      exclude: ["**/*.map"],
      copy: [{ from: "config.json", to: "app.config.json" }],
    },
  });

  const destinations = files.map((f) => f.to).sort();
  assert.deepEqual(destinations, ["app.config.json", "dist/bundle.js"]);
});
