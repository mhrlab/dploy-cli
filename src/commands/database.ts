import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import fs from "fs-extra";
import inquirer from "inquirer";
import { loadConfig, getEnvName, EnvironmentConfig } from "../core/config.js";
import { connect, close, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { expandTilde, escapeShellArg, posixJoin } from "../core/utils.js";
import { parseEnvContent } from "../features/env-sync.js";
import {
    DatabaseType,
    DatabaseBackupConfig,
    executeDatabaseBackup,
} from "../features/database-backup.js";

export interface DatabaseCommandOptions {
    env?: string;
    type?: DatabaseType;
    name?: string;
    user?: string;
    password?: string;
    host?: string;
    port?: number;
    dbRootUser?: string;
    dbRootPassword?: string;
    charset?: string;
    collation?: string;
    output?: string;
    download?: boolean | string;
    force?: boolean;
    yes?: boolean;
    dryRun?: boolean;
    dropUser?: boolean;
    asAdmin?: boolean;
    asSudo?: boolean;
    adminUser?: string;
    adminKey?: string;
    adminPassword?: string;
    sudo?: boolean;
    file?: string;
}

export interface ResolvedDatabaseContext {
    connConfig: EnvironmentConfig;
    sudoPrefix: string;
    isExplicitAdmin: boolean;
    dbType: DatabaseType;
    host: string;
    port?: number;
    dbName?: string;
    dbUser?: string;
    dbPassword?: string;
    rootUser: string;
    rootPassword?: string;
    charset: string;
    collation: string;
    sqlitePath?: string;
    deployTo?: string;
}

export function buildMysqlCliAuthArgs(ctx: {
    host: string;
    port?: number;
    user?: string;
    password?: string;
    sudoPrefix?: string;
    isExplicitAdmin?: boolean;
}): { envPrefix: string; cliArgs: string; sudoPrefix: string } {
    const isLocal = ctx.host === "127.0.0.1" || ctx.host === "localhost";
    const targetUser = ctx.user || "root";

    if (ctx.isExplicitAdmin && !ctx.password && isLocal) {
        // Modern Linux auth_socket enables passwordless sudo mysql
        return { envPrefix: "", cliArgs: `-u ${escapeShellArg(targetUser)}`, sudoPrefix: ctx.sudoPrefix || "" };
    }

    const parts: string[] = [];
    if (ctx.host) parts.push(`-h ${escapeShellArg(ctx.host)}`);
    if (ctx.port && ctx.port !== 3306) parts.push(`-P ${ctx.port}`);
    parts.push(`-u ${escapeShellArg(targetUser)}`);
    if (ctx.password) parts.push(`-p${escapeShellArg(ctx.password)}`);

    // When DB password is provided, client connects directly using DB user credentials
    return { envPrefix: "", cliArgs: parts.join(" "), sudoPrefix: "" };
}

export function buildMysqlCreateQuery(
    dbName: string,
    dbUser?: string,
    dbPassword?: string,
    charset: string = "utf8mb4",
    collation: string = "utf8mb4_unicode_ci"
): string {
    const lines = [
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET ${charset} COLLATE ${collation};`,
    ];

    if (dbUser) {
        const passClause = dbPassword ? ` IDENTIFIED BY '${dbPassword.replace(/'/g, "''")}'` : "";
        lines.push(
            `CREATE USER IF NOT EXISTS '${dbUser}'@'localhost'${passClause};`,
            dbPassword ? `ALTER USER '${dbUser}'@'localhost'${passClause};` : "",
            `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'localhost';`,
            `CREATE USER IF NOT EXISTS '${dbUser}'@'%'${passClause};`,
            dbPassword ? `ALTER USER '${dbUser}'@'%'${passClause};` : "",
            `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'%';`,
            `FLUSH PRIVILEGES;`
        );
    }

    return lines.filter(Boolean).join(" ");
}

