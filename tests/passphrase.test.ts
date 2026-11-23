import { test } from "node:test";
import assert from "node:assert/strict";
import {
    isEncryptedPrivateKey,
    resolvePassphrase,
    setCachedPassphrase,
    getCachedPassphrase,
} from "../src/core/ssh.js";

test("ssh - isEncryptedPrivateKey detects encrypted PEM and OpenSSH keys", () => {
    const unencryptedKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAz...
-----END RSA PRIVATE KEY-----`;

    const encryptedOpensshKey = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAENmJj...
-----END OPENSSH PRIVATE KEY-----`;

    const encryptedPemKey = `-----BEGIN RSA PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-128-CBC,F68C36B...
-----END RSA PRIVATE KEY-----`;

    const pkcs8EncryptedKey = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIIFHDBOBgkqhkiG9w0BBQ0wQTApBgkqhkiG9w0BBQwwHAQIf0f...
-----END ENCRYPTED PRIVATE KEY-----`;

    assert.equal(isEncryptedPrivateKey(unencryptedKey), false);
    assert.equal(isEncryptedPrivateKey(encryptedPemKey), true);
    assert.equal(isEncryptedPrivateKey(pkcs8EncryptedKey), true);
});

test("ssh - resolvePassphrase retrieves from environment config", async () => {
    const env = {
        host: "example.com",
        username: "deployer",
        passphrase: "config-secret-passphrase",
    };

    const pass = await resolvePassphrase(env);
    assert.equal(pass, "config-secret-passphrase");
});

test("ssh - resolvePassphrase retrieves from process.env", async () => {
    const origEnv = process.env.DPLOY_PASSPHRASE;
    try {
        process.env.DPLOY_PASSPHRASE = "env-secret-passphrase";
        const env = { host: "example.com", username: "deployer" };
        const pass = await resolvePassphrase(env);
        assert.equal(pass, "env-secret-passphrase");
    } finally {
        if (origEnv !== undefined) {
            process.env.DPLOY_PASSPHRASE = origEnv;
        } else {
            delete process.env.DPLOY_PASSPHRASE;
        }
    }
});

test("ssh - resolvePassphrase uses cached passphrase across connections", async () => {
    setCachedPassphrase("cached-memory-passphrase");
    assert.equal(getCachedPassphrase(), "cached-memory-passphrase");

    const env = { host: "example.com", username: "deployer" };
    const pass = await resolvePassphrase(env);
    assert.equal(pass, "cached-memory-passphrase");

    // Clean up cache
    setCachedPassphrase(null);
    assert.equal(getCachedPassphrase(), null);
});
