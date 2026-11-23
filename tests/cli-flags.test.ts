import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(process.cwd(), "dist/bin/dploy.js");

test("CLI -v flag enables verbose logging without conflicting with deploy command", async () => {
    // Calling `node dist/bin/dploy.js --help` shows global -v, --verbose
    const { stdout: rootHelp } = await execFileAsync("node", [CLI_PATH, "--help"]);
    assert.match(rootHelp, /-v, --verbose/);

    // Calling `node dist/bin/dploy.js deploy --help` shows non-conflicting options
    const { stdout: deployHelp } = await execFileAsync("node", [CLI_PATH, "deploy", "--help"]);
    assert.match(deployHelp, /--version-override/);
    assert.ok(!deployHelp.includes("-v, --version"), "deploy should not expose lowercase -v for version");
});

test("CLI handles unknown commands cleanly with error message rather than crash", async () => {
    try {
        await execFileAsync("node", [CLI_PATH, "unknown-command"]);
        assert.fail("Should have failed on unknown command");
    } catch (err: any) {
        assert.equal(err.code, 1);
        assert.match(err.stderr || err.stdout, /unknown command/i);
    }
});
