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
