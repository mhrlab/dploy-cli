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

test("CLI logs command exposes --latest option for daily log file selection", async () => {
    const { stdout: logsHelp } = await execFileAsync("node", [CLI_PATH, "logs", "--help"]);
    assert.match(logsHelp, /--latest/);
});

test("CLI env group and aliases expose env edit and env:edit commands", async () => {
    const { stdout: envHelp } = await execFileAsync("node", [CLI_PATH, "env", "--help"]);
    assert.match(envHelp, /edit/);

    const { stdout: envEditHelp } = await execFileAsync("node", [CLI_PATH, "env:edit", "--help"]);
    assert.match(envEditHelp, /--editor/);
});

test("CLI --help groups commands, shows short aliases, and hides legacy colon aliases", async () => {
    const { stdout: rootHelp } = await execFileAsync("node", [CLI_PATH, "--help", "--quiet"]);
    assert.match(rootHelp, /Setup & Infrastructure:/);
    assert.match(rootHelp, /Deployment Lifecycle:/);
    assert.match(rootHelp, /Monitoring & Operations:/);
    assert.match(rootHelp, /Resource Management:/);
    assert.match(rootHelp, /deploy\|d/);
    assert.match(rootHelp, /status\|st/);
    assert.match(rootHelp, /list\|ls/);
    assert.match(rootHelp, /rollback\|rb/);
    assert.match(rootHelp, /provision\|prov/);
    assert.ok(!rootHelp.includes("env:push"), "root --help should hide env:push");
    assert.ok(!rootHelp.includes("db:backup"), "root --help should hide db:backup");
});

