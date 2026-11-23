import { Client } from "ssh2";
import { posixJoin, escapeShellArg } from "../core/utils.js";
import { exec, removePath } from "../core/ssh.js";
import { log } from "../core/logger.js";

export type DatabaseType = "mysql" | "postgres" | "sqlite";

export interface DatabaseBackupConfig {
    enabled?: boolean;
    type?: DatabaseType;
    name?: string;
    user?: string;
    password?: string;
    host?: string;
    port?: number;
    path?: string; // For SQLite
    keep?: number;
    extraArgs?: string[];
}

export function buildDatabaseDumpCommand(
    config: DatabaseBackupConfig,
    backupFilePath: string,
    releaseDir?: string
): string {
    const type = config.type || "mysql";
    const gzTarget = escapeShellArg(backupFilePath);

    switch (type) {
        case "mysql": {
            const dbName = config.name ? escapeShellArg(config.name) : "";
            if (!dbName) throw new Error("Database name is required for MySQL backup");

            const parts = ["mysqldump", "--single-transaction", "--quick"];
            if (config.host) parts.push(`-h ${escapeShellArg(config.host)}`);
            if (config.port) parts.push(`-P ${config.port}`);
            if (config.user) parts.push(`-u ${escapeShellArg(config.user)}`);
            if (config.password) parts.push(`-p${escapeShellArg(config.password)}`);
            if (config.extraArgs?.length) parts.push(...config.extraArgs);
            parts.push(dbName);
            parts.push(`| gzip -9 > ${gzTarget}`);
            return parts.join(" ");
        }

        case "postgres": {
            const dbName = config.name ? escapeShellArg(config.name) : "";
            if (!dbName) throw new Error("Database name is required for PostgreSQL backup");

            const parts: string[] = [];
            if (config.password) parts.push(`PGPASSWORD=${escapeShellArg(config.password)}`);
            parts.push("pg_dump", "-Fc");
            if (config.host) parts.push(`-h ${escapeShellArg(config.host)}`);
            if (config.port) parts.push(`-p ${config.port}`);
            if (config.user) parts.push(`-U ${escapeShellArg(config.user)}`);
            if (config.extraArgs?.length) parts.push(...config.extraArgs);
            parts.push(dbName);
            parts.push(`> ${gzTarget}`);
            return parts.join(" ");
        }

        case "sqlite": {
            let sqliteFile = config.path || config.name;
            if (!sqliteFile) throw new Error("Database path or name is required for SQLite backup");

            if (releaseDir && !sqliteFile.startsWith("/")) {
                sqliteFile = posixJoin(releaseDir, sqliteFile);
            }
            return `sqlite3 ${escapeShellArg(sqliteFile)} ".backup ${gzTarget}" || cp -f ${escapeShellArg(sqliteFile)} ${gzTarget}`;
        }

        default:
            throw new Error(`Unsupported database backup type: ${type}`);
    }
}

export async function executeDatabaseBackup(
    ssh: Client,
    deployTo: string,
    version: string,
    dbConfig: DatabaseBackupConfig,
    releaseDir?: string
): Promise<string> {
    const backupsDir = posixJoin(deployTo.trim(), "backups");
    await exec(ssh, `mkdir -p ${escapeShellArg(backupsDir)}`);

    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const dbType = dbConfig.type || "mysql";
    const extension = dbType === "postgres" ? "dump" : "sql.gz";
    const backupFileName = `db-${dbConfig.name || "app"}-${version}-${stamp}.${extension}`;
    const backupFilePath = posixJoin(backupsDir, backupFileName);

    log.info(`Creating database backup (${dbType}) -> ${backupFileName}...`);
    const dumpCmd = buildDatabaseDumpCommand(dbConfig, backupFilePath, releaseDir);
    log.debug(`Dump command: ${dumpCmd}`);

    const res = await exec(ssh, dumpCmd);
    if (res.code !== 0) {
        throw new Error(
            `Database backup failed (code ${res.code}): ${res.stderr || res.stdout || "unknown error"}`
        );
    }

    log.ok(`Database backup completed successfully: ${backupFileName}`);

    // Prune old backups if keep is configured
    const keep = dbConfig.keep ?? 5;
    if (keep > 0) {
        try {
            const listRes = await exec(ssh, `ls -1t ${escapeShellArg(backupsDir)}/db-*.${extension} 2>/dev/null || true`);
            const files = listRes.stdout.split(/\r?\n/).filter(Boolean);
            if (files.length > keep) {
                const toDelete = files.slice(keep);
                log.verbose(`Pruning ${toDelete.length} old database backup(s)...`);
                for (const oldFile of toDelete) {
                    await removePath(ssh, oldFile);
                }
            }
        } catch (pruneErr: any) {
            log.warn(`Warning: failed to prune old backups: ${pruneErr.message}`);
        }
    }

    return backupFilePath;
}
