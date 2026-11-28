import { Client } from "ssh2";
import { exec, type SSHBundle } from "../core/ssh.js";
import { posixJoin, escapeShellArg } from "../core/utils.js";
import { EnvironmentConfig, ProvisionConfig, ProvisionPermissionsConfig, ProvisionServiceConfig } from "../core/config.js";
import { log } from "../core/logger.js";
import { assertValidSharedItem } from "./shared.js";

export type ProvisionStepName = "prereqs" | "dirs" | "shared" | "permissions" | "service";

export interface ProvisionOptions {
    env?: string;
    dryRun?: boolean;
    force?: boolean;
    skipChecks?: boolean;
    only?: ProvisionStepName | string;
    json?: boolean;
    asAdmin?: boolean;
    asSudo?: boolean;
    adminUser?: string;
    adminKey?: string;
    adminPassword?: string;
}

export interface ProvisionStepResult {
    step: ProvisionStepName;
    status: "ok" | "skipped" | "failed" | "planned";
    message: string;
    details?: string[];
}

export interface ProvisionReport {
    environment: string;
    host?: string;
    deployTo: string;
    dryRun: boolean;
    success: boolean;
    steps: ProvisionStepResult[];
}

export const DEFAULT_PROVISION_DIRS = ["releases", "shared", "tmp", "logs"];

/**
 * Execute command with sudo -n fallback if the primary unprivileged command fails.
 */
async function execWithSudoFallback(ssh: Client, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const res = await exec(ssh, command);
    if (res.code === 0) return res;

    log.debug(`Command failed (code ${res.code}), attempting with sudo -n: ${command}`);
    const sudoRes = await exec(ssh, `sudo -n ${command}`);
    if (sudoRes.code === 0) {
        log.debug(`Command succeeded with sudo -n: ${command}`);
        return sudoRes;
    }

    return res;
}

/**
 * Check if remote host has required binaries installed (tar, curl, runtime).
 */
export async function checkRemotePrerequisites(
    ssh: Client,
    runtime?: Record<string, string>,
    dryRun: boolean = false
): Promise<ProvisionStepResult> {
    const details: string[] = [];
    const missing: string[] = [];

    if (dryRun) {
        details.push("Would check for binary: tar");
        details.push("Would check for binary: curl");
        if (runtime) {
            for (const [bin, ver] of Object.entries(runtime)) {
                details.push(`Would check for runtime: ${bin}${ver ? ` (>= ${ver})` : ""}`);
            }
        }
        return {
            step: "prereqs",
            status: "planned",
            message: "Prerequisites verification planned",
            details,
        };
    }

    // Check tar
    const tarCheck = await exec(ssh, "command -v tar >/dev/null 2>&1 && echo ok || echo missing");
    if (tarCheck.stdout.trim() === "ok") {
        details.push("✓ tar found");
    } else {
        missing.push("tar");
    }

    // Check curl
    const curlCheck = await exec(ssh, "command -v curl >/dev/null 2>&1 && echo ok || echo missing");
    if (curlCheck.stdout.trim() === "ok") {
        details.push("✓ curl found");
    } else {
        missing.push("curl");
    }

    // Check runtime binaries (e.g. node, php, python, go)
    if (runtime) {
        for (const [bin, expectedVer] of Object.entries(runtime)) {
            const check = await exec(
                ssh,
                `command -v ${escapeShellArg(bin)} >/dev/null 2>&1 && ${escapeShellArg(bin)} --version 2>&1 || echo missing`
            );
            const output = check.stdout.trim();
            if (output && output !== "missing") {
                const firstLine = output.split(/\r?\n/)[0];
                details.push(`✓ ${bin} found (${firstLine})`);
            } else {
                missing.push(bin + (expectedVer ? ` (expected ${expectedVer})` : ""));
            }
        }
    }

    if (missing.length > 0) {
        return {
            step: "prereqs",
            status: "failed",
            message: `Missing prerequisites: ${missing.join(", ")}`,
            details,
        };
    }

    return {
        step: "prereqs",
        status: "ok",
        message: "All prerequisite binaries verified",
        details,
    };
}

/**
 * Ensure remote directory structure exists.
 */
