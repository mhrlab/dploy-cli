import { Client } from "ssh2";
import { exec } from "../core/ssh.js";
import { escapeShellArg } from "../core/utils.js";
import { log } from "../core/logger.js";

export interface SiteRemovePlan {
    domains: string[];
    appName: string;
    deployTo: string;
    purgeNginx?: boolean;
    purgeServices?: boolean;
    purgeSudoers?: boolean;
    purgeSsl?: boolean;
    purgeFiles?: boolean;
    sudoPrefix?: string;
}

export interface RemoveStepResult {
    step: string;
    success: boolean;
    message: string;
}

/**
 * Executes teardown of site services, web server configs, and optional assets on the remote server.
 */
export async function removeSiteConfigurations(
    ssh: Client,
    plan: SiteRemovePlan
): Promise<RemoveStepResult[]> {
    const sudo = plan.sudoPrefix ?? "";
    const results: RemoveStepResult[] = [];

    // 1. Remove Systemd Services
    if (plan.purgeServices !== false) {
        const units = [`${plan.appName}.service`, `${plan.appName}-worker.service`];
        for (const unit of units) {
            const unitName = unit.replace(".service", "");
            // Check if service exists
            const checkRes = await exec(ssh, `test -f /etc/systemd/system/${escapeShellArg(unit)}`);
            if (checkRes.code === 0) {
                log.info(`Stopping and disabling service ${unit}...`);
                await exec(ssh, `${sudo}systemctl stop ${escapeShellArg(unitName)} || true`);
                await exec(ssh, `${sudo}systemctl disable ${escapeShellArg(unitName)} || true`);
                await exec(ssh, `${sudo}rm -f /etc/systemd/system/${escapeShellArg(unit)}`);
                results.push({ step: `systemd:${unit}`, success: true, message: `Removed ${unit}` });
            }
        }
        await exec(ssh, `${sudo}systemctl daemon-reload || true`);
    }

    // 2. Remove Nginx Configurations
    if (plan.purgeNginx !== false) {
        for (const domain of plan.domains) {
            const enabledPath = `/etc/nginx/sites-enabled/${domain}`;
            const availablePath = `/etc/nginx/sites-available/${domain}`;

            log.info(`Disabling and removing Nginx configuration for ${domain}...`);
            await exec(ssh, `${sudo}rm -f ${escapeShellArg(enabledPath)}`);
            await exec(ssh, `${sudo}rm -f ${escapeShellArg(availablePath)}`);
            results.push({ step: `nginx:${domain}`, success: true, message: `Removed Nginx virtual host for ${domain}` });
        }

        // Test and reload Nginx
        const testRes = await exec(ssh, `${sudo}nginx -t`);
        if (testRes.code === 0) {
            await exec(ssh, `${sudo}systemctl reload nginx`);
            log.ok("Nginx configuration reloaded cleanly");
        } else {
            log.warn(`Nginx syntax check warning: ${testRes.stderr || testRes.stdout}`);
        }
    }

    // 3. Remove Sudoers File
    if (plan.purgeSudoers !== false) {
        const sudoersFile = `/etc/sudoers.d/dploy-${plan.appName}`;
        log.info(`Removing sudoers rule ${sudoersFile}...`);
        await exec(ssh, `${sudo}rm -f ${escapeShellArg(sudoersFile)}`);
        results.push({ step: "sudoers", success: true, message: `Removed ${sudoersFile}` });
    }

    // 4. Purge SSL (Certbot) if requested
    if (plan.purgeSsl) {
        for (const domain of plan.domains) {
            log.info(`Deleting Certbot SSL certificate for ${domain}...`);
            const certRes = await exec(ssh, `${sudo}certbot delete --cert-name ${escapeShellArg(domain)} --non-interactive || true`);
            if (certRes.code === 0) {
                results.push({ step: `ssl:${domain}`, success: true, message: `Deleted Certbot certificate for ${domain}` });
            }
        }
    }

    // 5. Purge Application Files (/var/www/<appName>) if explicitly requested
    if (plan.purgeFiles) {
        log.warn(`Purging deploy directory: ${plan.deployTo}...`);
        const rmRes = await exec(ssh, `${sudo}rm -rf ${escapeShellArg(plan.deployTo)}`);
        if (rmRes.code === 0) {
            results.push({ step: "files", success: true, message: `Deleted directory ${plan.deployTo}` });
        } else {
            results.push({ step: "files", success: false, message: `Failed to remove ${plan.deployTo}: ${rmRes.stderr}` });
        }
    }

    return results;
}
