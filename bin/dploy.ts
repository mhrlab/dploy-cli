#!/usr/bin/env node
import { Command, Option } from "commander";
import { setLogLevel } from "../src/core/logger.js";
import { getAppVersion } from "../src/core/utils.js";
import { setCachedPassphrase } from "../src/core/ssh.js";
import { printFullBanner, printCompactBanner } from "../src/core/banner.js";

const lazyAction = (
    loader: () => Promise<Record<string, any>>,
    exportName: string
) => async (_opts: any, cmd: Command) => {
    const mod = await loader();
    await mod[exportName](cmd.optsWithGlobals());
};

const withDryRun = (cmd: Command, description = "Preview planned actions without making changes") =>
    cmd.option("-n, --dry-run", description);

const withJson = (cmd: Command) =>
    cmd.option("--json", "Output machine-readable JSON status");

const withAdminAuth = (cmd: Command, target = "remote execution") =>
    cmd
        .option("-A, --as-admin", `Connect using admin credentials defined in deploy.config.yml for ${target}`)
        .addOption(new Option("--as-sudo", "Alias for --as-admin").hideHelp())
        .option("--admin-user <user>", `Admin / sudo username for ${target} (e.g. root)`)
        .option("--admin-key <path>", "Path to admin SSH private key")
        .option("--admin-password <pass>", "Admin user password or sudo password");



// 🧩 Helper to detect user abort / cancellation errors
function isUserAbortError(err: any): boolean {
    if (!err) return false;
    const name = err.name || "";
    const msg = err.message || String(err);
    return (
        name === "ExitPromptError" ||
        name === "AbortError" ||
        /SIGINT/i.test(msg) ||
        /user force closed/i.test(msg) ||
        /prompt was cancelled/i.test(msg) ||
        /operation was aborted/i.test(msg) ||
        /canceled/i.test(msg) ||
        /cancelled/i.test(msg)
    );
}

// 🧩 Global SIGINT handler (Ctrl + C)
process.on("SIGINT", () => {
    console.log("\n⚠️  Operation cancelled by user.\n");
    process.exit(0);
});

// 🧩 Global SIGTERM handler
process.on("SIGTERM", () => {
    console.log("\n⚠️  Operation terminated.\n");
    process.exit(0);
});

// 🧩 Global unhandled rejection handler (for Inquirer ExitPromptError, etc.)
process.on("unhandledRejection", (err: any) => {
    if (isUserAbortError(err)) {
        console.log("\n⚠️  Operation cancelled by user.\n");
        process.exit(0);
    }

    console.error("❌ Unhandled error:", err?.message || err);
    process.exit(1);
});