export function buildMysqlDropQuery(dbName: string, dbUser?: string, dropUser?: boolean): string {
    const lines = [`DROP DATABASE IF EXISTS \`${dbName}\`;`];
    if (dropUser && dbUser) {
        lines.push(
            `DROP USER IF EXISTS '${dbUser}'@'localhost';`,
            `DROP USER IF EXISTS '${dbUser}'@'%';`,
            `FLUSH PRIVILEGES;`
        );
    }
    return lines.join(" ");
}

export function buildPostgresCreateQuery(dbName: string, dbUser?: string, dbPassword?: string): string {
    const lines: string[] = [];
    if (dbUser) {
        const passClause = dbPassword ? ` WITH LOGIN PASSWORD '${dbPassword.replace(/'/g, "''")}'` : " WITH LOGIN";
        lines.push(
            `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${dbUser}') THEN CREATE ROLE "${dbUser}"${passClause}; ELSE ALTER ROLE "${dbUser}"${passClause}; END IF; END $$;`
        );
    }
    // PostgreSQL database creation
    const ownerClause = dbUser ? ` OWNER "${dbUser}"` : "";
    lines.push(
        `SELECT 'CREATE DATABASE "${dbName}"${ownerClause}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${dbName}')\\gexec`
    );
    if (dbUser) {
        lines.push(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${dbUser}";`);
    }
    return lines.join(" ");
}

export function buildPostgresDropQuery(dbName: string, dbUser?: string, dropUser?: boolean): string {
    const lines = [`DROP DATABASE IF EXISTS "${dbName}";`];
    if (dropUser && dbUser) {
        lines.push(`DROP ROLE IF EXISTS "${dbUser}";`);
    }
    return lines.join(" ");
}

export async function resolveDatabaseContext(
    opts: DatabaseCommandOptions,
    clientForEnvCheck?: any
): Promise<ResolvedDatabaseContext> {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];

    if (!env) {
        throw new Error(`Environment '${envName}' not found in deploy.config.yml`);
    }

    const isExplicitAdmin = Boolean(opts.asAdmin || opts.asSudo || opts.adminUser || opts.adminKey || opts.adminPassword);
    const adminUser = opts.adminUser || process.env.DPLOY_ADMIN_USER || (isExplicitAdmin || opts.sudo ? env.admin?.username : undefined);

    if (isExplicitAdmin && !adminUser) {
        throw new Error(`Admin credentials not found in 'admin' block of deploy.config.yml for environment '${envName}'. Please configure 'admin:' or pass --admin-user.`);
    }

    const adminKey = opts.adminKey || process.env.DPLOY_ADMIN_KEY || env.admin?.ssh_key_path;
    const adminPassword = opts.adminPassword || process.env.DPLOY_ADMIN_PASSWORD || env.admin?.password;

    let connConfig: EnvironmentConfig = env;
    let sudoPrefix = "";

    if (adminUser) {
        connConfig = {
            ...env,
            username: adminUser,
            ssh_key_path: adminKey ? expandTilde(adminKey) : (adminUser === env.username ? env.ssh_key_path : (env.admin?.ssh_key_path ? expandTilde(env.admin.ssh_key_path) : env.ssh_key_path)),
            password: adminPassword || (adminUser === env.username ? env.password : env.admin?.password),
            passphrase: env.admin?.passphrase || env.passphrase,
        };
        sudoPrefix = adminUser === "root" ? "" : "sudo -n ";
    } else if (opts.sudo) {
        sudoPrefix = "sudo -n ";
    }

    const dbConfig: DatabaseBackupConfig = {
        ...(cfg.database || {}),
        ...(env.database || {}),
    };
    let dbType: DatabaseType = opts.type || dbConfig.type || (process.env.DB_CONNECTION as any) || "mysql";
    let host = opts.host || dbConfig.host || process.env.DB_HOST || "127.0.0.1";
    let port = opts.port || dbConfig.port || (process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined);
    let dbName = opts.name || dbConfig.name || process.env.DB_DATABASE;
    let dbUser = opts.user || dbConfig.user || process.env.DB_USERNAME;
    let dbPassword = opts.password || dbConfig.password || process.env.DB_PASSWORD;
    if (dbPassword === "null" || dbPassword === "undefined") dbPassword = undefined;
    const charset = opts.charset || dbConfig.charset || "utf8mb4";
    const collation = opts.collation || dbConfig.collation || "utf8mb4_unicode_ci";
    let sqlitePath = opts.file || dbConfig.path || (dbType === "sqlite" ? dbName : undefined);

    // Auto-detect from remote shared/.env if values are missing and SSH client is available
    if (clientForEnvCheck && env.deployTo && (!dbName || !dbUser || !dbPassword)) {
        try {
            const remoteEnvPath = posixJoin(env.deployTo.trim(), "shared", ".env");
            const res = await exec(clientForEnvCheck, `cat ${escapeShellArg(remoteEnvPath)} 2>/dev/null || true`);
            if (res.stdout) {
                const parsed = parseEnvContent(res.stdout).entries;
                if (!dbName && parsed.get("DB_DATABASE")) dbName = parsed.get("DB_DATABASE");
                if (!dbUser && parsed.get("DB_USERNAME")) dbUser = parsed.get("DB_USERNAME");
                if (!dbPassword && parsed.get("DB_PASSWORD")) dbPassword = parsed.get("DB_PASSWORD");
                if (dbPassword === "null" || dbPassword === "undefined") dbPassword = undefined;
                if (!opts.host && parsed.get("DB_HOST")) host = parsed.get("DB_HOST")!;
                if (!opts.port && parsed.get("DB_PORT")) port = parseInt(parsed.get("DB_PORT")!, 10);
                if (!opts.type && parsed.get("DB_CONNECTION")) {
                    const conn = parsed.get("DB_CONNECTION")!.toLowerCase();
                    if (conn.includes("pg") || conn.includes("postgres")) dbType = "postgres";
                    else if (conn.includes("sqlite")) dbType = "sqlite";
                    else if (conn.includes("mysql") || conn.includes("mariadb")) dbType = "mysql";
                }
            }
        } catch {}
    }

    const rootUser =
        opts.dbRootUser ||
        dbConfig.admin_user ||
        dbConfig.root_user ||
        process.env.DB_ROOT_USER ||
        (dbType === "postgres" ? "postgres" : "root");

    let rootPassword =
        opts.dbRootPassword ||
        dbConfig.admin_password ||
        dbConfig.root_password ||
        process.env.DB_ROOT_PASSWORD;
    if (rootPassword === "null" || rootPassword === "undefined") rootPassword = undefined;

    return {
        connConfig,
        sudoPrefix,
        isExplicitAdmin,
        dbType,
        host,
        port,
        dbName,
        dbUser,
        dbPassword,
        rootUser,
        rootPassword,
        charset,
        collation,
        sqlitePath,
        deployTo: env.deployTo,
    };
}

