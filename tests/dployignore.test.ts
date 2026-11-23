import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { resolveFiles } from "../src/features/strategy.js";

test("resolveFiles respects .dployignore rules when packing files", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dploy-ignore-test-"));
    try {
        await fs.writeFile(path.join(tmp, "app.js"), "console.log('hi');");
        await fs.writeFile(path.join(tmp, "secret.key"), "my-secret");
        await fs.writeFile(path.join(tmp, "test.log"), "some log");
        await fs.writeFile(path.join(tmp, ".dployignore"), "*.key\n*.log\n# comment");

        const files = await resolveFiles(tmp, {
            build: {
                strategy: "exclude",
                exclude: [],
            },
        });

        const filenames = files.map((f) => path.basename(f.to));
        assert.ok(filenames.includes("app.js"));
        assert.ok(!filenames.includes("secret.key"));
        assert.ok(!filenames.includes("test.log"));
    } finally {
        await fs.remove(tmp);
    }
});
