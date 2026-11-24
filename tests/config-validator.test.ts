import assert from "node:assert/strict";
import { test } from "node:test";
import { validateDeployConfig, assertValidDeployConfig } from "../src/core/config-validator.js";

test("validateDeployConfig accepts valid configuration", () => {
    const valid = {
        name: "my-app",
        build: {
            strategy: "include",
            include: ["src/**"],
            exclude: ["node_modules/**"],
        },
        environments: {
            production: {
                host: "example.com",
                username: "deploy",
                port: 22,
                deployTo: "/var/www/app",
                keepVersions: 5,
            },
        },
        database: {
            type: "mysql",
            name: "app_db",
        },
    };

    const res = validateDeployConfig(valid);
    assert.equal(res.valid, true);
    assert.equal(res.errors.length, 0);
    assert.doesNotThrow(() => assertValidDeployConfig(valid));
});

test("validateDeployConfig catches invalid port, strategy, deployTo root, and db type", () => {
    const invalid = {
        build: {
            strategy: "invalid-strat",
        },
        environments: {
            prod: {
                port: 999999,
                deployTo: "/",
                keepVersions: -1,
            },
        },
        database: {
            type: "mongo",
        },
    };

    const res = validateDeployConfig(invalid);
    assert.equal(res.valid, false);

    const paths = res.errors.map((e) => e.path);
    assert.ok(paths.includes("build.strategy"));
    assert.ok(paths.includes("environments.prod.port"));
    assert.ok(paths.includes("environments.prod.deployTo"));
    assert.ok(paths.includes("environments.prod.keepVersions"));
    assert.ok(paths.includes("database.type"));

    assert.throws(() => assertValidDeployConfig(invalid), /Configuration schema validation failed/);
});

test("validateDeployConfig accepts numeric string port and keepVersions from env interpolation", () => {
    const configWithStrings = {
        environments: {
            staging: {
                host: "example.com",
                username: "deploy",
                port: "22",
                deployTo: "/var/www/app",
                keepVersions: "5",
            },
        },
    };

    const res = validateDeployConfig(configWithStrings);
    assert.equal(res.valid, true);
    assert.doesNotThrow(() => assertValidDeployConfig(configWithStrings));
});