/**
 * Creates a database and user with privileges.
 */
export async function dbCreate(opts: DatabaseCommandOptions) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];
    if (!env) throw new Error(`Environment '${envName}' not found`);

    log.info(`Connecting to ${env.username}@${env.host} for database creation...`);
    const bundle = await connect(env);
    let ctx: ResolvedDatabaseContext;
    try {
        ctx = await resolveDatabaseContext(opts, bundle.ssh);
    } finally {
        await close(bundle);
    }

    if (!ctx.dbName) {
        throw new Error("Database name is required. Specify via --name <dbName> or in deploy.config.yml.");
    }

    log.info(`Creating database '${ctx.dbName}' (${ctx.dbType}) on ${ctx.connConfig.username}@${ctx.connConfig.host}...`);

    if (opts.dryRun) {
        log.info(`[dry-run] Planned database creation:`);
        log.info(`[dry-run] Host: ${ctx.host}:${ctx.port || "default"}`);
        log.info(`[dry-run] Database: ${ctx.dbName}`);
        if (ctx.dbUser) log.info(`[dry-run] User: ${ctx.dbUser}`);
        return;
    }

    const execBundle = await connect(ctx.connConfig);
    try {
        if (ctx.dbType === "mysql") {
            const sql = buildMysqlCreateQuery(ctx.dbName, ctx.dbUser, ctx.dbPassword, ctx.charset, ctx.collation);
            const auth = buildMysqlCliAuthArgs({
                host: ctx.host,
                port: ctx.port,
                user: ctx.rootUser,
                password: ctx.rootPassword,
                sudoPrefix: ctx.sudoPrefix,
                isExplicitAdmin: ctx.isExplicitAdmin,
            });

            const remoteCmd = `${auth.sudoPrefix}${auth.envPrefix}mysql ${auth.cliArgs} -e ${escapeShellArg(sql)}`;
            log.verbose(`Executing: ${remoteCmd}`);
            const res = await exec(execBundle.ssh, remoteCmd);
            if (res.code !== 0) {
                throw new Error(`MySQL create failed (exit code ${res.code}): ${res.stderr || res.stdout}`);
            }
        } else if (ctx.dbType === "postgres") {
            const sql = buildPostgresCreateQuery(ctx.dbName, ctx.dbUser, ctx.dbPassword);
            let remoteCmd: string;
            if (ctx.isExplicitAdmin && !ctx.rootPassword) {
                remoteCmd = `${ctx.sudoPrefix}-u postgres psql -c ${escapeShellArg(sql)}`;
            } else {
                const passPrefix = ctx.rootPassword ? `PGPASSWORD=${escapeShellArg(ctx.rootPassword)} ` : "";
                const hostPart = ctx.host ? `-h ${escapeShellArg(ctx.host)} ` : "";
                const portPart = ctx.port ? `-p ${ctx.port} ` : "";
                remoteCmd = `${passPrefix}psql ${hostPart}${portPart}-U ${escapeShellArg(ctx.rootUser)} -c ${escapeShellArg(sql)}`;
            }
            log.verbose(`Executing: ${remoteCmd}`);
            const res = await exec(execBundle.ssh, remoteCmd);
            if (res.code !== 0) {
                throw new Error(`PostgreSQL create failed (exit code ${res.code}): ${res.stderr || res.stdout}`);
            }
        } else if (ctx.dbType === "sqlite") {
            const targetPath = ctx.sqlitePath || (ctx.deployTo ? posixJoin(ctx.deployTo.trim(), "shared", `${ctx.dbName}.sqlite`) : `${ctx.dbName}.sqlite`);
            const parentDir = path.posix.dirname(targetPath);
            await exec(execBundle.ssh, `mkdir -p ${escapeShellArg(parentDir)} && touch ${escapeShellArg(targetPath)}`);
        }

        log.ok(`Database '${ctx.dbName}' created successfully.`);
        if (ctx.dbUser) {
            log.ok(`User '${ctx.dbUser}' granted full privileges on '${ctx.dbName}'.`);
        }
    } finally {
        await close(execBundle);
    }
}