export async function provisionDirectories(
    ssh: Client,
    deployTo: string,
    customDirs: string[] = [],
    dryRun: boolean = false
): Promise<ProvisionStepResult> {
    const dirSet = new Set<string>([...DEFAULT_PROVISION_DIRS, ...customDirs]);
    const dirs = Array.from(dirSet);
    const details: string[] = [];
    let hasError = false;

    for (const dir of dirs) {
        const fullPath = posixJoin(deployTo, dir);
        if (dryRun) {
            details.push(`[dry-run] Would create directory: ${fullPath}`);
        } else {
            const res = await execWithSudoFallback(ssh, `mkdir -p ${escapeShellArg(fullPath)}`);
            if (res.code === 0) {
                details.push(`Created directory: ${fullPath}`);
            } else {
                hasError = true;
                const errDetail = res.stderr.trim() || `exit code ${res.code}`;
                details.push(`✗ Failed to create directory: ${fullPath} (${errDetail})`);
            }
        }
    }

    if (hasError) {
        return {
            step: "dirs",
            status: "failed",
            message: "Failed to create directory structure (check permissions or sudo)",
            details,
        };
    }

    return {
        step: "dirs",
        status: dryRun ? "planned" : "ok",
        message: `${dirs.length} directory path(s) ${dryRun ? "planned" : "ensured"}`,
        details,
    };
}

/**
 * Initialize shared directory and files.
 */
export async function provisionSharedResources(
    ssh: Client,
    deployTo: string,
    sharedItems: string[],
    sharedDefaults: Record<string, string> = {},
    dryRun: boolean = false,
    force: boolean = false
): Promise<ProvisionStepResult> {
    const sharedDir = posixJoin(deployTo, "shared");
    const details: string[] = [];
    let hasError = false;

    if (!sharedItems.length) {
        return {
            step: "shared",
            status: "skipped",
            message: "No shared resources configured",
        };
    }

    if (!dryRun) {
        const res = await execWithSudoFallback(ssh, `mkdir -p ${escapeShellArg(sharedDir)}`);
        if (res.code !== 0) {
            return {
                step: "shared",
                status: "failed",
                message: `Failed to create shared directory: ${res.stderr.trim() || `exit code ${res.code}`}`,
                details: [`Failed to create ${sharedDir}`],
            };
        }
    }

    for (const rawItem of sharedItems) {
        assertValidSharedItem(rawItem);
        // Normalize wildcards like "writable/*" to directory "writable/"
        const item = rawItem.endsWith("/*") ? rawItem.slice(0, -1) : rawItem;
        const sharedPath = posixJoin(sharedDir, item);
        const cleanItem = item.replace(/\/$/, "");

        if (item.endsWith("/")) {
            if (dryRun) {
                details.push(`[dry-run] Would create shared directory: ${sharedPath}`);
            } else {
                const res = await execWithSudoFallback(ssh, `mkdir -p ${escapeShellArg(sharedPath)}`);
                if (res.code === 0) {
                    details.push(`Created shared directory: ${sharedPath}`);
                    // Special handling for CodeIgniter 4 writable subdirectories
                    if (cleanItem === "writable") {
                        await execWithSudoFallback(
                            ssh,
                            `mkdir -p ${escapeShellArg(sharedPath)}cache ${escapeShellArg(sharedPath)}logs ${escapeShellArg(sharedPath)}session ${escapeShellArg(sharedPath)}uploads ${escapeShellArg(sharedPath)}debugbar`
                        );
                    }
                } else {
                    hasError = true;
                    const errDetail = res.stderr.trim() || `exit code ${res.code}`;
                    details.push(`✗ Failed to create shared directory: ${sharedPath} (${errDetail})`);
                }
            }
        } else {
            // Ensure parent directory for sharedPath exists ONLY if item contains subdirectories
            if (cleanItem.includes("/")) {
                const parentRel = cleanItem.substring(0, cleanItem.lastIndexOf("/"));
                const parentDir = posixJoin(sharedDir, parentRel);
                if (dryRun) {
                    details.push(`[dry-run] Would ensure parent directory: ${parentDir}`);
                } else {
                    await execWithSudoFallback(ssh, `mkdir -p ${escapeShellArg(parentDir)}`);
                }
            }

            if (dryRun) {
                details.push(`[dry-run] Would ensure shared file: ${sharedPath}`);
            } else {
                // Heal any accidental empty directory created where a file was expected
                await execWithSudoFallback(
                    ssh,
                    `if [ -d ${escapeShellArg(sharedPath)} ]; then rmdir ${escapeShellArg(sharedPath)} 2>/dev/null || true; fi`
                );

                const { stdout } = await exec(ssh, `[ -e ${escapeShellArg(sharedPath)} ] && echo 1 || echo 0`);
                const exists = stdout.trim() === "1";

                if (!exists || force) {
                    const res = await execWithSudoFallback(ssh, `touch ${escapeShellArg(sharedPath)}`);
                    if (res.code === 0) {
                        details.push(`Created shared file: ${sharedPath}`);
                    } else {
                        hasError = true;
                        const errDetail = res.stderr.trim() || `exit code ${res.code}`;
                        details.push(`✗ Failed to create shared file: ${sharedPath} (${errDetail})`);
                    }
                } else {
                    details.push(`Shared file already exists: ${sharedPath}`);
                }
            }
        }
    }

    if (hasError) {
        return {
            step: "shared",
            status: "failed",
            message: "Failed to initialize one or more shared resources",
            details,
        };
    }

    return {
        step: "shared",
        status: dryRun ? "planned" : "ok",
        message: `${sharedItems.length} shared item(s) ${dryRun ? "planned" : "processed"}`,
        details,
    };
}

