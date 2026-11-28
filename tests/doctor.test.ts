import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { doctor, findUnresolvedEnvVars } from "../src/commands/doctor.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(process.cwd(), "dist/bin/dploy.js");

test("findUnresolvedEnvVars detects missing variables without fallback", () => {
    const raw = `
host: \${MISSING_HOST}
port: \${MISSING_PORT:-22}
user: \${PRESENT_USER}
`;
    const missing = findUnresolvedEnvVars(raw, { PRESENT_USER: "deploy" });
    assert.deepEqual(missing, ["MISSING_HOST"]);
});

test("doctor validates valid project config and reports ok", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dploy-doctor-"));
    const prevCwd = process.cwd();

    try {
        process.chdir(tmpDir);
        await fs.writeFile("index.js", "console.log('ok');\n", "utf8");
        await fs.writeFile(
            "deploy.config.yml",
            `
name: doctor-app
build:
  strategy: include
  include:
    - index.js
database:
  enabled: false
  type: \${DB_CONNECTION:-mysql}
  host: \${DB_HOST:-127.0.0.1}
  port: 3306
environments:
  default:
    port: \${SSH_PORT:-22}
    username: deploy
    password: secret
  production:
    extends: default
    host: 127.0.0.1
    deployTo: /var/www/doctor-app
`,
            "utf8"
        );

        const res = await doctor({ env: "production", json: true });
        assert.equal(res.ok, true);
        assert.ok(res.checks.some((c) => c.name === "schema" && c.status === "ok"));
        assert.ok(res.checks.some((c) => c.name === "build-files" && c.status === "ok"));
    } finally {
        process.chdir(prevCwd);
        await fs.remove(tmpDir);
    }
});

test("dploy doctor --help and dploy site service --help are exposed", async () => {
    const { stdout: doctorHelp } = await execFileAsync("node", [CLI_PATH, "doctor", "--help", "--quiet"]);
    assert.match(doctorHelp, /Validate deploy\.config\.yml/);

    const { stdout: serviceHelp } = await execFileAsync("node", [CLI_PATH, "site", "service", "--help", "--quiet"]);
    assert.match(serviceHelp, /Manage remote systemd services/);
    assert.match(serviceHelp, /-A, --as-admin/);
});
