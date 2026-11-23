#!/usr/bin/env node
import { Command, Option } from "commander";
import { build } from "../src/commands/build.js";
import { deploy } from "../src/commands/deploy.js";
import { rollback } from "../src/commands/rollback.js";
import { list } from "../src/commands/list.js";
import { clean } from "../src/commands/clean.js";
import { status } from "../src/commands/status.js";
import { health } from "../src/commands/health.js";
import { init } from "../src/commands/init.js";
import { provision } from "../src/commands/provision.js";
import { setup } from "../src/commands/setup.js";
import { ssh } from "../src/commands/ssh.js";
import { run } from "../src/commands/run.js";
import { envPush, envPull, envSet } from "../src/commands/env.js";
import { logs } from "../src/commands/logs.js";
import { down, up } from "../src/commands/maintenance.js";
import { setLogLevel } from "../src/core/logger.js";
import { getAppVersion } from "../src/core/utils.js";



// 🧩 Global SIGINT handler (Ctrl + C)
process.on("SIGINT", () => {
    console.log("\n⚠️  Operation cancelled by user.\n");
    process.exit(0);
});

// 🧩 Global unhandled rejection handler (for Inquirer ExitPromptError, etc.)
process.on("unhandledRejection", (err: any) => {
    if (err?.name === "ExitPromptError" || /SIGINT/i.test(err?.message)) {
        console.log("\n⚠️  Prompt cancelled by user.\n");
        process.exit(0);
    }

    console.error("❌ Unhandled error:", err);
    process.exit(1);
});