/**
 * Configure file permissions and ownership on remote deployment directory.
 */
export async function provisionPermissions(
    ssh: Client,
    deployTo: string,
    permissions?: ProvisionPermissionsConfig,
    dryRun: boolean = false
): Promise<ProvisionStepResult> {
    if (!permissions || (!permissions.mode && !permissions.sharedMode && !permissions.owner && !permissions.group)) {
        return {
            step: "permissions",
            status: "skipped",
            message: "No permissions configuration specified",
        };
    }

    const details: string[] = [];
    let hasError = false;

    // 1. Directory mode
    if (permissions.mode) {
        if (dryRun) {
            details.push(`[dry-run] Would set directory mode ${permissions.mode} on ${deployTo}`);
        } else {
            const res = await execWithSudoFallback(ssh, `chmod ${escapeShellArg(permissions.mode)} ${escapeShellArg(deployTo)}`);
            if (res.code === 0) {
                details.push(`Set directory mode ${permissions.mode} on ${deployTo}`);
            } else {
                hasError = true;
                const errDetail = res.stderr.trim() || `exit code ${res.code}`;
                details.push(`✗ Failed to set directory mode on ${deployTo} (${errDetail})`);
            }
        }
    }

    // 2. Shared directory mode
    if (permissions.sharedMode) {
        const sharedDir = posixJoin(deployTo, "shared");
        if (dryRun) {
            details.push(`[dry-run] Would set recursive mode ${permissions.sharedMode} on ${sharedDir}`);
        } else {
            const res = await execWithSudoFallback(ssh, `chmod -R ${escapeShellArg(permissions.sharedMode)} ${escapeShellArg(sharedDir)}`);
            if (res.code === 0) {
                details.push(`Set recursive mode ${permissions.sharedMode} on ${sharedDir}`);
            } else {
                hasError = true;
                const errDetail = res.stderr.trim() || `exit code ${res.code}`;
                details.push(`✗ Failed to set mode on ${sharedDir} (${errDetail})`);
            }
        }
    }

    // 3. Ownership
    if (permissions.owner || permissions.group) {
        const ownership = [permissions.owner, permissions.group].filter(Boolean).join(":");
        if (dryRun) {
            details.push(`[dry-run] Would change ownership to ${ownership} on ${deployTo}`);
        } else {
            const res = await execWithSudoFallback(ssh, `chown -R ${escapeShellArg(ownership)} ${escapeShellArg(deployTo)}`);
            if (res.code === 0) {
                details.push(`Set ownership to ${ownership} on ${deployTo}`);
            } else {
                hasError = true;
                const errDetail = res.stderr.trim() || `exit code ${res.code}`;
                details.push(`✗ Failed to set ownership to ${ownership} on ${deployTo} (${errDetail})`);
            }
        }
    }

    if (hasError) {
        return {
            step: "permissions",
            status: "failed",
            message: "Failed to configure permissions or ownership (check sudo privileges)",
            details,
        };
    }

    return {
        step: "permissions",
        status: dryRun ? "planned" : "ok",
        message: "Permissions configured",
        details,
    };
}

/**
 * Normalize single service and/or array of services into ProvisionServiceConfig[]
 */