/**
 * Drops a database and optionally its user.
 */
export async function dbDrop(opts: DatabaseCommandOptions) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];
    if (!env) throw new Error(`Environment '${envName}' not found`);

    const bundle = await connect(env);
    let ctx: ResolvedDatabaseContext;
    try {
        ctx = await resolveDatabaseContext(opts, bundle.ssh);
    } finally {
        await close(bundle);
    }

    if (!ctx.dbName) {
        throw new Error("Database name is required. Specify via --name <dbName> or in deploy.config.yml.");
    }

    if (!opts.force && !opts.yes && process.stdin.isTTY) {
        const ans = await inquirer.prompt([
            {
                type: "confirm",
                name: "confirm",
                message: `Are you sure you want to permanently DROP database '${ctx.dbName}' on ${envName}? THIS CANNOT BE UNDONE!`,
                default: false,
            },
        ]);
        if (!ans.confirm) {
            log.warn("Database drop aborted by user.");
            return;
        }
    }

    if (opts.dryRun) {
        log.info(`[dry-run] Would drop database '${ctx.dbName}' on ${ctx.connConfig.host}`);
        if (opts.dropUser && ctx.dbUser) log.info(`[dry-run] Would also drop user '${ctx.dbUser}'`);
        return;
    }

    const execBundle = await connect(ctx.connConfig);
    try {
        if (ctx.dbType === "mysql") {
            const sql = buildMysqlDropQuery(ctx.dbName, ctx.dbUser, opts.dropUser);
            const auth = buildMysqlCliAuthArgs({
                host: ctx.host,
                port: ctx.port,
                user: ctx.rootUser,
                password: ctx.rootPassword,
                sudoPrefix: ctx.sudoPrefix,
                isExplicitAdmin: ctx.isExplicitAdmin,
            });

            const remoteCmd = `${auth.sudoPrefix}${auth.envPrefix}mysql ${auth.cliArgs} -e ${escapeShellArg(sql)}`;
            const res = await exec(execBundle.ssh, remoteCmd);
            if (res.code !== 0) {
                throw new Error(`MySQL drop failed (exit code ${res.code}): ${res.stderr || res.stdout}`);
            }
        } else if (ctx.dbType === "postgres") {
            const sql = buildPostgresDropQuery(ctx.dbName, ctx.dbUser, opts.dropUser);
            let remoteCmd: string;
            if (ctx.isExplicitAdmin && !ctx.rootPassword) {
                remoteCmd = `${ctx.sudoPrefix}-u postgres psql -c ${escapeShellArg(sql)}`;
            } else {
                const passPrefix = ctx.rootPassword ? `PGPASSWORD=${escapeShellArg(ctx.rootPassword)} ` : "";
                const hostPart = ctx.host ? `-h ${escapeShellArg(ctx.host)} ` : "";
                const portPart = ctx.port ? `-p ${ctx.port} ` : "";
                remoteCmd = `${passPrefix}psql ${hostPart}${portPart}-U ${escapeShellArg(ctx.rootUser)} -c ${escapeShellArg(sql)}`;
            }
            const res = await exec(execBundle.ssh, remoteCmd);
            if (res.code !== 0) {
                throw new Error(`PostgreSQL drop failed (exit code ${res.code}): ${res.stderr || res.stdout}`);
            }
        } else if (ctx.dbType === "sqlite") {
            const targetPath = ctx.sqlitePath || (ctx.deployTo ? posixJoin(ctx.deployTo.trim(), "shared", `${ctx.dbName}.sqlite`) : `${ctx.dbName}.sqlite`);
            await exec(execBundle.ssh, `rm -f ${escapeShellArg(targetPath)}`);
        }

        log.ok(`Database '${ctx.dbName}' dropped successfully.`);
    } finally {
        await close(execBundle);
    }
}

