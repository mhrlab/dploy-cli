#!/usr/bin/env node
import { Command } from "commander";
import { build } from "../src/commands/build.js";
import { deploy } from "../src/commands/deploy.js";
import { rollback } from "../src/commands/rollback.js";
import { list } from "../src/commands/list.js";
import { clean } from "../src/commands/clean.js";
import { status } from "../src/commands/status.js";
import { health } from "../src/commands/health.js";
import { init } from "../src/commands/init.js";
import {log, setLogLevel} from "../src/core/logger.js";
import { getAppVersion } from "../src/core/utils.js";
import { loadConfig, getEnvironmentConfig } from "../src/core/config.js";



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
        .option("-e, --env <env>", "Environment name (default: production)", "production")
        .option("-v, --verbose", "Enable verbose logging")
        .option("-d, --debug", "Enable debug logging");

    program
        .name("dploy")
        .description("Universal deployment tool (MVP version)")
        .version(getAppVersion(), "-a, --app-version");

    // Hook to set log levels before executing any command
    program.hook("preAction", async (thisCommand) => {
        let opts = thisCommand.opts();
        setLogLevel(!!opts.debug, !!opts.verbose || !!opts.dryRun);
        const skipFor = ["help", "init"];

        if (skipFor.includes(thisCommand.name())) {
            log.debug(`[HOOK] Skipping hook for ${thisCommand.name()}`);
            return;
        }

        opts = thisCommand.opts();
        const cwd = process.cwd();

        try {
            const config = await loadConfig(cwd);
            const envConf = getEnvironmentConfig(config, opts.env);

            (thisCommand as any).config = config;
            (thisCommand as any).envConf = envConf;
        } catch (err) {
            log.warn(`[HOOK] ${err}`);
        }
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
        .action(async (opts) => {
            await build(opts);
        });

    program
        .command("deploy")
        .description("Deploy to remote server")
        .option("--artifact <path>", "Path to a custom archive to upload (skips build)")
        .option("-A, --archive <path>", "Alias for --artifact")
        .option("-s, --skip-build", "Skip local build and use an existing artifact")
        .option("-V, --version <ver>", "Override version string")
        .option("-n, --dry-run", "Show planned deploy actions without changing anything")
        .action(deploy);

    program
        .command("rollback")
        .description("Rollback to previous release")
        .action(rollback);

    program
        .command("list")
        .description("List releases on remote")
        .action(list);

    program
        .command("clean")
        .description("Remove old releases beyond keepVersions")
        .option("-n, --dry-run", "Show which releases would be removed without deleting them")
        .action(clean);

    program
        .command("status")
        .description("Show current release and remote deployment status")
        .action(status);

    program
        .command("health")
        .description("Call the health endpoint")
        .action(health);

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