export function normalizeServices(
    service?: ProvisionServiceConfig,
    services?: (ProvisionServiceConfig | string)[]
): ProvisionServiceConfig[] {
    const result: ProvisionServiceConfig[] = [];
    if (service && service.name) {
        result.push(service);
    }
    if (Array.isArray(services)) {
        for (const s of services) {
            if (typeof s === "string" && s.trim()) {
                result.push({ name: s.trim(), type: "systemd" });
            } else if (s && typeof s === "object" && s.name) {
                result.push({ type: "systemd", ...s });
            }
        }
    }
    return result;
}

/**
 * Verify or check background service integration (systemd / PM2) for one or more services.
 */
export async function provisionServices(
    ssh: Client,
    serviceConfigs: ProvisionServiceConfig[],
    dryRun: boolean = false
): Promise<ProvisionStepResult> {
    if (!serviceConfigs || serviceConfigs.length === 0) {
        return {
            step: "service",
            status: "skipped",
            message: "No service integration specified",
        };
    }

    const details: string[] = [];

    if (dryRun) {
        for (const s of serviceConfigs) {
            const type = s.type ?? "systemd";
            details.push(`[dry-run] Would verify ${type} service: ${s.name}`);
        }
        return {
            step: "service",
            status: "planned",
            message: `${serviceConfigs.length} service(s) planned for verification`,
            details,
        };
    }

    let allActive = true;
    for (const s of serviceConfigs) {
        const type = s.type ?? "systemd";
        if (!s.name) continue;

        if (type === "systemd") {
            const check = await exec(
                ssh,
                `systemctl is-active ${escapeShellArg(s.name)} 2>&1 || true`
            );
            const state = check.stdout.trim();
            details.push(`Systemd service '${s.name}' state: ${state}`);
            if (state !== "active" && state !== "activating") {
                allActive = false;
            }
        } else if (type === "pm2") {
            const check = await exec(
                ssh,
                `pm2 describe ${escapeShellArg(s.name)} >/dev/null 2>&1 && echo running || echo not_found`
            );
            const state = check.stdout.trim();
            details.push(`PM2 service '${s.name}' state: ${state}`);
            if (state !== "running") {
                allActive = false;
            }
        }
    }

    return {
        step: "service",
        status: allActive ? "ok" : "failed",
        message: allActive
            ? `${serviceConfigs.length} service(s) verified active`
            : `One or more services are not active`,
        details,
    };
}

/**
 * Verify or check background service integration (systemd / PM2).
 */
export async function provisionService(
    ssh: Client,
    service?: ProvisionServiceConfig,
    dryRun: boolean = false
): Promise<ProvisionStepResult> {
    const list = normalizeServices(service);
    return provisionServices(ssh, list, dryRun);
}

/**
 * Execute full server provisioning pipeline.
 */
export async function executeProvisioning(
    bundle: SSHBundle,
    env: EnvironmentConfig,
    options: ProvisionOptions
): Promise<ProvisionReport> {
    const deployTo = env.deployTo!;
    const provCfg: ProvisionConfig = env.provision ?? {};
    const dryRun = !!options.dryRun;
    const force = !!options.force;
    const only = options.only;
    const steps: ProvisionStepResult[] = [];
    let success = true;

    const shouldRun = (step: ProvisionStepName): boolean => {
        if (!only) return true;
        return only === step;
    };

    // 1. Prerequisite verification
    if (shouldRun("prereqs")) {
        if (options.skipChecks || provCfg.checkPrerequisites === false) {
            steps.push({
                step: "prereqs",
                status: "skipped",
                message: "Prerequisites check skipped",
            });
        } else {
            const res = await checkRemotePrerequisites(bundle.ssh, provCfg.runtime, dryRun);
            steps.push(res);
            if (res.status === "failed") {
                success = false;
            }
        }
    }

    // 2. Directory creation
    if (shouldRun("dirs") && (provCfg.createDirs !== false)) {
        const res = await provisionDirectories(bundle.ssh, deployTo, provCfg.dirs, dryRun);
        steps.push(res);
        if (res.status === "failed") {
            success = false;
        }
    }

    // 3. Shared resource setup
    if (shouldRun("shared") && (provCfg.seedShared !== false)) {
        const shared = (env.shared ?? provCfg.shared ?? []) as string[];
        const defaults = env.sharedDefaults ?? provCfg.sharedDefaults ?? {};
        const res = await provisionSharedResources(bundle.ssh, deployTo, shared, defaults, dryRun, force);
        steps.push(res);
        if (res.status === "failed") {
            success = false;
        }
    }

    // 4. Permissions
    if (shouldRun("permissions") && (provCfg.configurePermissions !== false)) {
        const res = await provisionPermissions(bundle.ssh, deployTo, provCfg.permissions, dryRun);
        steps.push(res);
        if (res.status === "failed") {
            success = false;
        }
    }

    // 5. Service verification
    const services = normalizeServices(provCfg.service, provCfg.services);
    if (shouldRun("service") && services.length > 0) {
        const res = await provisionServices(bundle.ssh, services, dryRun);
        steps.push(res);
        if (res.status === "failed") {
            success = false;
        }
    }

    return {
        environment: options.env ?? "production",
        host: env.host,
        deployTo,
        dryRun,
        success,
        steps,
    };
}

