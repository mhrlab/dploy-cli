import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { test } from "node:test";

import {
  checkRemotePrerequisites,
  executeProvisioning,
  normalizeServices,
  planProvisioningOffline,
  provisionDirectories,
  provisionPermissions,
  provisionService,
  provisionServices,
  provisionSharedResources,
} from "../src/features/provisioner.js";
import { provision } from "../src/commands/provision.js";

function createMockSSH(responses: Record<string, string> = {}) {
  const executedCommands: string[] = [];

  const ssh: any = {
    exec: (command: string, cb: (err: any, stream: any) => void) => {
      executedCommands.push(command);
      const stream = new EventEmitter() as any;
      stream.stderr = new EventEmitter();

      cb(null, stream);

      process.nextTick(() => {
        let output = "";
        for (const [pattern, resp] of Object.entries(responses)) {
          if (command.includes(pattern)) {
            output = resp;
            break;
          }
        }
        if (output) {
          stream.emit("data", Buffer.from(output));
        }
        stream.emit("close", 0);
      });
    },
  };

  return { ssh, executedCommands };
}

test("checkRemotePrerequisites passes when required binaries are present", async () => {
  const { ssh } = createMockSSH({
    "tar": "ok\n",
    "curl": "ok\n",
    "node": "v20.10.0\n",
  });

  const res = await checkRemotePrerequisites(ssh, { node: "20" }, false);
  assert.equal(res.status, "ok");
  assert.equal(res.step, "prereqs");
  assert.ok(res.details?.some((d) => d.includes("tar found")));
  assert.ok(res.details?.some((d) => d.includes("node found")));
});

test("checkRemotePrerequisites fails when a required binary is missing", async () => {
  const { ssh } = createMockSSH({
    "tar": "missing\n",
    "curl": "ok\n",
  });

  const res = await checkRemotePrerequisites(ssh, undefined, false);
  assert.equal(res.status, "failed");
  assert.ok(res.message.includes("Missing prerequisites: tar"));
});

test("provisionDirectories creates default and custom directories", async () => {
  const { ssh, executedCommands } = createMockSSH();

  const res = await provisionDirectories(ssh, "/var/www/app", ["custom_cache"], false);
  assert.equal(res.status, "ok");
  assert.ok(executedCommands.some((c) => c.includes("mkdir -p '/var/www/app/releases'")));
  assert.ok(executedCommands.some((c) => c.includes("mkdir -p '/var/www/app/shared'")));
  assert.ok(executedCommands.some((c) => c.includes("mkdir -p '/var/www/app/tmp'")));
  assert.ok(executedCommands.some((c) => c.includes("mkdir -p '/var/www/app/logs'")));
  assert.ok(executedCommands.some((c) => c.includes("mkdir -p '/var/www/app/custom_cache'")));
});

test("provisionSharedResources creates shared directories and touches files", async () => {
  const { ssh, executedCommands } = createMockSSH({
    "[ -e": "0\n",
  });

  const res = await provisionSharedResources(
    ssh,
    "/var/www/app",
    [".env", "storage/"],
    {},
    false,
    false
  );

  assert.equal(res.status, "ok");
  assert.ok(executedCommands.some((c) => c.includes("mkdir -p '/var/www/app/shared/storage/'")));
  assert.ok(executedCommands.some((c) => c.includes("touch '/var/www/app/shared/.env'")));
});

test("provisionPermissions sets mode, sharedMode, and ownership", async () => {
  const { ssh, executedCommands } = createMockSSH();

  const res = await provisionPermissions(
    ssh,
    "/var/www/app",
    {
      mode: "755",
      sharedMode: "775",
      owner: "deploy",
      group: "www-data",
    },
    false
  );

  assert.equal(res.status, "ok");
  assert.ok(executedCommands.some((c) => c.includes("chmod '755' '/var/www/app'")));
  assert.ok(executedCommands.some((c) => c.includes("chmod -R '775' '/var/www/app/shared'")));
  assert.ok(executedCommands.some((c) => c.includes("chown -R 'deploy:www-data' '/var/www/app'")));
});

test("provisionService checks systemd service status", async () => {
  const { ssh, executedCommands } = createMockSSH({
    "systemctl is-active": "active\n",
  });

  const res = await provisionService(ssh, { type: "systemd", name: "my-app" }, false);
  assert.equal(res.status, "ok");
  assert.ok(executedCommands.some((c) => c.includes("systemctl is-active 'my-app'")));
  assert.ok(res.details?.some((d) => d.includes("active")));
});

