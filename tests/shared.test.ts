import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { linkShared } from "../src/features/shared.js";

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

test("linkShared creates shared directory and empty files if they do not exist", async () => {
  const { ssh, executedCommands } = createMockSSH({
    "[ -e": "0\n", // does not exist
  });

  await linkShared(
    ssh,
    "/var/www/app",
    "/var/www/app/releases/v1",
    [".env", "uploads/"],
    undefined
  );

  // Checks shared dir was created
  assert.ok(executedCommands.some((c) => c.includes("mkdir -p '/var/www/app/shared'")));
  // Checks .env was NOT created as a directory
  assert.ok(!executedCommands.some((c) => c === "mkdir -p '/var/www/app/shared/.env'"));
  // Checks .env was touched
  assert.ok(executedCommands.some((c) => c.includes("touch '/var/www/app/shared/.env'")));
  // Checks uploads directory was created
  assert.ok(executedCommands.some((c) => c.includes("mkdir -p '/var/www/app/shared/uploads/'")));
  // Checks symlinks created
  assert.ok(executedCommands.some((c) => c.includes("ln -sfn '/var/www/app/shared/.env' '/var/www/app/releases/v1/.env'")));
  assert.ok(executedCommands.some((c) => c.includes("ln -sfn '/var/www/app/shared/uploads' '/var/www/app/releases/v1/uploads'")));
});

test("linkShared seeds from sharedDefaults when item does not exist", async () => {
  const { ssh, executedCommands } = createMockSSH({
    "[ -e": "0\n",
  });

  await linkShared(
    ssh,
    "/var/www/app",
    "/var/www/app/releases/v1",
    [".env"],
    { ".env": ".env.example" }
  );

  assert.ok(
    executedCommands.some(
      (c) =>
        c.includes("cp -r '/var/www/app/releases/v1/.env.example' '/var/www/app/shared/.env'")
    )
  );
  assert.ok(
    executedCommands.some((c) =>
      c.includes("ln -sfn '/var/www/app/shared/.env' '/var/www/app/releases/v1/.env'")
    )
  );
});

test("linkShared skips creation when shared item already exists", async () => {
  const { ssh, executedCommands } = createMockSSH({
    "[ -e": "1\n", // already exists
  });

  await linkShared(
    ssh,
    "/var/www/app",
    "/var/www/app/releases/v1",
    [".env"],
    { ".env": ".env.example" }
  );

  // Should NOT touch or copy default
  assert.ok(!executedCommands.some((c) => c.includes("touch '/var/www/app/shared/.env'")));
  assert.ok(!executedCommands.some((c) => c.includes("cp -r")));
  // Should still link
  assert.ok(
    executedCommands.some((c) =>
      c.includes("ln -sfn '/var/www/app/shared/.env' '/var/www/app/releases/v1/.env'")
    )
  );
});

test("linkShared seeds directory from release artifact when item exists in release (e.g. writable/)", async () => {
  const { ssh, executedCommands } = createMockSSH({
    "[ -e": "0\n",
  });

  await linkShared(
    ssh,
    "/var/www/app",
    "/var/www/app/releases/v1",
    ["writable/"],
    undefined
  );

  // Checks that release item is copied over to shared to preserve starter directories/files
  assert.ok(
    executedCommands.some(
      (c) =>
        c.includes("cp -r '/var/www/app/releases/v1/writable' '/var/www/app/shared/writable'")
    )
  );
  assert.ok(
    executedCommands.some((c) =>
      c.includes("ln -sfn '/var/www/app/shared/writable' '/var/www/app/releases/v1/writable'")
    )
  );
});

test("linkShared auto-detects directories without trailing slash and links cleanly", async () => {
  const { ssh, executedCommands } = createMockSSH({
    "[ -e": "0\n",
  });

  await linkShared(
    ssh,
    "/var/www/app",
    "/var/www/app/releases/v1",
    ["storage"], // no trailing slash
    undefined
  );

  // Checks that directory is inspected and copied without trailing slash issues
  assert.ok(
    executedCommands.some(
      (c) =>
        c.includes("cp -r '/var/www/app/releases/v1/storage' '/var/www/app/shared/storage'")
    )
  );
  assert.ok(
    executedCommands.some((c) =>
      c.includes("ln -sfn '/var/www/app/shared/storage' '/var/www/app/releases/v1/storage'")
    )
  );
});

test("linkShared normalizes wildcard path like writable/* to directory writable/", async () => {
  const { ssh, executedCommands } = createMockSSH({
    "[ -e": "0\n",
  });

  await linkShared(
    ssh,
    "/var/www/app",
    "/var/www/app/releases/v1",
    ["writable/*"],
    undefined
  );

  assert.ok(
    executedCommands.some(
      (c) =>
        c.includes("cp -r '/var/www/app/releases/v1/writable' '/var/www/app/shared/writable'")
    )
  );
  assert.ok(
    executedCommands.some((c) =>
      c.includes("ln -sfn '/var/www/app/shared/writable' '/var/www/app/releases/v1/writable'")
    )
  );
});

test("linkShared does not create .env as directory and ensures writable subdirectories", async () => {
  const { ssh, executedCommands } = createMockSSH({
    "[ -e": "0\n",
  });

  await linkShared(
    ssh,
    "/var/www/app",
    "/var/www/app/releases/v1",
    [".env", "writable/"],
    undefined
  );

  // Must NOT mkdir -p on .env
  assert.ok(!executedCommands.some((c) => c === "mkdir -p '/var/www/app/shared/.env'"));
  // Must touch .env as file
  assert.ok(executedCommands.some((c) => c.includes("touch '/var/www/app/shared/.env'")));
  // Must ensure writable subdirectories
  assert.ok(executedCommands.some((c) => c.includes("mkdir -p '/var/www/app/shared/writable'/cache")));
});