/**
 * Plan provisioning actions offline without opening an SSH connection.
 */
export function planProvisioningOffline(
    env: EnvironmentConfig,
    options: ProvisionOptions
): ProvisionReport {
    const deployTo = env.deployTo!;
    const provCfg: ProvisionConfig = env.provision ?? {};
    const only = options.only;
    const steps: ProvisionStepResult[] = [];

    const shouldRun = (step: ProvisionStepName): boolean => {
        if (!only) return true;
        return only === step;
    };

    // 1. Prereqs
    if (shouldRun("prereqs")) {
        const details: string[] = [];
        if (options.skipChecks || provCfg.checkPrerequisites === false) {
            steps.push({
                step: "prereqs",
                status: "skipped",
                message: "Prerequisites check skipped",
            });
        } else {
            details.push("Would check for binary: tar");
            details.push("Would check for binary: curl");
            if (provCfg.runtime) {
                for (const [bin, ver] of Object.entries(provCfg.runtime)) {
                    details.push(`Would check for runtime: ${bin}${ver ? ` (>= ${ver})` : ""}`);
                }
            }
            steps.push({
                step: "prereqs",
                status: "planned",
                message: "Prerequisites verification planned",
                details,
            });
        }
    }

    // 2. Dirs
    if (shouldRun("dirs") && (provCfg.createDirs !== false)) {
        const dirSet = new Set<string>([...DEFAULT_PROVISION_DIRS, ...(provCfg.dirs ?? [])]);
        const details = Array.from(dirSet).map((d) => `[dry-run] Would create directory: ${posixJoin(deployTo, d)}`);
        steps.push({
            step: "dirs",
            status: "planned",
            message: `${dirSet.size} directory path(s) planned`,
            details,
        });
    }

    // 3. Shared
    if (shouldRun("shared") && (provCfg.seedShared !== false)) {
        const shared = (env.shared ?? provCfg.shared ?? []) as string[];
        shared.forEach(assertValidSharedItem);
        const sharedDir = posixJoin(deployTo, "shared");
        const details = shared.map((item) => {
            const cleanItem = item.endsWith("/*") ? item.slice(0, -1) : item;
            const fullPath = posixJoin(sharedDir, cleanItem);
            return cleanItem.endsWith("/")
                ? `[dry-run] Would create shared directory: ${fullPath}`
                : `[dry-run] Would ensure shared file: ${fullPath}`;
        });
        steps.push({
            step: "shared",
            status: "planned",
            message: `${shared.length} shared item(s) planned`,
            details,
        });
    }

    // 4. Permissions
    if (shouldRun("permissions") && (provCfg.configurePermissions !== false)) {
        const p = provCfg.permissions;
        const details: string[] = [];
        if (p?.mode) details.push(`[dry-run] Would set directory mode ${p.mode} on ${deployTo}`);
        if (p?.sharedMode) details.push(`[dry-run] Would set recursive mode ${p.sharedMode} on ${posixJoin(deployTo, "shared")}`);
        if (p?.owner || p?.group) {
            const ownership = [p.owner, p.group].filter(Boolean).join(":");
            details.push(`[dry-run] Would change ownership to ${ownership} on ${deployTo}`);
        }
        steps.push({
            step: "permissions",
            status: "planned",
            message: "Permissions configuration planned",
            details,
        });
    }

    // 5. Service
    const services = normalizeServices(provCfg.service, provCfg.services);
    if (shouldRun("service") && services.length > 0) {
        const details = services.map((s) => `[dry-run] Would verify ${s.type ?? "systemd"} service '${s.name}'`);
        steps.push({
            step: "service",
            status: "planned",
            message: `${services.length} service(s) planned for verification`,
            details,
        });
    }

    return {
        environment: options.env ?? "production",
        host: env.host,
        deployTo,
        dryRun: true,
        success: true,
        steps,
    };
}
