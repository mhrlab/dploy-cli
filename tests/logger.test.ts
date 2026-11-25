import { test } from "node:test";
import assert from "node:assert/strict";
import { log, setLogLevel, redactSecrets } from "../src/core/logger.js";

test("redactSecrets masks passwords in JSON, env vars, and CLI flags", () => {
    const jsonMsg = `Options: {"host":"1.2.3.4","adminPassword":"super-secret","passphrase":"my-key-pass"}`;
    const redactedJson = redactSecrets(jsonMsg);
    assert.ok(!redactedJson.includes("super-secret"));
    assert.ok(!redactedJson.includes("my-key-pass"));
    assert.ok(redactedJson.includes(`"adminPassword":"***"`));

    const cmdMsg = `PGPASSWORD='db-pass' psql -U app && mysql -u root -p'mysql-pass' --admin-password secret123`;
    const redactedCmd = redactSecrets(cmdMsg);
    assert.ok(!redactedCmd.includes("db-pass"));
    assert.ok(!redactedCmd.includes("mysql-pass"));
    assert.ok(!redactedCmd.includes("secret123"));
    assert.ok(redactedCmd.includes("PGPASSWORD=***"));
    assert.ok(redactedCmd.includes("-p'***'"));
    assert.ok(redactedCmd.includes("--admin-password ***"));
});

test("setLogLevel respects quiet mode and formats timestamped verbose/debug logs", () => {
    const origLog = console.log;
    const captured: string[] = [];
    console.log = (...args: any[]) => {
        captured.push(args.join(" "));
    };

    try {
        setLogLevel(true, true, false);
        log.verbose("Connecting to server");
        log.debug("Socket opened");
        assert.equal(captured.length, 2);
        assert.match(captured[0], /\[\d{2}:\d{2}:\d{2}\] \[VERBOSE\].*Connecting to server/);
        assert.match(captured[1], /\[\d{2}:\d{2}:\d{2}\] \[DEBUG\].*Socket opened/);

        captured.length = 0;
        setLogLevel(true, true, true);
        log.info("hidden info");
        log.ok("hidden ok");
        log.verbose("hidden verbose");
        log.debug("hidden debug");
        const spin = log.spinner("hidden spinner");
        spin.succeed("done");
        assert.equal(captured.length, 0);
    } finally {
        console.log = origLog;
        setLogLevel(false, false, false);
    }
});
