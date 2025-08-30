#!/usr/bin/env node
import { Command } from "commander";
import { build } from "../src/commands/build.js";
import { deploy } from "../src/commands/deploy.js";
import { rollback } from "../src/commands/rollback.js";
import { list } from "../src/commands/list.js";
import { clean } from "../src/commands/clean.js";
import { health } from "../src/commands/health.js";


const program = new Command();


program
    .name("dploy")
    .description("Universal deployment tool (current features MVP)")
    .version("0.1.0");


program
    .command("build")
    .description("Build and package the project (copy strategy)")
    .option("-v, --version <ver>", "Override version string")
    .action(async (opts) => {
        await build(opts); // ignore returned artifactPath
    });


program
    .command("deploy")
    .description("Deploy to remote server")
    .option("-e, --env <name>", "Environment name (default from .env.deploy)")
    .option("--artifact <path>", "Path to prebuilt artifact (skips build)")
    .option("-v, --version <ver>", "Override version string")
    .action(deploy);


program
    .command("rollback")
    .description("Rollback to previous release")
    .option("-e, --env <name>", "Environment name")
    .action(rollback);


program
    .command("list")
    .description("List releases on remote")
    .option("-e, --env <name>", "Environment name")
    .action(list);


program
    .command("clean")
    .description("Remove old releases beyond keepVersions")
    .option("-e, --env <name>", "Environment name")
    .action(clean);


program
    .command("health")
    .description("Call the health endpoint")
    .option("-e, --env <name>", "Environment name")
    .action(health);


program.parse(process.argv);