/**
 * Triggers a manual database backup and optionally downloads the archive.
 */
export async function dbBackup(opts: DatabaseCommandOptions) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];
    if (!env || !env.deployTo) throw new Error(`Environment '${envName}' lacks deployTo path`);

    const bundle = await connect(env);
    let ctx: ResolvedDatabaseContext;
    try {
        ctx = await resolveDatabaseContext(opts, bundle.ssh);
    } finally {
        await close(bundle);
    }

    if (!ctx.dbName && ctx.dbType !== "sqlite") {
        throw new Error("Database name is required for backup.");
    }

    const dbConfig: DatabaseBackupConfig = {
        enabled: true,
        type: ctx.dbType,
        name: ctx.dbName,
        user: ctx.dbUser || ctx.rootUser,
        password: ctx.dbPassword || ctx.rootPassword,
        host: ctx.host,
        port: ctx.port,
        path: ctx.sqlitePath,
    };

    const execBundle = await connect(ctx.connConfig);
    try {
        const releaseDir = posixJoin(env.deployTo.trim(), "current");
        const backupPath = await executeDatabaseBackup(execBundle.ssh, env.deployTo, "manual", dbConfig, releaseDir);
        log.ok(`Database backup saved on remote server at: ${backupPath}`);

        if (opts.download) {
            const fileName = path.posix.basename(backupPath);
            const defaultDest = typeof opts.download === "string" ? opts.download : (opts.output || path.join(process.cwd(), "backups", fileName));
            const destPath = path.resolve(process.cwd(), defaultDest);
            await fs.ensureDir(path.dirname(destPath));

            log.info(`Downloading remote backup to ${destPath}...`);
            await execBundle.sftp.fastGet(backupPath, destPath);
            log.ok(`Downloaded database backup to: ${destPath}`);
        }
    } finally {
        await close(execBundle);
    }
}

