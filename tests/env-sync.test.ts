import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnvContent, updateOrAppendEnv } from "../src/features/env-sync.js";

test("parseEnvContent parses key-value pairs ignoring comments and empty lines", () => {
    const raw = `
# Database configuration
DB_HOST=127.0.0.1
DB_PORT=3306

# App secrets
APP_KEY=base64:randomkey123=
EMPTY_KEY=
`;
    const result = parseEnvContent(raw);

    assert.equal(result.entries.get("DB_HOST"), "127.0.0.1");
    assert.equal(result.entries.get("DB_PORT"), "3306");
    assert.equal(result.entries.get("APP_KEY"), "base64:randomkey123=");
    assert.equal(result.entries.get("EMPTY_KEY"), "");
    assert.equal(result.entries.has("NOT_EXIST"), false);
});

test("updateOrAppendEnv updates an existing key in place preserving surrounding comments", () => {
    const original = `# Comment
DB_HOST=localhost
DB_PORT=3306
`;
    const updated = updateOrAppendEnv(original, "DB_HOST", "192.168.1.100");

    assert.ok(updated.includes("DB_HOST=192.168.1.100"));
    assert.ok(updated.includes("# Comment"));
    assert.ok(updated.includes("DB_PORT=3306"));
    assert.ok(!updated.includes("DB_HOST=localhost"));
});

test("updateOrAppendEnv appends a new key if it does not exist", () => {
    const original = `APP_ENV=production`;
    const updated = updateOrAppendEnv(original, "NEW_SECRET", "supersecret");

    assert.ok(updated.includes("APP_ENV=production"));
    assert.ok(updated.includes("NEW_SECRET=supersecret"));
});
