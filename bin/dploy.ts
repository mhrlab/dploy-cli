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
        .option("-d, --debug", "Enable debug logging");

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
        .action((opts, cmd) => deploy(cmd.optsWithGlobals()));

    program
        .command("rollback")
        .description("Rollback to previous release")
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("--latest", "Rollback to the previous release without prompting")
        .option("--to <version>", "Rollback to a specific release by name")
        .option("-n, --dry-run", "Show what would be changed without switching the symlink")
        .action((opts, cmd) => rollback(cmd.optsWithGlobals()));

    program
        .command("list")
        .description("List releases on remote")
        .option("-e, --env <env>", "Target environment (default: production)")
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

    program.parse(process.argv);
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
