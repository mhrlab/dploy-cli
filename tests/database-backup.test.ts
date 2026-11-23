import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDatabaseDumpCommand } from "../src/features/database-backup.js";

test("buildDatabaseDumpCommand creates valid mysqldump pipeline", () => {
    const cmd = buildDatabaseDumpCommand(
        {
            type: "mysql",
            name: "myapp_prod",
            user: "root",
            password: "secret'password",
            host: "127.0.0.1",
            port: 3306,
        },
        "/var/www/app/backups/dump.sql.gz"
    );

    assert.ok(cmd.startsWith("mysqldump --single-transaction --quick"));
    assert.ok(cmd.includes("-h '127.0.0.1'"));
    assert.ok(cmd.includes("-P 3306"));
    assert.ok(cmd.includes("-u 'root'"));
    assert.ok(cmd.includes("-p'secret'\\''password'"));
    assert.ok(cmd.includes("'myapp_prod'"));
    assert.ok(cmd.includes("| gzip -9 > '/var/www/app/backups/dump.sql.gz'"));
});

test("buildDatabaseDumpCommand creates valid pg_dump command", () => {
    const cmd = buildDatabaseDumpCommand(
        {
            type: "postgres",
            name: "myapp_pg",
            user: "postgres",
            password: "pgpassword",
            host: "db.internal",
            port: 5432,
        },
        "/var/www/app/backups/dump.dump"
    );

    assert.ok(cmd.includes("PGPASSWORD='pgpassword'"));
    assert.ok(cmd.includes("pg_dump -Fc"));
    assert.ok(cmd.includes("-h 'db.internal'"));
    assert.ok(cmd.includes("-p 5432"));
    assert.ok(cmd.includes("-U 'postgres'"));
    assert.ok(cmd.includes("'myapp_pg'"));
    assert.ok(cmd.includes("> '/var/www/app/backups/dump.dump'"));
});

test("buildDatabaseDumpCommand creates valid sqlite3 backup command", () => {
    const cmd = buildDatabaseDumpCommand(
        {
            type: "sqlite",
            path: "database/database.sqlite",
        },
        "/var/www/app/backups/dump.sqlite",
        "/var/www/app/releases/v1"
    );

    assert.ok(cmd.includes("sqlite3 '/var/www/app/releases/v1/database/database.sqlite'"));
    assert.ok(cmd.includes(".backup '/var/www/app/backups/dump.sqlite'"));
});
