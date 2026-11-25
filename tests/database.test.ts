import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
    buildMysqlCliAuthArgs,
    buildMysqlCreateQuery,
    buildMysqlDropQuery,
    buildPostgresCreateQuery,
    buildPostgresDropQuery,
} from "../src/commands/database.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(process.cwd(), "dist/bin/dploy.js");

test("buildMysqlCliAuthArgs leverages auth_socket for passwordless sudo on local server", () => {
    const auth = buildMysqlCliAuthArgs({
        host: "127.0.0.1",
        sudoPrefix: "sudo -n ",
        isExplicitAdmin: true,
    });

    assert.equal(auth.envPrefix, "");
    assert.equal(auth.cliArgs, "-u 'root'");
    assert.equal(auth.sudoPrefix, "sudo -n ");
});

test("buildMysqlCliAuthArgs uses MYSQL_PWD and host flags when password is provided", () => {
    const auth = buildMysqlCliAuthArgs({
        host: "db.internal",
        port: 3307,
        user: "custom_user",
        password: "secret_password",
    });

    assert.equal(auth.envPrefix, "MYSQL_PWD='secret_password' ");
    assert.ok(auth.cliArgs.includes("-h 'db.internal'"));
    assert.ok(auth.cliArgs.includes("-P 3307"));
    assert.ok(auth.cliArgs.includes("-u 'custom_user'"));
});

test("buildMysqlCreateQuery produces idempotent database, user, and privilege statements", () => {
    const query = buildMysqlCreateQuery("test_db", "test_user", "test_pass", "utf8mb4", "utf8mb4_unicode_ci");

    assert.ok(query.includes("CREATE DATABASE IF NOT EXISTS `test_db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"));
    assert.ok(query.includes("CREATE USER IF NOT EXISTS 'test_user'@'localhost' IDENTIFIED BY 'test_pass';"));
    assert.ok(query.includes("GRANT ALL PRIVILEGES ON `test_db`.* TO 'test_user'@'localhost';"));
    assert.ok(query.includes("GRANT ALL PRIVILEGES ON `test_db`.* TO 'test_user'@'%';"));
    assert.ok(query.includes("FLUSH PRIVILEGES;"));
});

test("buildMysqlDropQuery generates drop statement and drops user when requested", () => {
    const queryNoDropUser = buildMysqlDropQuery("test_db", "test_user", false);
    assert.equal(queryNoDropUser, "DROP DATABASE IF EXISTS `test_db`;");

    const queryWithDropUser = buildMysqlDropQuery("test_db", "test_user", true);
    assert.ok(queryWithDropUser.includes("DROP DATABASE IF EXISTS `test_db`;"));
    assert.ok(queryWithDropUser.includes("DROP USER IF EXISTS 'test_user'@'localhost';"));
    assert.ok(queryWithDropUser.includes("DROP USER IF EXISTS 'test_user'@'%';"));
});

test("buildPostgresCreateQuery produces role creation and database ownership queries", () => {
    const query = buildPostgresCreateQuery("app_db", "app_user", "app_pass");

    assert.ok(query.includes("CREATE ROLE \"app_user\" WITH LOGIN PASSWORD 'app_pass';"));
    assert.ok(query.includes("CREATE DATABASE \"app_db\" OWNER \"app_user\""));
    assert.ok(query.includes("GRANT ALL PRIVILEGES ON DATABASE \"app_db\" TO \"app_user\";"));
});

test("buildPostgresDropQuery produces drop database and drop role queries", () => {
    const query = buildPostgresDropQuery("app_db", "app_user", true);

    assert.ok(query.includes("DROP DATABASE IF EXISTS \"app_db\";"));
    assert.ok(query.includes("DROP ROLE IF EXISTS \"app_user\";"));
});

test("CLI exposes db command group and subcommands", async () => {
    const { stdout: dbHelp } = await execFileAsync("node", [CLI_PATH, "db", "--help"]);
    assert.match(dbHelp, /create/);
    assert.match(dbHelp, /drop/);
    assert.match(dbHelp, /backup/);
    assert.match(dbHelp, /restore/);
    assert.match(dbHelp, /optimize/);
    assert.match(dbHelp, /console/);

    const { stdout: createHelp } = await execFileAsync("node", [CLI_PATH, "db:create", "--help"]);
    assert.match(createHelp, /--charset/);
    assert.match(createHelp, /-A, --as-admin/);
});