/**
 * Restores a database from a local or remote SQL dump file.
 */
export async function dbRestore(dumpFile: string, opts: DatabaseCommandOptions) {
    if (!dumpFile) {
        throw new Error("Dump file path is required. Usage: dploy db:restore <dumpFile>");
    }

    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];
    if (!env || !env.deployTo) throw new Error(`Environment '${envName}' lacks deployTo path`);

    const bundle = await connect(env);
    let ctx: ResolvedDatabaseContext;
    try {
        ctx = await resolveDatabaseContext(opts, bundle.ssh);
    } finally {
        await close(bundle);
    }

    if (!ctx.dbName && ctx.dbType !== "sqlite") {
        throw new Error("Database name is required for restore.");
    }

    if (!opts.force && !opts.yes && process.stdin.isTTY) {
        const ans = await inquirer.prompt([
            {
                type: "confirm",
                name: "confirm",
                message: `Restore database '${ctx.dbName}' from '${path.basename(dumpFile)}'? Existing tables will be overwritten.`,
                default: false,
            },
        ]);
        if (!ans.confirm) {
            log.warn("Database restore aborted by user.");
            return;
        }
    }

    const execBundle = await connect(ctx.connConfig);
    let remoteFilePath = dumpFile;
    let isTempUpload = false;

    try {
        // If file exists locally, upload to remote temp
        const localPath = path.resolve(process.cwd(), dumpFile);
        if (await fs.pathExists(localPath)) {
            const remoteTempDir = posixJoin(env.deployTo.trim(), "backups");
            await exec(execBundle.ssh, `mkdir -p ${escapeShellArg(remoteTempDir)}`);
            remoteFilePath = posixJoin(remoteTempDir, `restore-${Date.now()}-${path.basename(dumpFile)}`);
            log.info(`Uploading ${path.basename(localPath)} to remote server...`);
            await execBundle.sftp.fastPut(localPath, remoteFilePath);
            isTempUpload = true;
        }

        log.info(`Restoring database '${ctx.dbName}' from ${remoteFilePath}...`);

        const isGz = remoteFilePath.endsWith(".gz");

        if (ctx.dbType === "mysql") {
            const auth = buildMysqlCliAuthArgs({
                host: ctx.host,
                port: ctx.port,
                user: ctx.dbUser || ctx.rootUser,
                password: ctx.dbPassword || ctx.rootPassword,
                sudoPrefix: ctx.sudoPrefix,
                isExplicitAdmin: ctx.isExplicitAdmin,
            });

            const catCmd = isGz ? `gzip -dc ${escapeShellArg(remoteFilePath)}` : `cat ${escapeShellArg(remoteFilePath)}`;
            const mysqlCmd = `${auth.sudoPrefix}${auth.envPrefix}mysql ${auth.cliArgs} ${escapeShellArg(ctx.dbName!)}`;
            const fullCmd = `${catCmd} | ${mysqlCmd}`;

            log.verbose(`Executing: ${fullCmd}`);
            const res = await exec(execBundle.ssh, fullCmd);
            if (res.code !== 0) {
                throw new Error(`MySQL restore failed (exit code ${res.code}): ${res.stderr || res.stdout}`);
            }
        } else if (ctx.dbType === "postgres") {
            const passPrefix = (ctx.dbPassword || ctx.rootPassword) ? `PGPASSWORD=${escapeShellArg(ctx.dbPassword || ctx.rootPassword!)} ` : "";
            const hostPart = ctx.host ? `-h ${escapeShellArg(ctx.host)} ` : "";
            const portPart = ctx.port ? `-p ${ctx.port} ` : "";
            const user = ctx.dbUser || ctx.rootUser;

            let fullCmd: string;
            if (remoteFilePath.endsWith(".dump")) {
                fullCmd = `${passPrefix}pg_restore ${hostPart}${portPart}-U ${escapeShellArg(user)} -d ${escapeShellArg(ctx.dbName!)} --clean --if-exists ${escapeShellArg(remoteFilePath)}`;
            } else {
                const catCmd = isGz ? `gzip -dc ${escapeShellArg(remoteFilePath)}` : `cat ${escapeShellArg(remoteFilePath)}`;
                fullCmd = `${catCmd} | ${passPrefix}psql ${hostPart}${portPart}-U ${escapeShellArg(user)} -d ${escapeShellArg(ctx.dbName!)}`;
            }

            const res = await exec(execBundle.ssh, fullCmd);
            if (res.code !== 0) {
                throw new Error(`PostgreSQL restore failed (exit code ${res.code}): ${res.stderr || res.stdout}`);
            }
        } else if (ctx.dbType === "sqlite") {
            const targetPath = ctx.sqlitePath || posixJoin(env.deployTo.trim(), "shared", `${ctx.dbName}.sqlite`);
            const cpCmd = isGz
                ? `gzip -dc ${escapeShellArg(remoteFilePath)} > ${escapeShellArg(targetPath)}`
                : `cp -f ${escapeShellArg(remoteFilePath)} ${escapeShellArg(targetPath)}`;
            await exec(execBundle.ssh, cpCmd);
        }

        log.ok(`Database '${ctx.dbName}' restored successfully from ${path.basename(dumpFile)}.`);
    } finally {
        if (isTempUpload) {
            await exec(execBundle.ssh, `rm -f ${escapeShellArg(remoteFilePath)} 2>/dev/null || true`);
        }
        await close(execBundle);
    }
}