async function main() {
    const program = new Command();

    // Global options
    program
        .option("-e, --env <env>", "Target environment (default: production)")
        .option("-v, --verbose", "Enable verbose logging")
        .option("-d, --debug", "Enable debug logging")
        .option("-q, --quiet", "Suppress non-essential banner output")
        .option("-y, --yes", "Automatic yes to prompts; non-interactive mode")
        .option("--passphrase <passphrase>", "Passphrase for encrypted SSH private key");

    program
        .name("dploy")
        .description("Universal deployment tool (MVP version)")
        .version(getAppVersion(), "-a, --app-version")
        .configureHelp({ showGlobalOptions: true })
        .addHelpText("beforeAll", () => {
            if (!process.argv.includes("--json") && !process.argv.includes("-q") && !process.argv.includes("--quiet")) {
                printFullBanner();
            }
            return "";
        });

    // Hook to set log levels, credentials, and render banners before executing any command
    program.hook("preAction", (_thisCommand, actionCommand) => {
        const opts = actionCommand.optsWithGlobals();
        setLogLevel(!!opts.debug, !!opts.verbose || !!opts.dryRun);
        if (opts.passphrase) {
            setCachedPassphrase(opts.passphrase);
        }

        if (opts.json || opts.quiet) {
            return;
        }

        const cmdName = actionCommand.name();
        if (cmdName === "init" || cmdName === "setup") {
            printFullBanner();
        } else {
            printCompactBanner(cmdName);
        }
    });

    // Commands
    program
        .command("init [template]")
        .description("Initialize a new deploy.config.yml from templates")
        .action(async (template?: string) => {
            const { init } = await import("../src/commands/init.js");
            await init({ template });
        });

    withDryRun(
        program
            .command("build")
            .description("Build and package the project (copy strategy)")
            .option("-V, --version <ver>", "Override version string"),
        "Show planned build actions without writing files"
    ).action(lazyAction(() => import("../src/commands/build.js"), "build"));

    withDryRun(
        program
            .command("deploy")
            .description("Deploy to remote server")
            .option("-A, --artifact <path>", "Path to a custom archive to upload (skips build)")
            .addOption(new Option("--archive <path>", "Alias for --artifact").hideHelp())
            .option("-s, --skip-build", "Skip local build and use an existing artifact")
            .option("--version-override <ver>", "Override version string")
            .addOption(new Option("-V, --version <ver>", "Override version string (alias)").hideHelp())
            .option("--keep-artifact", "Preserve local build artifact archive after deployment")
            .option("--no-auto-rollback", "Disable automatic rollback if health check fails")
            .option("--no-health-gate", "Do not abort deployment if health check fails")
            .option("--maintenance", "Put site into maintenance mode during deployment")
            .option("--backup-db", "Take automated pre-deployment database backup before release cutover"),
        "Show planned deploy actions without changing anything"
    ).action(lazyAction(() => import("../src/commands/deploy.js"), "deploy"));

    withDryRun(
        program
            .command("rollback")
            .description("Rollback to previous release")
            .option("--latest", "Rollback to the previous release without prompting")
            .option("--to <version>", "Rollback to a specific release by name")
            .option("--non-interactive", "Run in non-interactive mode without terminal prompts"),
        "Show what would be changed without switching the symlink"
    ).action(lazyAction(() => import("../src/commands/rollback.js"), "rollback"));

    withJson(
        program
            .command("list")
            .description("List releases on remote")
    ).action(lazyAction(() => import("../src/commands/list.js"), "list"));

    withDryRun(
        program
            .command("clean")
            .description("Remove old releases beyond keepVersions"),
        "Show which releases would be removed without deleting them"
    ).action(lazyAction(() => import("../src/commands/clean.js"), "clean"));

    withJson(
        program
            .command("status")
            .description("Show current release and remote deployment status")
    ).action(lazyAction(() => import("../src/commands/status.js"), "status"));

    program
        .command("health")
        .description("Call the health endpoint")
        .action(lazyAction(() => import("../src/commands/health.js"), "health"));

    withJson(
        withDryRun(
            program
                .command("provision")
                .alias("setup-server")
                .description("Prepare a fresh remote server for deployments")
                .option("--force", "Re-run all steps even if directories/files exist")
                .option("--skip-checks", "Skip prerequisite verification (tar, curl, runtime)")
                .option("--only <step>", "Run a specific provisioning step (prereqs, dirs, shared, permissions, service)"),
            "Preview planned server changes without executing"
        )
    ).action(lazyAction(() => import("../src/commands/provision.js"), "provision"));

    withDryRun(
        program
            .command("setup")
            .description("Interactive server setup wizard: configure Nginx, background services, and SSL")
            .option("--webserver <type>", "Web server type (nginx, none)")
            .option("--kind <type>", "App type (node, php, spa)")
            .option("--domain <domain>", "Domain name(s)")
            .option("--port <port>", "Upstream port for Node.js reverse proxy")
            .option("--php-socket <path>", "PHP-FPM socket path")
            .option("--ssl <mode>", "SSL/TLS mode (certbot, cloudflare-flexible, cloudflare-origin, none)")
            .option("--cloudflare", "Enable Cloudflare optimizations (Real-IP restoration and Flexible SSL headers)")
            .option("--cf-cert <pathOrContent>", "Cloudflare Origin CA certificate (.pem path or content)")
            .option("--cf-key <pathOrContent>", "Cloudflare Origin CA private key (.key path or content)")
            .option("--certbot", "Obtain Let's Encrypt SSL via Certbot")
            .option("--service", "Create and enable a systemd background service")
            .option("--exec-start <cmd>", "ExecStart command for systemd unit")
            .option("--queue-worker", "Create and enable a background queue worker (e.g. for Laravel/PHP)")
            .option("--worker-command <cmd>", "Command for the queue worker service")
            .option("--admin-user <user>", "Admin / sudo username for server provisioning (e.g. root)")
            .option("--admin-key <path>", "Path to admin SSH private key")
            .option("--admin-password <pass>", "Admin user password or sudo password")
            .option("--create-deployer", "Provision dedicated unprivileged deploy user and grant limited sudo"),
        "Preview planned Nginx and systemd configs without touching the server"
    ).action(lazyAction(() => import("../src/commands/setup.js"), "setup"));

    program
        .command("ssh")
        .description("Open an interactive SSH terminal on the remote server")
        .action(lazyAction(() => import("../src/commands/ssh.js"), "ssh"));

    withAdminAuth(
        program
            .command("run <command>")
            .description("Execute an ad-hoc command on the remote server inside current release")
            .option("--release <name>", "Execute inside a specific release directory instead of current"),
        "command execution"
    ).action(async (command: string, _opts: any, cmd: Command) => {
        const { run } = await import("../src/commands/run.js");
        await run(command, cmd.optsWithGlobals());
    });

    // 🔐 Environment Variable Management Group
    const envCmd = program
        .command("env")
        .description("Manage remote shared environment variables (.env push, pull, set)");

    envCmd
        .command("push")
        .description("Upload local .env to remote shared/.env with automatic backup")
        .option("-f, --file <path>", "Specific local .env file to upload")
        .option("--force", "Overwrite remote .env without interactive prompt")
        .action(lazyAction(() => import("../src/commands/env.js"), "envPush"));

    envCmd
        .command("pull")
        .description("Download remote shared/.env to local file")
        .option("-o, --out <path>", "Destination local path (default: .env.<env>.remote)")
        .option("--force", "Overwrite local file if it already exists")
        .action(lazyAction(() => import("../src/commands/env.js"), "envPull"));

    envCmd
        .command("set <pair>")
        .description("Set or update a KEY=VALUE variable in remote shared/.env")
        .action(async (pair: string, _opts: any, cmd: Command) => {
            const { envSet } = await import("../src/commands/env.js");
            await envSet(pair, cmd.optsWithGlobals());
        });

    envCmd
        .command("edit")
        .description("Interactively edit remote shared/.env in your local text editor")
        .option("--editor <cmd>", "Custom editor command (default: $VISUAL, $EDITOR, or notepad/nano)")
        .option("--force", "Upload changes without interactive confirmation prompt")
        .action(lazyAction(() => import("../src/commands/env.js"), "envEdit"));

    // Backward-compatible colon aliases: env:push, env:pull, env:set, env:edit
    program
        .command("env:push")
        .description("Upload local .env to remote shared/.env (alias for 'env push')")
        .option("-f, --file <path>", "Specific local .env file to upload")
        .option("--force", "Overwrite remote .env without interactive prompt")
        .action(lazyAction(() => import("../src/commands/env.js"), "envPush"));

    program
        .command("env:pull")
        .description("Download remote shared/.env to local file (alias for 'env pull')")
        .option("-o, --out <path>", "Destination local path (default: .env.<env>.remote)")
        .option("--force", "Overwrite local file if it already exists")
        .action(lazyAction(() => import("../src/commands/env.js"), "envPull"));

    program
        .command("env:set <pair>")
        .description("Set or update a KEY=VALUE variable in remote shared/.env (alias for 'env set')")
        .action(async (pair: string, _opts: any, cmd: Command) => {
            const { envSet } = await import("../src/commands/env.js");
            await envSet(pair, cmd.optsWithGlobals());
        });

    program
        .command("env:edit")
        .description("Interactively edit remote shared/.env in your local text editor (alias for 'env edit')")
        .option("--editor <cmd>", "Custom editor command (default: $VISUAL, $EDITOR, or notepad/nano)")
        .option("--force", "Upload changes without interactive confirmation prompt")
        .action(lazyAction(() => import("../src/commands/env.js"), "envEdit"));

    withAdminAuth(
        program
            .command("logs")
            .description("Stream or tail remote application/server logs")
            .option("-f, --follow", "Follow log output (stream real-time)")
            .option("-n, --lines <count>", "Number of lines to show (default: 50)")
            .option("--type <type>", "Log type: app, nginx, pm2, or systemd")
            .option("--file <path>", "Specific remote log file to tail")
            .option("--latest", "Automatically pick the newest daily log file without prompting")
            .option("--sudo", "Execute log reading command with sudo privileges"),
        "remote privileged log streaming"
    ).action(lazyAction(() => import("../src/commands/logs.js"), "logs"));

    program
        .command("down")
        .description("Put the remote site into maintenance mode")
        .option("-m, --message <msg>", "Custom maintenance message")
        .option("--retry <seconds>", "Suggested Retry-After header value in seconds (default: 300)")
        .action(lazyAction(() => import("../src/commands/maintenance.js"), "down"));

    program
        .command("up")
        .description("Take the remote site out of maintenance mode (restore traffic)")
        .action(lazyAction(() => import("../src/commands/maintenance.js"), "up"));

    // 🌐 Site Management Commands
    const siteCmd = program
        .command("site")
        .description("Manage remote site configurations, backups, and teardown");

    withAdminAuth(
        withDryRun(
            siteCmd
                .command("add")
                .description("Add a new site/domain to an existing server (skips deploy user and sudoers creation)")
                .option("--webserver <type>", "Web server type (nginx, none)")
                .option("--kind <type>", "App type (node, php, spa)")
                .option("-D, --domain <domain>", "Domain name(s)")
                .option("--port <port>", "Upstream port for Node.js reverse proxy")
                .option("--php-socket <path>", "PHP-FPM socket path")
                .option("--ssl <mode>", "SSL/TLS mode (certbot, cloudflare-flexible, cloudflare-origin, none)")
                .option("--cloudflare", "Enable Cloudflare optimizations (Real-IP restoration and Flexible SSL headers)")
                .option("--cf-cert <pathOrContent>", "Cloudflare Origin CA certificate (.pem path or content)")
                .option("--cf-key <pathOrContent>", "Cloudflare Origin CA private key (.key path or content)")
                .option("--certbot", "Obtain Let's Encrypt SSL via Certbot")
                .option("--service", "Create and enable a systemd background service")
                .option("--exec-start <cmd>", "ExecStart command for systemd unit")
                .option("--queue-worker", "Create and enable a background queue worker (e.g. for Laravel/PHP)")
                .option("--worker-command <cmd>", "Command for the queue worker service"),
            "Preview planned Nginx and systemd configs without touching the server"
        ),
        "server provisioning"
    ).action(lazyAction(() => import("../src/commands/site.js"), "siteAdd"));

    withAdminAuth(
        siteCmd
            .command("backup")
            .description("Snapshot and download remote site configurations (Nginx, systemd, sudoers, .env)")
            .option("-D, --domain <domain>", "Domain name(s) to backup")
            .option("-o, --output <dir>", "Local directory to store the backup archive (default: ./backups)"),
        "remote inspection"
    ).action(lazyAction(() => import("../src/commands/site.js"), "siteBackup"));

    withAdminAuth(
        withDryRun(
            siteCmd
                .command("remove")
                .description("Safely decommission and remove remote site configurations and services")
                .option("-D, --domain <domain>", "Domain name(s) to remove")
                .option("-f, --force", "Bypass interactive confirmation prompt")
                .option("--no-backup", "Skip automatic pre-removal configuration backup")
                .option("--purge-ssl", "Also delete Certbot SSL certificates for the domain(s)")
                .option("--purge-files", "Also delete application deployment directory (/var/www/<appName>)"),
            "Preview planned teardown without making any changes"
        ),
        "remote teardown"
    ).action(lazyAction(() => import("../src/commands/site.js"), "siteRemove"));

    withAdminAuth(
        siteCmd
            .command("info")
            .description("Inspect remote site status: Nginx virtual host, systemd services, SSL certificates, and releases")
            .option("-D, --domain <domain>", "Domain name to inspect"),
        "remote inspection"
    ).action(lazyAction(() => import("../src/commands/site.js"), "siteInfo"));

    withAdminAuth(
        withDryRun(
            siteCmd
                .command("ssl")
                .description("Switch or update SSL mode (Certbot, Cloudflare Flexible, Cloudflare Origin, or None)")
                .option("-D, --domain <domain>", "Domain name to configure")
                .option("--ssl <mode>", "SSL mode: certbot, cloudflare-flexible, cloudflare-origin, none")
                .option("--cloudflare", "Shortcut for Cloudflare Flexible SSL with Real-IP headers")
                .option("--certbot", "Shortcut for Certbot Let's Encrypt automated SSL"),
            "Preview updated Nginx configuration without applying"
        ),
        "remote configuration"
    ).action(lazyAction(() => import("../src/commands/site.js"), "siteSsl"));

    // Convenient top-level alias `dploy remove`
    withAdminAuth(
        withDryRun(
            program
                .command("remove")
                .description("Safely decommission and remove remote site configurations (alias for 'site remove')")
                .option("-D, --domain <domain>", "Domain name(s) to remove")
                .option("-f, --force", "Bypass interactive confirmation prompt")
                .option("--no-backup", "Skip automatic pre-removal configuration backup")
                .option("--purge-ssl", "Also delete Certbot SSL certificates for the domain(s)")
                .option("--purge-files", "Also delete application deployment directory (/var/www/<appName>)"),
            "Preview planned teardown without making any changes"
        ),
        "remote teardown"
    ).action(lazyAction(() => import("../src/commands/site.js"), "siteRemove"));

    // 🗄️ Database Management Group
    const dbCmd = program
        .command("db")
        .alias("database")
        .description("Manage remote databases (MySQL, PostgreSQL, SQLite)");

    withAdminAuth(
        withDryRun(
            dbCmd
                .command("create [name]")
                .description("Create a remote database, user, and grant full privileges")
                .option("--type <type>", "Database type (mysql, postgres, sqlite)")
                .option("-u, --user <user>", "Database user to create/grant")
                .option("-p, --password <password>", "Database user password")
                .option("--host <host>", "Database host (default: 127.0.0.1)")
                .option("--port <port>", "Database port")
                .option("--db-root-user <user>", "Database root/admin user (default: root)")
                .option("--db-root-password <pass>", "Database root/admin password")
                .option("--charset <charset>", "Database character set (default: utf8mb4)")
                .option("--collation <collation>", "Database collation (default: utf8mb4_unicode_ci)"),
            "Preview database creation queries without executing"
        ),
        "SSH connection"
    ).action(async (name: string | undefined, _opts: any, cmd: Command) => {
        const { dbCreate } = await import("../src/commands/database.js");
        const merged = { ...cmd.optsWithGlobals(), name: name || cmd.optsWithGlobals().name };
        await dbCreate(merged);
    });

    withAdminAuth(
        withDryRun(
            dbCmd
                .command("drop [name]")
                .description("Permanently drop a remote database and optionally its user")
                .option("--type <type>", "Database type (mysql, postgres, sqlite)")
                .option("--drop-user", "Also drop the associated database user")
                .option("-f, --force", "Bypass interactive confirmation prompt"),
            "Preview drop query without executing"
        ),
        "SSH connection"
    ).action(async (name: string | undefined, _opts: any, cmd: Command) => {
        const { dbDrop } = await import("../src/commands/database.js");
        const merged = { ...cmd.optsWithGlobals(), name: name || cmd.optsWithGlobals().name };
        await dbDrop(merged);
    });

    withAdminAuth(
        dbCmd
            .command("backup")
            .description("Trigger a manual database dump and optionally download locally")
            .option("--type <type>", "Database type (mysql, postgres, sqlite)")
            .option("--name <name>", "Database name to backup")
            .option("-o, --output <path>", "Local destination path for downloaded backup")
            .option("--download [path]", "Download backup to local machine after creation"),
        "SSH connection"
    ).action(lazyAction(() => import("../src/commands/database.js"), "dbBackup"));

    withAdminAuth(
        dbCmd
            .command("restore <file>")
            .description("Restore a remote database from a local or remote SQL dump file")
            .option("--type <type>", "Database type (mysql, postgres, sqlite)")
            .option("--name <name>", "Database name to restore into")
            .option("-f, --force", "Bypass interactive confirmation prompt"),
        "SSH connection"
    ).action(async (file: string, _opts: any, cmd: Command) => {
        const { dbRestore } = await import("../src/commands/database.js");
        await dbRestore(file, cmd.optsWithGlobals());
    });

    withAdminAuth(
        dbCmd
            .command("optimize")
            .description("Optimize database tables and defragment storage")
            .option("--type <type>", "Database type (mysql, postgres, sqlite)")
            .option("--name <name>", "Database name to optimize"),
        "SSH connection"
    ).action(lazyAction(() => import("../src/commands/database.js"), "dbOptimize"));

    withAdminAuth(
        dbCmd
            .command("console")
            .alias("cli")
            .description("Open an interactive database terminal (mysql/psql/sqlite3) on the remote server")
            .option("--type <type>", "Database type (mysql, postgres, sqlite)")
            .option("--name <name>", "Database name to connect to"),
        "SSH connection"
    ).action(lazyAction(() => import("../src/commands/database.js"), "dbConsole"));

    // Backward-compatible colon aliases: db:create, db:drop, db:backup, db:restore, db:optimize, db:console
    withAdminAuth(
        withDryRun(
            program
                .command("db:create [name]")
                .description("Create a remote database, user, and grant privileges (alias for 'db create')")
                .option("--type <type>", "Database type (mysql, postgres, sqlite)")
                .option("-u, --user <user>", "Database user to create/grant")
                .option("-p, --password <password>", "Database user password")
                .option("--host <host>", "Database host (default: 127.0.0.1)")
                .option("--port <port>", "Database port")
                .option("--db-root-user <user>", "Database root/admin user (default: root)")
                .option("--db-root-password <pass>", "Database root/admin password")
                .option("--charset <charset>", "Database character set (default: utf8mb4)")
                .option("--collation <collation>", "Database collation (default: utf8mb4_unicode_ci)"),
            "Preview database creation queries without executing"
        ),
        "SSH connection"
    ).action(async (name: string | undefined, _opts: any, cmd: Command) => {
        const { dbCreate } = await import("../src/commands/database.js");
        const merged = { ...cmd.optsWithGlobals(), name: name || cmd.optsWithGlobals().name };
        await dbCreate(merged);
    });

    withAdminAuth(
        withDryRun(
            program
                .command("db:drop [name]")
                .description("Permanently drop a remote database (alias for 'db drop')")
                .option("--type <type>", "Database type (mysql, postgres, sqlite)")
                .option("--drop-user", "Also drop the associated database user")
                .option("-f, --force", "Bypass interactive confirmation prompt"),
            "Preview drop query without executing"
        ),
        "SSH connection"
    ).action(async (name: string | undefined, _opts: any, cmd: Command) => {
        const { dbDrop } = await import("../src/commands/database.js");
        const merged = { ...cmd.optsWithGlobals(), name: name || cmd.optsWithGlobals().name };
        await dbDrop(merged);
    });

    withAdminAuth(
        program
            .command("db:backup")
            .description("Trigger a manual database dump (alias for 'db backup')")
            .option("--type <type>", "Database type (mysql, postgres, sqlite)")
            .option("--name <name>", "Database name to backup")
            .option("-o, --output <path>", "Local destination path for downloaded backup")
            .option("--download [path]", "Download backup to local machine after creation"),
        "SSH connection"
    ).action(lazyAction(() => import("../src/commands/database.js"), "dbBackup"));

    withAdminAuth(
        program
            .command("db:restore <file>")
            .description("Restore a remote database from a dump file (alias for 'db restore')")
            .option("--type <type>", "Database type (mysql, postgres, sqlite)")
            .option("--name <name>", "Database name to restore into")
            .option("-f, --force", "Bypass interactive confirmation prompt"),
        "SSH connection"
    ).action(async (file: string, _opts: any, cmd: Command) => {
        const { dbRestore } = await import("../src/commands/database.js");
        await dbRestore(file, cmd.optsWithGlobals());
    });

    withAdminAuth(
        program
            .command("db:optimize")
            .description("Optimize database tables and defragment storage (alias for 'db optimize')")
            .option("--type <type>", "Database type (mysql, postgres, sqlite)")
            .option("--name <name>", "Database name to optimize"),
        "SSH connection"
    ).action(lazyAction(() => import("../src/commands/database.js"), "dbOptimize"));

    withAdminAuth(
        program
            .command("db:console")
            .alias("db:cli")
            .description("Open an interactive database terminal on remote server (alias for 'db console')")
            .option("--type <type>", "Database type (mysql, postgres, sqlite)")
            .option("--name <name>", "Database name to connect to"),
        "SSH connection"
    ).action(lazyAction(() => import("../src/commands/database.js"), "dbConsole"));

    await program.parseAsync(process.argv);
}

// ✅ Run main entry
main().catch((err) => {
    if (isUserAbortError(err)) {
        console.log("\n⚠️  Operation cancelled by user.\n");
        process.exit(0);
    }

    console.error("❌ CLI Error:", err?.message || err);
    process.exit(1);
});