test("normalizeServices normalizes strings and objects", () => {
  const services = normalizeServices(
    { name: "web-app", type: "systemd" },
    ["redis", "mysql", { name: "custom-worker", type: "pm2" }]
  );

  assert.equal(services.length, 4);
  assert.deepEqual(services[0], { name: "web-app", type: "systemd" });
  assert.deepEqual(services[1], { name: "redis", type: "systemd" });
  assert.deepEqual(services[2], { name: "mysql", type: "systemd" });
  assert.deepEqual(services[3], { name: "custom-worker", type: "pm2" });
});

test("provisionServices checks multiple services and reports status", async () => {
  const { ssh } = createMockSSH({
    "redis": "active\n",
    "mysql": "active\n",
  });

  const res = await provisionServices(
    ssh,
    [
      { name: "redis", type: "systemd" },
      { name: "mysql", type: "systemd" },
    ],
    false
  );

  assert.equal(res.status, "ok");
  assert.equal(res.details?.length, 2);
  assert.ok(res.details?.some((d) => d.includes("redis' state: active")));
  assert.ok(res.details?.some((d) => d.includes("mysql' state: active")));
});

test("provisionServices marks status failed if any service is inactive", async () => {
  const { ssh } = createMockSSH({
    "redis": "active\n",
    "mysql": "inactive\n",
  });

  const res = await provisionServices(
    ssh,
    [
      { name: "redis", type: "systemd" },
      { name: "mysql", type: "systemd" },
    ],
    false
  );

  assert.equal(res.status, "failed");
  assert.ok(res.message.includes("not active"));
});

test("executeProvisioning honors --only filter", async () => {
  const { ssh, executedCommands } = createMockSSH();

  const report = await executeProvisioning(
    { ssh, sftp: {} as any },
    {
      deployTo: "/var/www/app",
      provision: {
        dirs: ["extra"],
        shared: [".env"],
      },
    },
    {
      only: "dirs",
      dryRun: false,
    }
  );

  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].step, "dirs");
  assert.ok(executedCommands.some((c) => c.includes("mkdir -p '/var/www/app/extra'")));
});

test("planProvisioningOffline generates complete dry-run plan without SSH connection", () => {
  const report = planProvisioningOffline(
    {
      deployTo: "/var/www/myapp",
      provision: {
        dirs: ["custom"],
        permissions: { mode: "755", owner: "deploy" },
        service: { type: "systemd", name: "myapp" },
        services: ["redis", "postgresql"],
        runtime: { node: "20" },
      },
    },
    { dryRun: true }
  );

  assert.equal(report.dryRun, true);
  assert.equal(report.success, true);
  const stepNames = report.steps.map((s) => s.step);
  assert.ok(stepNames.includes("prereqs"));
  assert.ok(stepNames.includes("dirs"));
  assert.ok(stepNames.includes("permissions"));
  assert.ok(stepNames.includes("service"));

  const serviceStep = report.steps.find((s) => s.step === "service");
  assert.equal(serviceStep?.details?.length, 3);
});

test("provision command throws when deployTo is missing or root", async () => {
  const originalCwd = process.cwd();
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dploy-prov-"));

  try {
    process.chdir(cwd);
    await writeFile(
      path.join(cwd, "deploy.config.json"),
      JSON.stringify({
        environments: {
          prod: {
            deployTo: "/",
          },
        },
      }),
      "utf8"
    );

    await assert.rejects(
      async () => {
        await provision({ env: "prod" });
      },
      /Refusing to provision root directory/
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test("provision command runs offline dry-run and returns report", async () => {
  const originalCwd = process.cwd();
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dploy-prov-"));

  try {
    process.chdir(cwd);
    await writeFile(
      path.join(cwd, "deploy.config.json"),
      JSON.stringify({
        environments: {
          staging: {
            deployTo: "/var/www/staging",
            provision: {
              dirs: ["logs"],
            },
          },
        },
      }),
      "utf8"
    );

    const report = await provision({ env: "staging", dryRun: true, json: true });
    assert.equal(report.deployTo, "/var/www/staging");
    assert.equal(report.dryRun, true);
    assert.equal(report.success, true);
  } finally {
    process.chdir(originalCwd);
  }
});
