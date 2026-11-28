import fs from "fs-extra";
import path from "node:path";
import { loadConfig, loadDotenv, getEnvName, configFiles } from "../core/config.js";
import { resolveFiles } from "../features/strategy.js";
import { connect, close, exec } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { escapeShellArg } from "../core/utils.js";

export interface DoctorCheckResult {
    name: string;
    status: "ok" | "warn" | "fail";
    message: string;
}

export interface DoctorOptions {
    env?: string;
    ssh?: boolean;
    json?: boolean;
}

/**
 * Find unresolved ${VAR} references (without :-fallback) in raw config text when VAR is unset/empty.
 */
export function findUnresolvedEnvVars(rawContent: string, envMap: NodeJS.ProcessEnv = process.env): string[] {
    const missing = new Set<string>();
    const regex = /\$\{([^:}]+)(?::-(.*?)?)?\}/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(rawContent)) !== null) {
        const varName = match[1].trim();
        const hasFallback = match[2] !== undefined;
        const val = envMap[varName];
        if (!hasFallback && (val === undefined || val === "")) {
            missing.add(varName);
        }
    }
    return Array.from(missing);
}

export async function doctor(opts: DoctorOptions = {}): Promise<{ ok: boolean; checks: DoctorCheckResult[] }> {
    const cwd = process.cwd();
    const checks: DoctorCheckResult[] = [];
    loadDotenv(cwd);

    // 1. Config file discovery
    const candidates = [configFiles.config_yml, configFiles.config_yaml, configFiles.config_json];
    let configPath: string | null = null;
    for (const c of candidates) {
        const p = path.join(cwd, c);
        if (await fs.pathExists(p)) {
            configPath = p;
            break;
        }
    }

    if (!configPath) {
        checks.push({
            name: "config-file",
            status: "fail",
            message: "No deploy.config.yml|yaml|json found in current directory. Run 'dploy init' to create one.",
        });
        return renderDoctorReport(checks, opts);
    }

    checks.push({
        name: "config-file",
        status: "ok",
        message: `Found configuration file: ${path.basename(configPath)}`,
    });

    // 2. Unresolved ${VAR} check
    const rawContent = await fs.readFile(configPath, "utf8");
    const unresolved = findUnresolvedEnvVars(rawContent, process.env);
    if (unresolved.length > 0) {
        checks.push({
            name: "env-vars",
            status: "warn",
            message: `Unset environment variables without fallback: ${unresolved.join(", ")} (check .env / .env.dploy)`,
        });
    } else {
        checks.push({
            name: "env-vars",
            status: "ok",
            message: "All required ${VAR} placeholders resolved",
        });
    }

    // 3. Parse + Interpolate + Schema Validation (via loadConfig)
    let cfg: any;
    try {
        cfg = await loadConfig(cwd);
        checks.push({
            name: "schema",
            status: "ok",
            message: "Configuration syntax and schema are valid",
        });
    } catch (err: any) {
        checks.push({
            name: "schema",
            status: "fail",
            message: err?.message || String(err),
        });
        return renderDoctorReport(checks, opts);
    }

    // 4. Target Environment + SSH Key check
    const envName = getEnvName(opts.env);
    const env = cfg.environments?.[envName];
    if (!env) {
        checks.push({
            name: "environment",
            status: "fail",
            message: `Environment '${envName}' not found in config`,
        });
        return renderDoctorReport(checks, opts);
    }

    const targetHost = env.host || env.hosts?.[0];
    if (!targetHost || !env.username || !env.deployTo) {
        checks.push({
            name: "environment",
            status: "fail",
            message: `Environment '${envName}' is missing host, username, or deployTo`,
        });
    } else {
        checks.push({
            name: "environment",
            status: "ok",
            message: `Environment '${envName}' targets ${env.username}@${targetHost} -> ${env.deployTo}`,
        });
    }

    if (env.ssh_key_path && !env.ssh_key) {
        if (await fs.pathExists(env.ssh_key_path)) {
            checks.push({
                name: "ssh-key",
                status: "ok",
                message: `SSH private key found at ${env.ssh_key_path}`,
            });
        } else if (!env.password) {
            checks.push({
                name: "ssh-key",
                status: "warn",
                message: `SSH key not found at ${env.ssh_key_path} and no password configured`,
            });
        }
    }

    // 5. Build strategy file match check
    if (cfg.build) {
        try {
            const files = await resolveFiles(cwd, cfg.build);
            if (files.length === 0) {
                checks.push({
                    name: "build-files",
                    status: "warn",
                    message: `Build strategy '${cfg.build.strategy || "copy"}' matched 0 files`,
                });
            } else {
                checks.push({
                    name: "build-files",
                    status: "ok",
                    message: `Build strategy '${cfg.build.strategy || "copy"}' matched ${files.length} file(s)`,
                });
            }
        } catch (err: any) {
            checks.push({
                name: "build-files",
                status: "fail",
                message: `Build file resolution failed: ${err?.message || String(err)}`,
            });
        }
    }

    // 6. Optional live SSH check
    if (opts.ssh && targetHost && env.username) {
        const spin = opts.json ? null : log.spinner(`Testing SSH connection to ${env.username}@${targetHost}...`);
        try {
            const bundle = await connect({ ...env, host: targetHost });
            try {
                const res = await exec(bundle.ssh, `test -d ${escapeShellArg(env.deployTo)} && echo exists || echo missing`);
                const dirState = res.stdout.trim();
                if (spin) spin.succeed(`SSH connected (${env.deployTo}: ${dirState})`);
                checks.push({
                    name: "ssh-connectivity",
                    status: "ok",
                    message: `SSH login succeeded; ${env.deployTo} is ${dirState}`,
                });
            } finally {
                await close(bundle);
            }
        } catch (err: any) {
            if (spin) spin.fail("SSH connection failed");
            checks.push({
                name: "ssh-connectivity",
                status: "fail",
                message: `SSH connection failed: ${err?.message || String(err)}`,
            });
        }
    }

    return renderDoctorReport(checks, opts);
}

function renderDoctorReport(
    checks: DoctorCheckResult[],
    opts: DoctorOptions
): { ok: boolean; checks: DoctorCheckResult[] } {
    const ok = !checks.some((c) => c.status === "fail");

    if (opts.json) {
        console.log(JSON.stringify({ ok, checks }, null, 2));
    } else {
        for (const c of checks) {
            if (c.status === "ok") log.ok(`[${c.name}] ${c.message}`);
            else if (c.status === "warn") log.warn(`[${c.name}] ${c.message}`);
            else log.err(`[${c.name}] ${c.message}`);
        }
        if (ok) log.ok("Doctor check passed!");
        else {
            log.err("Doctor found configuration issues.");
            process.exitCode = 1;
        }
    }

    return { ok, checks };
}