/**
 * Optimizes database tables and reclaims disk space.
 */
export async function dbOptimize(opts: DatabaseCommandOptions) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];
    if (!env) throw new Error(`Environment '${envName}' not found`);

    const bundle = await connect(env);
    let ctx: ResolvedDatabaseContext;
    try {
        ctx = await resolveDatabaseContext(opts, bundle.ssh);
    } finally {
        await close(bundle);
    }

    if (!ctx.dbName && ctx.dbType !== "sqlite") {
        throw new Error("Database name is required for optimization.");
    }

    log.info(`Optimizing database '${ctx.dbName}' (${ctx.dbType}) on ${ctx.connConfig.host}...`);

    const execBundle = await connect(ctx.connConfig);
    try {
        if (ctx.dbType === "mysql") {
            const auth = buildMysqlCliAuthArgs({
                host: ctx.host,
                port: ctx.port,
                user: ctx.rootUser,
                password: ctx.rootPassword || ctx.dbPassword,
                sudoPrefix: ctx.sudoPrefix,
                isExplicitAdmin: ctx.isExplicitAdmin,
            });

            const remoteCmd = `${auth.sudoPrefix}${auth.envPrefix}mysqlcheck ${auth.cliArgs} --optimize --databases ${escapeShellArg(ctx.dbName!)}`;
            log.verbose(`Executing: ${remoteCmd}`);
            const res = await exec(execBundle.ssh, remoteCmd);
            if (res.code !== 0) {
                throw new Error(`MySQL optimize failed: ${res.stderr || res.stdout}`);
            }
            if (res.stdout) log.info(res.stdout.trim());
        } else if (ctx.dbType === "postgres") {
            const passPrefix = (ctx.dbPassword || ctx.rootPassword) ? `PGPASSWORD=${escapeShellArg(ctx.dbPassword || ctx.rootPassword!)} ` : "";
            const hostPart = ctx.host ? `-h ${escapeShellArg(ctx.host)} ` : "";
            const portPart = ctx.port ? `-p ${ctx.port} ` : "";
            const user = ctx.dbUser || ctx.rootUser;
            const remoteCmd = `${passPrefix}psql ${hostPart}${portPart}-U ${escapeShellArg(user)} -d ${escapeShellArg(ctx.dbName!)} -c "VACUUM ANALYZE;"`;
            const res = await exec(execBundle.ssh, remoteCmd);
            if (res.code !== 0) {
                throw new Error(`PostgreSQL VACUUM failed: ${res.stderr || res.stdout}`);
            }
            if (res.stdout) log.info(res.stdout.trim());
        } else if (ctx.dbType === "sqlite") {
            const targetPath = ctx.sqlitePath || (ctx.deployTo ? posixJoin(ctx.deployTo.trim(), "shared", `${ctx.dbName}.sqlite`) : `${ctx.dbName}.sqlite`);
            await exec(execBundle.ssh, `sqlite3 ${escapeShellArg(targetPath)} "VACUUM;"`);
        }

        log.ok(`Database '${ctx.dbName}' optimization completed successfully.`);
    } finally {
        await close(execBundle);
    }
}

