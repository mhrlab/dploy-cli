import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectTuiContext, buildCliCommandHint } from "../src/commands/tui.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(process.cwd(), "dist/bin/dploy.js");

test("detectTuiContext detects uninitialized project and configured environments", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dploy-tui-"));
    const prevCwd = process.cwd();

    try {
        process.chdir(tmpDir);
        const emptyCtx = await detectTuiContext(tmpDir);
        assert.equal(emptyCtx.hasConfig, false);
        assert.equal(emptyCtx.hasEnvDploy, false);
        assert.deepEqual(emptyCtx.environments, ["production"]);

        await fs.writeFile(".env.dploy", "PROD_HOST=1.2.3.4\n", "utf8");
        await fs.writeFile(
            "deploy.config.yml",
            `
name: tui-demo
environments:
  default:
    username: deploy
  staging:
    extends: default
    host: staging.example.com
    deployTo: /var/www/staging
  production:
    extends: default
    host: prod.example.com
    deployTo: /var/www/prod
`,
            "utf8"
        );

        const loadedCtx = await detectTuiContext(tmpDir);
        assert.equal(loadedCtx.hasConfig, true);
        assert.equal(loadedCtx.hasEnvDploy, true);
        assert.equal(loadedCtx.appName, "tui-demo");
        assert.deepEqual(loadedCtx.environments, ["staging", "production"]);
    } finally {
        process.chdir(prevCwd);
        await fs.remove(tmpDir);
    }
});

test("buildCliCommandHint builds copy-pasteable commands for streaming operations", () => {
    assert.equal(buildCliCommandHint("ssh", { env: "production" }), "dploy ssh -e production");
    assert.equal(
        buildCliCommandHint("logs", { env: "staging", asAdmin: true, extraFlags: ["--type", "nginx", "-f"] }),
        "dploy logs -e staging -A --type nginx -f"
    );
    assert.equal(
        buildCliCommandHint("db console", { env: "production", asAdmin: true }),
        "dploy db console -e production -A"
    );
});

test("dploy tui --help and root --help include tui command", async () => {
    const { stdout: tuiHelp } = await execFileAsync("node", [CLI_PATH, "tui", "--help", "--quiet"]);
    assert.match(tuiHelp, /interactive guided terminal interface/i);

    const { stdout: rootHelp } = await execFileAsync("node", [CLI_PATH, "--help", "--quiet"]);
    assert.match(rootHelp, /tui\|ui/);
});
