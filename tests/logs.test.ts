import assert from "node:assert/strict";
import { test } from "node:test";
import chalk from "chalk";
import { parseLsLtLine, resolveConfiguredLogPath, colorizeLogLine, extractLastLogEntries } from "../src/commands/logs.js";

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

test("resolveConfiguredLogPath supports custom logs.<type> at env and top-level", () => {
    const cfg: any = {
        logsPath: "storage/logs",
        logs: {
            app: "storage/app-logs",
            system: "storage/system/logs/",
        },
    };
    const env: any = {
        logs: {
            system: "/var/log/custom-system/",
        },
    };

    assert.equal(resolveConfiguredLogPath({}, cfg, "app"), "storage/logs");
    assert.equal(resolveConfiguredLogPath(env, cfg, "system"), "/var/log/custom-system/");
    assert.equal(resolveConfiguredLogPath({}, cfg, "system"), "storage/system/logs/");
    assert.equal(resolveConfiguredLogPath({}, cfg, "worker"), undefined);
});

test("colorizeLogLine highlights error headers in red and access headers in blue", () => {
    const prevLevel = chalk.level;
    chalk.level = 1;
    try {
        const errHeader = colorizeLogLine("==> /var/log/nginx/example.com.error.log <==");
        const accessHeader = colorizeLogLine("==> /var/log/nginx/example.com.access.log <==");
        const otherHeader = colorizeLogLine("==> /var/www/app/storage/logs/laravel.log <==");
        const normalLine = colorizeLogLine("127.0.0.1 - GET / 200");

        assert.ok(errHeader.includes("\u001b[31m"), "error header should use red ANSI color");
        assert.ok(accessHeader.includes("\u001b[34m"), "access header should use blue ANSI color");
        assert.ok(otherHeader.includes("\u001b[32m"), "other header should use green ANSI color");
        assert.equal(normalLine, "127.0.0.1 - GET / 200");
    } finally {
        chalk.level = prevLevel;
    }
});

test("extractLastLogEntries returns last N multi-line log entries including stack traces", () => {
    const raw = [
        "[2026-11-28 08:00:01] local.INFO: First entry",
        "[2026-11-28 08:01:02] local.ERROR: Second entry failed",
        "Stack trace:",
        "#0 /var/www/app/Index.php(10): run()",
        "#1 /var/www/app/Kernel.php(20): handle()",
        "[2026-11-28 08:02:03] local.WARNING: Third entry",
        "[2026-11-28 08:03:04] local.ERROR: Fourth entry",
        "#0 /var/www/app/Auth.php(42): check()",
    ].join("\n");

    const last2 = extractLastLogEntries(raw, 2);
    assert.equal(last2.length, 2);
    assert.match(last2[0], /Third entry/);
    assert.match(last2[1], /Fourth entry[\s\S]*Auth\.php\(42\)/);

    const last3 = extractLastLogEntries(raw, 3);
    assert.equal(last3.length, 3);
    assert.match(last3[0], /Second entry failed[\s\S]*Kernel\.php\(20\)/);
});

test("extractLastLogEntries slices both Nginx error.log and access.log sections", () => {
    const raw = [
        "==> /var/log/nginx/example.com.error.log <==",
        "2026/11/28 08:00:01 [error] 101#101: *1 first error",
        "2026/11/28 08:01:02 [error] 101#101: *2 second error",
        "2026/11/28 08:02:03 [error] 101#101: *3 third error",
        "",
        "==> /var/log/nginx/example.com.access.log <==",
        '10.0.0.1 - - [28/Nov/2026:08:00:01 +0530] "GET /1 HTTP/2.0" 200 100 "-" "curl"',
        '10.0.0.2 - - [28/Nov/2026:08:01:02 +0530] "GET /2 HTTP/2.0" 200 100 "-" "curl"',
        '10.0.0.3 - - [28/Nov/2026:08:02:03 +0530] "GET /3 HTTP/2.0" 200 100 "-" "curl"',
    ].join("\n");

    const out = extractLastLogEntries(raw, 2);
    assert.deepEqual(out, [
        "==> /var/log/nginx/example.com.error.log <==",
        "2026/11/28 08:01:02 [error] 101#101: *2 second error",
        "2026/11/28 08:02:03 [error] 101#101: *3 third error",
        "==> /var/log/nginx/example.com.access.log <==",
        '10.0.0.2 - - [28/Nov/2026:08:01:02 +0530] "GET /2 HTTP/2.0" 200 100 "-" "curl"',
        '10.0.0.3 - - [28/Nov/2026:08:02:03 +0530] "GET /3 HTTP/2.0" 200 100 "-" "curl"',
    ]);
});