/**
 * Opens an interactive remote database client TTY shell.
 */
export async function dbConsole(opts: DatabaseCommandOptions) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];
    if (!env) throw new Error(`Environment '${envName}' not found`);

    let ctx: ResolvedDatabaseContext;
    const bundle = await connect(env);
    try {
        ctx = await resolveDatabaseContext(opts, bundle.ssh);
    } finally {
        await close(bundle);
    }

    const sshArgs: string[] = [];
    if (ctx.connConfig.port && ctx.connConfig.port !== 22) {
        sshArgs.push("-p", String(ctx.connConfig.port));
    }
    if (ctx.connConfig.ssh_key_path) {
        sshArgs.push("-i", ctx.connConfig.ssh_key_path);
    }
    sshArgs.push("-t");
    sshArgs.push(`${ctx.connConfig.username}@${ctx.connConfig.host}`);

    let remoteDbCmd: string;
    if (ctx.dbType === "mysql") {
        const user = (opts.asAdmin || opts.asSudo) ? ctx.rootUser : (ctx.dbUser || ctx.rootUser);
        const pass = (opts.asAdmin || opts.asSudo) ? ctx.rootPassword : (ctx.dbPassword || ctx.rootPassword);

        if ((opts.asAdmin || opts.asSudo) && !pass && (ctx.host === "127.0.0.1" || ctx.host === "localhost")) {
            remoteDbCmd = `${ctx.sudoPrefix}mysql -u ${escapeShellArg(user)} ${ctx.dbName ? escapeShellArg(ctx.dbName) : ""}`;
        } else {
            const passFlag = pass ? `-p${escapeShellArg(pass)} ` : "";
            remoteDbCmd = `mysql -h ${escapeShellArg(ctx.host)} ${ctx.port ? `-P ${ctx.port} ` : ""}-u ${escapeShellArg(user)} ${passFlag}${ctx.dbName ? escapeShellArg(ctx.dbName) : ""}`;
        }
    } else if (ctx.dbType === "postgres") {
        const user = (opts.asAdmin || opts.asSudo) ? ctx.rootUser : (ctx.dbUser || ctx.rootUser);
        const pass = (opts.asAdmin || opts.asSudo) ? ctx.rootPassword : (ctx.dbPassword || ctx.rootPassword);

        if ((opts.asAdmin || opts.asSudo) && !pass) {
            remoteDbCmd = `${ctx.sudoPrefix}-u ${escapeShellArg(user)} psql ${ctx.dbName ? escapeShellArg(ctx.dbName) : ""}`;
        } else {
            const passPrefix = pass ? `PGPASSWORD=${escapeShellArg(pass)} ` : "";
            remoteDbCmd = `${passPrefix}psql -h ${escapeShellArg(ctx.host)} ${ctx.port ? `-p ${ctx.port} ` : ""}-U ${escapeShellArg(user)} ${ctx.dbName ? `-d ${escapeShellArg(ctx.dbName)}` : ""}`;
        }
    } else {
        const target = ctx.sqlitePath || (ctx.deployTo ? posixJoin(ctx.deployTo.trim(), "shared", `${ctx.dbName}.sqlite`) : `${ctx.dbName}.sqlite`);
        remoteDbCmd = `sqlite3 ${escapeShellArg(target)}`;
    }

    sshArgs.push(remoteDbCmd);
    log.info(`Connecting to remote database console on ${ctx.connConfig.host}...`);

    return new Promise<void>((resolve, reject) => {
        const child = spawn("ssh", sshArgs, { stdio: "inherit" });
        child.on("error", (err) => {
            log.err(`Failed to launch ssh database console: ${err.message}`);
            reject(err);
        });
        child.on("close", () => resolve());
    });
}
