import fs from "fs-extra";
import path from "node:path";
import inquirer from "inquirer";
import chalk from "chalk";
import { loadConfig, configFiles, getEnvName } from "../core/config.js";
import { log, setLogLevel } from "../core/logger.js";

export interface TuiContext {
    hasConfig: boolean;
    configFile?: string;
    hasEnvDploy: boolean;
    appName?: string;
    environments: string[];
}

export interface TuiOptions {
    env?: string;
    dryRun?: boolean;
    verbose?: boolean;
    asAdmin?: boolean;
}

/**
 * Inspect the current working directory to discover project config, .env.dploy, and environments.
 */
export async function detectTuiContext(cwd = process.cwd()): Promise<TuiContext> {
    const candidates = [configFiles.config_yaml, configFiles.config_yml, configFiles.config_json];
    let foundConfig: string | undefined;
    for (const file of candidates) {
        if (await fs.pathExists(path.join(cwd, file))) {
            foundConfig = file;
            break;
        }
    }

    const hasEnvDploy = await fs.pathExists(path.join(cwd, ".env.dploy"));

    if (!foundConfig) {
        return {
            hasConfig: false,
            hasEnvDploy,
            environments: ["production"],
        };
    }

    try {
        const cfg = await loadConfig();
        const envNames = Object.keys(cfg.environments || {}).filter((k) => k !== "default");
        return {
            hasConfig: true,
            configFile: foundConfig,
            hasEnvDploy,
            appName: cfg.name,
            environments: envNames.length ? envNames : ["production"],
        };
    } catch {
        return {
            hasConfig: true,
            configFile: foundConfig,
            hasEnvDploy,
            environments: ["production"],
        };
    }
}

/**
 * Build a copy-pasteable CLI command string for interactive/streaming commands (ssh, logs -f, db console).
 */
export function buildCliCommandHint(
    subcommand: string,
    opts: { env?: string; asAdmin?: boolean; extraFlags?: string[] } = {}
): string {
    const parts = ["dploy", subcommand];
    if (opts.env) parts.push("-e", opts.env);
    if (opts.asAdmin) parts.push("-A");
    if (opts.extraFlags?.length) parts.push(...opts.extraFlags);
    return parts.join(" ");
}

function showCommandHint(title: string, command: string): void {
    console.log("");
    log.info(`${title} runs an interactive terminal stream. Run this command directly in your shell:`);
    console.log(chalk.cyan(`  ${command}\n`));
}

async function runSafe(fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (err: any) {
        log.err(err?.message || String(err));
    }
}

