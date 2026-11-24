import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import * as tar from "tar";
import { Client } from "ssh2";
import SFTPClient from "ssh2-sftp-client";
import { exec } from "../core/ssh.js";
import { escapeShellArg, posixJoin } from "../core/utils.js";
import { log } from "../core/logger.js";

export interface SiteBackupOptions {
    domains: string[];
    appName: string;
    deployTo: string;
    outputDir?: string;
    includeEnv?: boolean;
    includeShared?: boolean;
    sudoPrefix?: string;
}

export interface BackupResult {
    archivePath: string;
    sizeBytes: number;
    filesIncluded: string[];
}

/**
 * Reads a remote file if it exists, using sudo cat if required.
 * Returns null if the file does not exist.
 */
async function readRemoteFileSafe(
    ssh: Client,
    remotePath: string,
    sudoPrefix: string = ""
): Promise<string | null> {
    const checkCmd = `${sudoPrefix}test -f ${escapeShellArg(remotePath)}`;
    const checkRes = await exec(ssh, checkCmd);
    if (checkRes.code !== 0) {
        return null;
    }

    const catCmd = `${sudoPrefix}cat ${escapeShellArg(remotePath)}`;
    const catRes = await exec(ssh, catCmd);
    if (catRes.code === 0) {
        return catRes.stdout;
    }
    return null;
}

/**
 * Creates a local timestamped archive (.tar.gz) containing remote site configurations:
 * - Nginx virtual hosts (/etc/nginx/sites-available/<domain>)
 * - Systemd application services (/etc/systemd/system/<appName>.service, <appName>-worker.service)
 * - Sudoers configuration (/etc/sudoers.d/dploy-<appName>)
 * - Application shared .env file (if present and requested)
 * - Metadata manifest (backup-manifest.json)
 */
export async function backupSiteConfigurations(
    ssh: Client,
    sftp: SFTPClient,
    opts: SiteBackupOptions
): Promise<BackupResult> {
    const sudo = opts.sudoPrefix ?? "";
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "dploy-site-backup-"));
    const filesIncluded: string[] = [];

    try {
        const primaryDomain = opts.domains[0] || opts.appName;
        const now = new Date();
        const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");

        // 1. Fetch Nginx configs for each domain
        for (const domain of opts.domains) {
            const remoteNginx = `/etc/nginx/sites-available/${domain}`;
            const nginxContent = await readRemoteFileSafe(ssh, remoteNginx, sudo);
            if (nginxContent !== null) {
                const targetPath = path.join(stagingDir, "nginx", `${domain}.conf`);
                await fs.outputFile(targetPath, nginxContent, "utf8");
                filesIncluded.push(`nginx/${domain}.conf`);
                log.debug(`Backed up remote Nginx config for ${domain}`);
            }
        }

        // 2. Fetch Systemd units
        const systemdUnits = [
            `${opts.appName}.service`,
            `${opts.appName}-worker.service`,
        ];
        for (const unit of systemdUnits) {
            const remoteUnit = `/etc/systemd/system/${unit}`;
            const unitContent = await readRemoteFileSafe(ssh, remoteUnit, sudo);
            if (unitContent !== null) {
                const targetPath = path.join(stagingDir, "systemd", unit);
                await fs.outputFile(targetPath, unitContent, "utf8");
                filesIncluded.push(`systemd/${unit}`);
                log.debug(`Backed up remote systemd unit: ${unit}`);
            }
        }

        // 3. Fetch Sudoers rule
        const sudoersFile = `/etc/sudoers.d/dploy-${opts.appName}`;
        const sudoersContent = await readRemoteFileSafe(ssh, sudoersFile, sudo);
        if (sudoersContent !== null) {
            const targetPath = path.join(stagingDir, "sudoers", `dploy-${opts.appName}`);
            await fs.outputFile(targetPath, sudoersContent, "utf8");
            filesIncluded.push(`sudoers/dploy-${opts.appName}`);
            log.debug(`Backed up remote sudoers rule: dploy-${opts.appName}`);
        }

        // 4. Fetch shared .env file if requested (default true)
        if (opts.includeEnv !== false) {
            const remoteEnv = posixJoin(opts.deployTo, "shared", ".env");
            const envContent = await readRemoteFileSafe(ssh, remoteEnv, sudo);
            if (envContent !== null) {
                const targetPath = path.join(stagingDir, "env", ".env");
                await fs.outputFile(targetPath, envContent, "utf8");
                filesIncluded.push("env/.env");
                log.debug("Backed up remote shared/.env");
            }
        }

        // 5. Generate backup manifest
        const manifest = {
            appName: opts.appName,
            primaryDomain,
            domains: opts.domains,
            deployTo: opts.deployTo,
            createdAt: now.toISOString(),
            filesCount: filesIncluded.length,
            files: filesIncluded,
        };
        await fs.outputJson(path.join(stagingDir, "manifest.json"), manifest, { spaces: 2 });
        filesIncluded.push("manifest.json");

        // 6. Compress into .tar.gz
        const outDir = opts.outputDir ? path.resolve(opts.outputDir) : path.join(process.cwd(), "backups");
        await fs.ensureDir(outDir);

        const archiveFilename = `site-backup-${primaryDomain}-${timestamp}.tar.gz`;
        const archivePath = path.join(outDir, archiveFilename);

        await tar.create(
            {
                gzip: true,
                file: archivePath,
                cwd: stagingDir,
            },
            await fs.readdir(stagingDir)
        );

        const stat = await fs.stat(archivePath);
        return {
            archivePath,
            sizeBytes: stat.size,
            filesIncluded,
        };
    } finally {
        await fs.remove(stagingDir);
    }
}
