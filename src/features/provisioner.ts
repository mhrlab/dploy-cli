import { Client } from "ssh2";
import { exec, type SSHBundle } from "../core/ssh.js";
import { posixJoin, escapeShellArg } from "../core/utils.js";
import { EnvironmentConfig, ProvisionConfig, ProvisionPermissionsConfig, ProvisionServiceConfig } from "../core/config.js";
import { log } from "../core/logger.js";

export type ProvisionStepName = "prereqs" | "dirs" | "shared" | "permissions" | "service";

export interface ProvisionOptions {
    env?: string;
    dryRun?: boolean;
    force?: boolean;
    skipChecks?: boolean;
    only?: ProvisionStepName | string;
    json?: boolean;
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

    for (const dir of dirs) {
        const fullPath = posixJoin(deployTo, dir);
        if (dryRun) {
            details.push(`[dry-run] Would create directory: ${fullPath}`);
        } else {
            await exec(ssh, `mkdir -p ${escapeShellArg(fullPath)}`);
            details.push(`Created directory: ${fullPath}`);
        }
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

    if (!sharedItems.length) {
        return {
            step: "shared",
            status: "skipped",
            message: "No shared resources configured",
        };
    }

    if (!dryRun) {
        await exec(ssh, `mkdir -p ${escapeShellArg(sharedDir)}`);
    }

    for (const item of sharedItems) {
        const sharedPath = posixJoin(sharedDir, item);

        if (item.endsWith("/")) {
            if (dryRun) {
                details.push(`[dry-run] Would create shared directory: ${sharedPath}`);
            } else {
                await exec(ssh, `mkdir -p ${escapeShellArg(sharedPath)}`);
                details.push(`Created shared directory: ${sharedPath}`);
            }
        } else {
            const parentDir = posixJoin(sharedDir, item.replace(/\/[^/]*$/, ""));

            if (dryRun) {
                details.push(`[dry-run] Would ensure shared file: ${sharedPath}`);
            } else {
                await exec(ssh, `mkdir -p ${escapeShellArg(parentDir)}`);
                const { stdout } = await exec(ssh, `[ -e ${escapeShellArg(sharedPath)} ] && echo 1 || echo 0`);
                const exists = stdout.trim() === "1";

                if (!exists || force) {
                    await exec(ssh, `touch ${escapeShellArg(sharedPath)}`);
                    details.push(`Created shared file: ${sharedPath}`);
                } else {
                    details.push(`Shared file already exists: ${sharedPath}`);
                }
            }
        }
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

    // 1. Directory mode
    if (permissions.mode) {
        if (dryRun) {
            details.push(`[dry-run] Would set directory mode ${permissions.mode} on ${deployTo}`);
        } else {
            await exec(ssh, `chmod ${escapeShellArg(permissions.mode)} ${escapeShellArg(deployTo)}`);
            details.push(`Set directory mode ${permissions.mode} on ${deployTo}`);
        }
    }

    // 2. Shared directory mode
    if (permissions.sharedMode) {
        const sharedDir = posixJoin(deployTo, "shared");
        if (dryRun) {
            details.push(`[dry-run] Would set recursive mode ${permissions.sharedMode} on ${sharedDir}`);
        } else {
            await exec(ssh, `chmod -R ${escapeShellArg(permissions.sharedMode)} ${escapeShellArg(sharedDir)} 2>/dev/null || true`);
            details.push(`Set recursive mode ${permissions.sharedMode} on ${sharedDir}`);
        }
    }

    // 3. Ownership
    if (permissions.owner || permissions.group) {
        const ownership = [permissions.owner, permissions.group].filter(Boolean).join(":");
        if (dryRun) {
            details.push(`[dry-run] Would change ownership to ${ownership} on ${deployTo}`);
        } else {
            await exec(ssh, `chown -R ${escapeShellArg(ownership)} ${escapeShellArg(deployTo)} 2>/dev/null || true`);
            details.push(`Set ownership to ${ownership} on ${deployTo}`);
        }
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
        if (type === "systemd") {
            const check = await exec(
                ssh,
                `systemctl is-active ${escapeShellArg(s.name!)} 2>&1 || true`
            );
            const state = check.stdout.trim();
            details.push(`Systemd service '${s.name}' state: ${state}`);
            if (state !== "active" && state !== "activating") {
                allActive = false;
            }
        } else if (type === "pm2") {
            const check = await exec(
                ssh,
                `pm2 describe ${escapeShellArg(s.name!)} >/dev/null 2>&1 && echo running || echo not_found`
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
    }

    // 3. Shared resource setup
    if (shouldRun("shared") && (provCfg.seedShared !== false)) {
        const shared = (env.shared ?? provCfg.shared ?? []) as string[];
        const defaults = env.sharedDefaults ?? provCfg.sharedDefaults ?? {};
        const res = await provisionSharedResources(bundle.ssh, deployTo, shared, defaults, dryRun, force);
        steps.push(res);
    }

    // 4. Permissions
    if (shouldRun("permissions") && (provCfg.configurePermissions !== false)) {
        const res = await provisionPermissions(bundle.ssh, deployTo, provCfg.permissions, dryRun);
        steps.push(res);
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

    if (shouldRun("prereqs")) {
        steps.push({
            step: "prereqs",
            status: "planned",
            message: "Prerequisites check planned",
            details: [
                "Would check for binary: tar",
                "Would check for binary: curl",
                ...(provCfg.runtime
                    ? Object.entries(provCfg.runtime).map(([k, v]) => `Would check for runtime: ${k}${v ? ` (>= ${v})` : ""}`)
                    : []),
            ],
        });
    }

    if (shouldRun("dirs") && (provCfg.createDirs !== false)) {
        const dirSet = new Set<string>([...DEFAULT_PROVISION_DIRS, ...(provCfg.dirs ?? [])]);
        steps.push({
            step: "dirs",
            status: "planned",
            message: `${dirSet.size} directory path(s) planned`,
            details: Array.from(dirSet).map((d: string) => `[dry-run] Would create directory: ${posixJoin(deployTo, d)}`),
        });
    }

    if (shouldRun("shared") && (provCfg.seedShared !== false)) {
        const shared: string[] = (env.shared ?? provCfg.shared ?? []) as string[];
        steps.push({
            step: "shared",
            status: "planned",
            message: `${shared.length} shared item(s) planned`,
            details: shared.map((s: string) => `[dry-run] Would initialize shared resource: ${posixJoin(deployTo, "shared", s)}`),
        });
    }

    if (shouldRun("permissions") && (provCfg.configurePermissions !== false) && provCfg.permissions) {
        const details: string[] = [];
        if (provCfg.permissions.mode) {
            details.push(`[dry-run] Would set directory mode ${provCfg.permissions.mode} on ${deployTo}`);
        }
        if (provCfg.permissions.sharedMode) {
            details.push(`[dry-run] Would set recursive mode ${provCfg.permissions.sharedMode} on ${posixJoin(deployTo, "shared")}`);
        }
        if (provCfg.permissions.owner || provCfg.permissions.group) {
            const ownership = [provCfg.permissions.owner, provCfg.permissions.group].filter(Boolean).join(":");
            details.push(`[dry-run] Would change ownership to ${ownership} on ${deployTo}`);
        }
        steps.push({
            step: "permissions",
            status: "planned",
            message: "Permissions configuration planned",
            details,
        });
    }

    const services = normalizeServices(provCfg.service, provCfg.services);
    if (shouldRun("service") && services.length > 0) {
        steps.push({
            step: "service",
            status: "planned",
            message: `${services.length} service check(s) planned`,
            details: services.map(
                (s) => `[dry-run] Would verify ${s.type ?? "systemd"} service: ${s.name}`
            ),
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