async function main() {
    const program = new Command();

    // Global options
    program
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("-v, --verbose", "Enable verbose logging")
        .option("-d, --debug", "Enable debug logging")
        .option("-y, --yes", "Automatic yes to prompts; non-interactive mode");

    program
        .name("dploy")
        .description("Universal deployment tool (MVP version)")
        .version(getAppVersion(), "-a, --app-version");

    // Hook to set log levels before executing any command
    program.hook("preAction", (thisCommand) => {
        const opts = thisCommand.opts();
        setLogLevel(!!opts.debug, !!opts.verbose || !!opts.dryRun);
    });

    // Commands
    program
        .command("init [template]")
        .description("Initialize a new deploy.config.yml from templates")
        .action((template) => init({ template }));

    program
        .command("build")
        .description("Build and package the project (copy strategy)")
        .option("-V, --version <ver>", "Override version string")
        .option("-n, --dry-run", "Show planned build actions without writing files")
        .action(async (opts, cmd) => {
            await build(cmd.optsWithGlobals());
        });

    program
        .command("deploy")
        .description("Deploy to remote server")
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("-A, --artifact <path>", "Path to a custom archive to upload (skips build)")
        .addOption(new Option("--archive <path>", "Alias for --artifact").hideHelp())
        .option("-s, --skip-build", "Skip local build and use an existing artifact")
        .option("-V, --version <ver>", "Override version string")
        .option("-n, --dry-run", "Show planned deploy actions without changing anything")
        .option("--keep-artifact", "Preserve local build artifact archive after deployment")
        .option("--no-auto-rollback", "Disable automatic rollback if health check fails")
        .option("--no-health-gate", "Do not abort deployment if health check fails")
        .option("--maintenance", "Put site into maintenance mode during deployment")
        .option("--backup-db", "Take automated pre-deployment database backup before release cutover")
        .action((opts, cmd) => deploy(cmd.optsWithGlobals()));

    program
        .command("rollback")
        .description("Rollback to previous release")
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("--latest", "Rollback to the previous release without prompting")
        .option("--to <version>", "Rollback to a specific release by name")
        .option("-n, --dry-run", "Show what would be changed without switching the symlink")
        .option("-y, --yes", "Automatic yes to prompts; roll back to previous release without prompt")
        .option("--non-interactive", "Run in non-interactive mode without terminal prompts")
        .action((opts, cmd) => rollback(cmd.optsWithGlobals()));

    program
        .command("list")
        .description("List releases on remote")
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("--json", "Output machine-readable JSON status")
        .action((opts, cmd) => list(cmd.optsWithGlobals()));

    program
        .command("clean")
        .description("Remove old releases beyond keepVersions")
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("-n, --dry-run", "Show which releases would be removed without deleting them")
        .action((opts, cmd) => clean(cmd.optsWithGlobals()));

    program
        .command("status")
        .description("Show current release and remote deployment status")
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("--json", "Output machine-readable JSON status")
        .action((opts, cmd) => status(cmd.optsWithGlobals()));

    program
        .command("health")
        .description("Call the health endpoint")
        .option("-e, --env <env>", "Target environment (default: production)")
        .action((opts, cmd) => health(cmd.optsWithGlobals()));

    program
        .command("provision")
        .alias("setup-server")
        .description("Prepare a fresh remote server for deployments")
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("-n, --dry-run", "Preview planned server changes without executing")
        .option("--force", "Re-run all steps even if directories/files exist")
        .option("--skip-checks", "Skip prerequisite verification (tar, curl, runtime)")
        .option("--only <step>", "Run a specific provisioning step (prereqs, dirs, shared, permissions, service)")
        .option("--json", "Output machine-readable JSON status")
        .action(async (opts, cmd) => {
            await provision(cmd.optsWithGlobals());
        });

    program
        .command("setup")
        .description("Interactive server setup wizard: configure Nginx, background services, and SSL")
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("-n, --dry-run", "Preview planned Nginx and systemd configs without touching the server")
        .option("--webserver <type>", "Web server type (nginx, none)")
        .option("--kind <type>", "App type (node, php, spa)")
        .option("--domain <domain>", "Domain name(s)")
        .option("--port <port>", "Upstream port for Node.js reverse proxy")
        .option("--php-socket <path>", "PHP-FPM socket path")
        .option("--certbot", "Obtain Let's Encrypt SSL via Certbot")
        .option("--service", "Create and enable a systemd background service")
        .option("--exec-start <cmd>", "ExecStart command for systemd unit")
        .option("--queue-worker", "Create and enable a background queue worker (e.g. for Laravel/PHP)")
        .option("--worker-command <cmd>", "Command for the queue worker service")
        .action(async (opts, cmd) => {
            await setup(cmd.optsWithGlobals());
        });

    program
        .command("ssh")
        .description("Open an interactive SSH terminal on the remote server")
        .option("-e, --env <env>", "Target environment (default: production)")
        .action(async (opts, cmd) => {
            await ssh(cmd.optsWithGlobals());
        });

    program
        .command("run <command>")
        .description("Execute an ad-hoc command on the remote server inside current release")
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("--release <name>", "Execute inside a specific release directory instead of current")
        .action(async (command, opts, cmd) => {
            await run(command, cmd.optsWithGlobals());
        });

    program
        .command("env:push")
        .description("Upload local .env to remote shared/.env with automatic backup")
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("-f, --file <path>", "Specific local .env file to upload")
        .option("--force", "Overwrite remote .env without interactive prompt")
        .option("-y, --yes", "Automatic yes to prompts")
        .action(async (opts, cmd) => {
            await envPush(cmd.optsWithGlobals());
        });

    program
        .command("env:pull")
        .description("Download remote shared/.env to local file")
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("-o, --out <path>", "Destination local path (default: .env.<env>.remote)")
        .option("--force", "Overwrite local file if it already exists")
        .option("-y, --yes", "Automatic yes to prompts")
        .action(async (opts, cmd) => {
            await envPull(cmd.optsWithGlobals());
        });

    program
        .command("env:set <pair>")
        .description("Set or update a KEY=VALUE variable in remote shared/.env")
        .option("-e, --env <env>", "Target environment (default: production)")
        .action(async (pair, opts, cmd) => {
            await envSet(pair, cmd.optsWithGlobals());
        });

    program
        .command("logs")
        .description("Stream or tail remote application/server logs")
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("-f, --follow", "Follow log output (stream real-time)")
        .option("-n, --lines <count>", "Number of lines to show (default: 50)")
        .option("--type <type>", "Log type: app, nginx, pm2, or systemd")
        .option("--file <path>", "Specific remote log file to tail")
        .action(async (opts, cmd) => {
            await logs(cmd.optsWithGlobals());
        });

    program
        .command("down")
        .description("Put the remote site into maintenance mode")
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("-m, --message <msg>", "Custom maintenance message")
        .option("--retry <seconds>", "Suggested Retry-After header value in seconds (default: 300)")
        .action(async (opts, cmd) => {
            await down(cmd.optsWithGlobals());
        });

    program
        .command("up")
        .description("Take the remote site out of maintenance mode (restore traffic)")
        .option("-e, --env <env>", "Target environment (default: production)")
        .action(async (opts, cmd) => {
            await up(cmd.optsWithGlobals());
        });

    await program.parseAsync(process.argv);
}

// ✅ Run main entry
main().catch((err) => {
    if (err?.name === "ExitPromptError" || /SIGINT/i.test(err?.message)) {
        console.log("\n⚠️  Prompt cancelled by user.\n");
        process.exit(0);
    }

    console.error("❌ CLI Error:", err);
    process.exit(1);
});