export async function tui(opts: TuiOptions = {}): Promise<void> {
    if (!process.stdin.isTTY) {
        throw new Error("Interactive TUI requires a TTY terminal. Run 'dploy --help' for CLI commands.");
    }

    let ctx = await detectTuiContext();
    let activeEnv = opts.env || (ctx.environments.includes(getEnvName()) ? getEnvName() : ctx.environments[0]);
    let dryRun = Boolean(opts.dryRun);
    let verbose = Boolean(opts.verbose);
    let asAdmin = Boolean(opts.asAdmin);

    while (true) {
        ctx = await detectTuiContext();
        setLogLevel(false, verbose || dryRun, false);

        console.log(chalk.bold.cyan("\n=== dploy Interactive Console ==="));
        console.log(
            chalk.gray(
                `Project: ${ctx.appName || (ctx.hasConfig ? ctx.configFile : "Not initialized")} | Env: ${activeEnv} | Dry-Run: ${dryRun ? "ON" : "OFF"} | Verbose: ${verbose ? "ON" : "OFF"} | Admin (-A): ${asAdmin ? "ON" : "OFF"}`
            )
        );
        if (!ctx.hasConfig) {
            log.warn("No deploy.config.yml found in this folder. Start with 'Setup & Server -> Initialize Project'.");
        }

        const { category } = await inquirer.prompt([
            {
                type: "list",
                name: "category",
                message: "What would you like to do?",
                choices: [
                    { name: "1. Deploy & Releases      (deploy, build, status, list, rollback, clean)", value: "deploy" },
                    { name: "2. Setup & Server         (init, setup wizard, add 2nd site, provision, doctor)", value: "setup" },
                    { name: "3. Site & SSL             (info, service manager, switch SSL, backup, remove)", value: "site" },
                    { name: "4. Environment (.env)     (edit, push, pull, set variable)", value: "env" },
                    { name: "5. Database               (create, backup, restore, optimize, drop, console)", value: "db" },
                    { name: "6. Logs, Shell & Safety   (logs, ssh, run command, health, down/up)", value: "ops" },
                    { name: "7. TUI Settings           (switch env, toggle dry-run / verbose / admin)", value: "settings" },
                    new inquirer.Separator(),
                    { name: "Exit", value: "exit" },
                ],
            },
        ]);

        if (category === "exit") {
            log.ok("Goodbye!");
            return;
        }

        const baseOpts = { env: activeEnv, dryRun, verbose, asAdmin };

        if (category === "deploy") {
            const { action } = await inquirer.prompt([
                {
                    type: "list",
                    name: "action",
                    message: "Deploy & Releases:",
                    choices: [
                        { name: "Deploy application", value: "deploy" },
                        { name: "Build package locally only", value: "build" },
                        { name: "Check deployment status", value: "status" },
                        { name: "List remote releases", value: "list" },
                        { name: "Rollback to previous release", value: "rollback" },
                        { name: "Clean old releases", value: "clean" },
                        { name: "<- Back", value: "back" },
                    ],
                },
            ]);
            if (action === "back") continue;

            if (action === "deploy") {
                const ans = await inquirer.prompt([
                    { type: "confirm", name: "backupDb", message: "Take pre-deploy database backup?", default: false },
                    { type: "confirm", name: "maintenance", message: "Enable maintenance mode during cutover?", default: false },
                ]);
                await runSafe(async () => {
                    const { deploy } = await import("./deploy.js");
                    await deploy({ ...baseOpts, backupDb: ans.backupDb, maintenance: ans.maintenance });
                });
            } else if (action === "build") {
                await runSafe(async () => {
                    const { build } = await import("./build.js");
                    await build({ dryRun });
                });
            } else if (action === "status") {
                await runSafe(async () => {
                    const { status } = await import("./status.js");
                    await status({ env: activeEnv });
                });
            } else if (action === "list") {
                await runSafe(async () => {
                    const { list } = await import("./list.js");
                    await list({ env: activeEnv });
                });
            } else if (action === "rollback") {
                await runSafe(async () => {
                    const { rollback } = await import("./rollback.js");
                    await rollback({ env: activeEnv, dryRun });
                });
            } else if (action === "clean") {
                await runSafe(async () => {
                    const { clean } = await import("./clean.js");
                    await clean({ env: activeEnv, dryRun });
                });
            }
        } else if (category === "setup") {
            const { action } = await inquirer.prompt([
                {
                    type: "list",
                    name: "action",
                    message: "Setup & Server:",
                    choices: [
                        { name: "Initialize project (dploy init)", value: "init" },
                        { name: "Validate config & SSH (dploy doctor)", value: "doctor" },
                        { name: "First-time server setup wizard (dploy setup)", value: "setup" },
                        { name: "Add 2nd site/domain to existing VPS (dploy site add)", value: "siteAdd" },
                        { name: "Provision directories & permissions (dploy provision)", value: "provision" },
                        { name: "<- Back", value: "back" },
                    ],
                },
            ]);
            if (action === "back") continue;

            if (action === "init") {
                await runSafe(async () => {
                    const { init } = await import("./init.js");
                    await init({});
                });
            } else if (action === "doctor") {
                const { testSsh } = await inquirer.prompt([
                    { type: "confirm", name: "testSsh", message: "Also test live SSH connection?", default: false },
                ]);
                await runSafe(async () => {
                    const { doctor } = await import("./doctor.js");
                    await doctor({ env: activeEnv, ssh: testSsh });
                });
            } else if (action === "setup") {
                await runSafe(async () => {
                    const { setup } = await import("./setup.js");
                    await setup({ env: activeEnv, dryRun });
                });
            } else if (action === "siteAdd") {
                await runSafe(async () => {
                    const { siteAdd } = await import("./site.js");
                    await siteAdd({ env: activeEnv, dryRun });
                });
            } else if (action === "provision") {
                await runSafe(async () => {
                    const { provision } = await import("./provision.js");
                    await provision({ env: activeEnv, dryRun, asAdmin });
                });
            }
        } else if (category === "site") {
            const { action } = await inquirer.prompt([
                {
                    type: "list",
                    name: "action",
                    message: "Site & SSL:",
                    choices: [
                        { name: "Inspect site info (Nginx, SSL, services)", value: "info" },
                        { name: "Manage background services (start/stop/restart/logs)", value: "service" },
                        { name: "Switch SSL mode (Certbot / Cloudflare)", value: "ssl" },
                        { name: "Backup site configs (Nginx, systemd, .env)", value: "backup" },
                        { name: "Remove site from server", value: "remove" },
                        { name: "<- Back", value: "back" },
                    ],
                },
            ]);
            if (action === "back") continue;

            await runSafe(async () => {
                const siteMod = await import("./site.js");
                if (action === "info") await siteMod.siteInfo(baseOpts);
                else if (action === "service") await siteMod.siteService(baseOpts);
                else if (action === "ssl") await siteMod.siteSsl(baseOpts);
                else if (action === "backup") await siteMod.siteBackup(baseOpts);
                else if (action === "remove") await siteMod.siteRemove(baseOpts);
            });
        } else if (category === "env") {
            const { action } = await inquirer.prompt([
                {
                    type: "list",
                    name: "action",
                    message: "Environment (.env):",
                    choices: [
                        { name: "Edit remote .env in local editor", value: "edit" },
                        { name: "Push local .env to server", value: "push" },
                        { name: "Pull remote .env to local file", value: "pull" },
                        { name: "Set a single KEY=VALUE variable", value: "set" },
                        { name: "<- Back", value: "back" },
                    ],
                },
            ]);
            if (action === "back") continue;

            await runSafe(async () => {
                const envMod = await import("./env.js");
                if (action === "edit") await envMod.envEdit({ env: activeEnv });
                else if (action === "push") await envMod.envPush({ env: activeEnv });
                else if (action === "pull") await envMod.envPull({ env: activeEnv });
                else if (action === "set") {
                    const { pair } = await inquirer.prompt([
                        { type: "input", name: "pair", message: "Enter KEY=VALUE:" },
                    ]);
                    if (pair?.trim()) await envMod.envSet(pair.trim(), { env: activeEnv });
                }
            });
        } else if (category === "db") {
            const { action } = await inquirer.prompt([
                {
                    type: "list",
                    name: "action",
                    message: "Database Management:",
                    choices: [
                        { name: "Create database & user", value: "create" },
                        { name: "Backup database", value: "backup" },
                        { name: "Restore database from dump file", value: "restore" },
                        { name: "Optimize database tables", value: "optimize" },
                        { name: "Drop database", value: "drop" },
                        { name: "Open interactive DB console (shows command)", value: "console" },
                        { name: "<- Back", value: "back" },
                    ],
                },
            ]);
            if (action === "back") continue;

            if (action === "console") {
                showCommandHint("Database Console", buildCliCommandHint("db console", { env: activeEnv, asAdmin }));
                continue;
            }

            await runSafe(async () => {
                const dbMod = await import("./database.js");
                if (action === "create") await dbMod.dbCreate(baseOpts);
                else if (action === "backup") {
                    const { download } = await inquirer.prompt([
                        { type: "confirm", name: "download", message: "Download backup to local machine?", default: true },
                    ]);
                    await dbMod.dbBackup({ ...baseOpts, download });
                } else if (action === "restore") {
                    const { file } = await inquirer.prompt([
                        { type: "input", name: "file", message: "Path to local or remote .sql / .sql.gz file:" },
                    ]);
                    if (file?.trim()) await dbMod.dbRestore(file.trim(), baseOpts);
                } else if (action === "optimize") await dbMod.dbOptimize(baseOpts);
                else if (action === "drop") await dbMod.dbDrop(baseOpts);
            });
        } else if (category === "ops") {
            const { action } = await inquirer.prompt([
                {
                    type: "list",
                    name: "action",
                    message: "Logs, Shell & Safety:",
                    choices: [
                        { name: "View recent logs (or get live -f command)", value: "logs" },
                        { name: "Open SSH shell (shows command)", value: "ssh" },
                        { name: "Run a one-off remote command", value: "run" },
                        { name: "Check HTTP health endpoint", value: "health" },
                        { name: "Enable maintenance mode (dploy down)", value: "down" },
                        { name: "Disable maintenance mode (dploy up)", value: "up" },
                        { name: "<- Back", value: "back" },
                    ],
                },
            ]);
            if (action === "back") continue;

            if (action === "ssh") {
                showCommandHint("SSH Shell", buildCliCommandHint("ssh", { env: activeEnv }));
            } else if (action === "logs") {
                const ans = await inquirer.prompt([
                    {
                        type: "list",
                        name: "mode",
                        message: "How would you like to view logs?",
                        choices: [
                            { name: "Show last 5 complete app log entries (--entries 5)", value: "entries" },
                            { name: "Show last 50 lines right here (app logs)", value: "snapshot" },
                            { name: "Show last 5 Nginx error & access entries", value: "nginx-entries" },
                            { name: "Live stream app logs (-f) -> show CLI command", value: "app-follow" },
                            { name: "Live stream Nginx logs (-f) -> show CLI command", value: "nginx-follow" },
                        ],
                    },
                ]);
                if (ans.mode === "entries") {
                    await runSafe(async () => {
                        const { logs } = await import("./logs.js");
                        await logs({ env: activeEnv, entries: 5, latest: true, asAdmin });
                    });
                } else if (ans.mode === "snapshot") {
                    await runSafe(async () => {
                        const { logs } = await import("./logs.js");
                        await logs({ env: activeEnv, lines: 50, latest: true, asAdmin });
                    });
                } else if (ans.mode === "nginx-entries") {
                    await runSafe(async () => {
                        const { logs } = await import("./logs.js");
                        await logs({ env: activeEnv, type: "nginx", entries: 5, asAdmin });
                    });
                } else if (ans.mode === "app-follow") {
                    showCommandHint("Live App Logs", buildCliCommandHint("logs", { env: activeEnv, asAdmin, extraFlags: ["-f"] }));
                } else {
                    showCommandHint(
                        "Live Nginx Logs",
                        buildCliCommandHint("logs", { env: activeEnv, asAdmin, extraFlags: ["--type", "nginx", "-f"] })
                    );
                }
            } else if (action === "run") {
                const { cmdStr } = await inquirer.prompt([
                    { type: "input", name: "cmdStr", message: "Remote command to execute inside current/:" },
                ]);
                if (cmdStr?.trim()) {
                    await runSafe(async () => {
                        const { run } = await import("./run.js");
                        await run(cmdStr.trim(), { env: activeEnv, asAdmin });
                    });
                }
            } else if (action === "health") {
                await runSafe(async () => {
                    const { health } = await import("./health.js");
                    await health({ env: activeEnv });
                });
            } else if (action === "down") {
                const { message } = await inquirer.prompt([
                    { type: "input", name: "message", message: "Maintenance message (optional):" },
                ]);
                await runSafe(async () => {
                    const { down } = await import("./maintenance.js");
                    await down({ env: activeEnv, message: message?.trim() || undefined });
                });
            } else if (action === "up") {
                await runSafe(async () => {
                    const { up } = await import("./maintenance.js");
                    await up({ env: activeEnv });
                });
            }
        } else if (category === "settings") {
            const { setting } = await inquirer.prompt([
                {
                    type: "list",
                    name: "setting",
                    message: "TUI Settings:",
                    choices: [
                        { name: `Switch environment (current: ${activeEnv})`, value: "env" },
                        { name: `Toggle Dry-Run mode (currently: ${dryRun ? "ON" : "OFF"})`, value: "dryRun" },
                        { name: `Toggle Verbose logging (currently: ${verbose ? "ON" : "OFF"})`, value: "verbose" },
                        { name: `Toggle Admin SSH -A (currently: ${asAdmin ? "ON" : "OFF"})`, value: "asAdmin" },
                        { name: "<- Back", value: "back" },
                    ],
                },
            ]);
            if (setting === "env") {
                const { nextEnv } = await inquirer.prompt([
                    {
                        type: "list",
                        name: "nextEnv",
                        message: "Select target environment:",
                        choices: ctx.environments,
                        default: activeEnv,
                    },
                ]);
                activeEnv = nextEnv;
            } else if (setting === "dryRun") {
                dryRun = !dryRun;
            } else if (setting === "verbose") {
                verbose = !verbose;
            } else if (setting === "asAdmin") {
                asAdmin = !asAdmin;
            }
        }
    }
}
