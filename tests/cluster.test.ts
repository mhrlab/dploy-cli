import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { deploy } from "../src/commands/deploy.js";

test("cluster deployment - dry-run across multiple hosts in parallel and rolling mode", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dploy-cluster-test-"));
    const prevCwd = process.cwd();

    try {
        process.chdir(tmp);

        // Minimal package.json
        await fs.writeJson("package.json", { name: "cluster-app", version: "1.0.0" });

        // deploy.config.yml with multiple hosts
        const configYml = `
environments:
  cluster_parallel:
    hosts:
      - node1.internal
      - node2.internal
    username: deployer
    deployTo: /var/www/cluster
    strategy: parallel
  cluster_rolling:
    hosts:
      - node1.internal
      - node2.internal
      - node3.internal
    username: deployer
    deployTo: /var/www/cluster
    strategy: rolling
`;
        await fs.writeFile("deploy.config.yml", configYml.trim(), "utf-8");

        // Dry-run parallel
        await assert.doesNotReject(async () => {
            await deploy({
                env: "cluster_parallel",
                dryRun: true,
                version: "1.0.0",
            });
        });

        // Dry-run rolling
        await assert.doesNotReject(async () => {
            await deploy({
                env: "cluster_rolling",
                dryRun: true,
                version: "1.0.0",
            });
        });
    } finally {
        process.chdir(prevCwd);
        await fs.remove(tmp);
    }
});

test("cluster deployment - throws if environment has no host or hosts", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dploy-no-host-test-"));
    const prevCwd = process.cwd();

    try {
        process.chdir(tmp);
        await fs.writeJson("package.json", { name: "test-app", version: "1.0.0" });

        const configYml = `
environments:
  invalid_env:
    username: deployer
    deployTo: /var/www/app
`;
        await fs.writeFile("deploy.config.yml", configYml.trim(), "utf-8");

        await assert.rejects(
            async () => {
                await deploy({
                    env: "invalid_env",
                    dryRun: true,
                });
            },
            /has no target host\(s\) configured/
        );
    } finally {
        process.chdir(prevCwd);
        await fs.remove(tmp);
    }
});
