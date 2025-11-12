#!/usr/bin/env node
import { Command } from "commander";
import { build } from "../src/commands/build.js";
import { deploy } from "../src/commands/deploy.js";
import { rollback } from "../src/commands/rollback.js";
import { list } from "../src/commands/list.js";
import { clean } from "../src/commands/clean.js";
import { health } from "../src/commands/health.js";
import { init } from "../src/commands/init.js";
import { setLogLevel } from "../src/core/logger.js";
import { getAppVersion } from "../src/core/utils.js";
import { loadConfig, getEnvironmentConfig } from "../src/core/config.js";

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
        .version(getAppVersion());

    // Hook to set log levels before executing any command
    program.hook("preAction", async (thisCommand) => {
        const opts = thisCommand.opts();
        setLogLevel(!!opts.debug, !!opts.verbose);

        const cwd = process.cwd();
        const config = await loadConfig(cwd);
        const envConf = getEnvironmentConfig(config, opts.env);

        // Attach to command context
        (thisCommand as any).config = config;
        (thisCommand as any).envConf = envConf;
    });


    // Commands
    program
        .command("init [template]")
        .description("Initialize a new deploy.config.yml from templates")
        .action((template) => init({ template }));

    program
        .command("build")
        .description("Build and package the project (copy strategy)")
        .option("-v, --version <ver>", "Override version string")
        .action(async (opts) => {
            await build(opts);
        });

    program
        .command("deploy")
        .description("Deploy to remote server")
        .option("--artifact <path>", "Path to prebuilt artifact (skips build)")
        .option("-v, --version <ver>", "Override version string")
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
        .action(clean);

    program
        .command("health")
        .description("Call the health endpoint")
        .action(health);

    program.parse(process.argv);
    const opts = program.opts();

    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    const envConf = getEnvironmentConfig(config, opts.env);
}

// ✅ Run main entry
main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
});
