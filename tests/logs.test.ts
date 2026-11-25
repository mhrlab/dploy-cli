import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLsLtLine } from "../src/commands/logs.js";

test("parseLsLtLine parses standard linux ls -lt output", () => {
    const line = "-rw-r--r-- 1 www-data www-data 1048576 Nov 24 22:30 /var/www/app/writable/logs/log-2026-11-24.php";
    const parsed = parseLsLtLine(line);

    assert.ok(parsed);
    assert.equal(parsed.name, "log-2026-11-24.php");
    assert.equal(parsed.path, "/var/www/app/writable/logs/log-2026-11-24.php");
    assert.equal(parsed.size, "1 MB");
    assert.match(parsed.date, /Nov 24 22:30/);
});

test("parseLsLtLine parses laravel daily log format", () => {
    const line = "-rw-rw-r-- 1 deploy deploy 2048 Nov 23 15:00 /var/www/app/storage/logs/laravel-2026-11-23.log";
    const parsed = parseLsLtLine(line);

    assert.ok(parsed);
    assert.equal(parsed.name, "laravel-2026-11-23.log");
    assert.equal(parsed.path, "/var/www/app/storage/logs/laravel-2026-11-23.log");
    assert.equal(parsed.size, "2 KB");
});

test("parseLsLtLine ignores headers, error messages, and empty lines", () => {
    assert.equal(parseLsLtLine(""), null);
    assert.equal(parseLsLtLine("total 128"), null);
    assert.equal(parseLsLtLine("ls: cannot access '/var/www/app/logs/*.log': No such file or directory"), null);
});
