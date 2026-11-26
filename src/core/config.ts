import fs from "fs-extra";
import path from "node:path";
import * as dotenv from "dotenv";
import yaml from "js-yaml";
import { log } from "./logger.js";
import { expandTilde } from "./utils.js";
import { assertValidDeployConfig } from "./config-validator.js";
import { NotificationTarget } from "../features/notifications.js";


type AnyObject = Record<string, any>;

export interface HookConfig {
    preBuild?: string[];
    postBuild?: string[];
    preDeploy?: string[];
    postDeploy?: string[];
    [key: string]: any;
}

export interface BuildConfig {
    strategy?: Strategy;
    cleanAfterDeploy?: boolean;
    buildDir?: string;
    exclude?: string[];
    include?: string[];
    copy?: CopyEntry[];
    shared?: string[];
    sharedDefaults?: Record<string, string>;
    [key: string]: any;
}

export interface ProvisionPermissionsConfig {
    owner?: string;
    group?: string;
    mode?: string;
    sharedMode?: string;
}

export interface ProvisionServiceConfig {
    type?: "systemd" | "pm2";
    name?: string;
    action?: "check" | "restart" | "reload" | "enable";
    [key: string]: any;
}

export interface ProvisionConfig {
    enabled?: boolean;
    createDirs?: boolean;
    configurePermissions?: boolean;
    seedShared?: boolean;
    checkPrerequisites?: boolean;
    dirs?: string[];
    permissions?: ProvisionPermissionsConfig;
    runtime?: Record<string, string>;
    service?: ProvisionServiceConfig;
    services?: (ProvisionServiceConfig | string)[];
    [key: string]: any;
}

export interface DatabaseBackupConfig {
    enabled?: boolean;
    type?: "mysql" | "postgres" | "sqlite";
    name?: string;
    user?: string;
    password?: string;
    host?: string;
    port?: number;
    path?: string;
    keep?: number;
    extraArgs?: string[];
    admin_user?: string;
    admin_password?: string;
    root_user?: string;
    root_password?: string;
    charset?: string;
    collation?: string;
}

export interface DeployConfig {
    name?: string;
    domain?: string;
    domains?: string[];
    versionCommand?: string;
    versionFile?: string;
    build?: BuildConfig;
    hooks?: HookConfig;
    provision?: ProvisionConfig;
    database?: DatabaseBackupConfig;
    maintenanceMode?: boolean;
    notifications?: NotificationTarget[];
    environments?: Record<string, EnvironmentConfig>;
    keepArtifact?: boolean;
    cleanAfterDeploy?: boolean;
    shared?: string[];
    sharedDefaults?: Record<string, string>;
    [key: string]: any;
}

export interface AdminConfig {
    username?: string;
    host?: string;
    port?: number;
    password?: string;
    passphrase?: string;
    ssh_key?: string;
    ssh_key_path?: string;
    sudo?: boolean;
}

export interface EnvironmentConfig {
    extends?: string;
    username?: string;
    admin?: AdminConfig;
    host?: string;
    hosts?: string[];
    strategy?: "parallel" | "rolling";
    port?: number;
    password?: string;
    passphrase?: string;
    ssh_key?: string;
    ssh_key_path?: string;
    domain?: string;
    domains?: string[];
    deployTo?: string;
    keepVersions?: number;
    baseUrl?: string;
    healthCheckPath?: string;
    healthCheckTimeout?: number;
    healthCheckRetries?: number;
    healthCheckInterval?: number;
    healthGate?: boolean;
    autoRollback?: boolean;
    retries?: number;
    keepArtifact?: boolean;
    env?: Record<string, string>;
    provision?: ProvisionConfig;
    database?: DatabaseBackupConfig;
    maintenanceMode?: boolean;
    notifications?: NotificationTarget[];
    [key: string]: any;
}

/**
 * Detect valid config file within a given directory.
 */
async function detectConfigFile(cwd: string): Promise<string | null> {
    const candidates = [
        "deploy.config.yml",
        "deploy.config.yaml",
        "deploy.config.json",
    ];
    for (const name of candidates) {
        const file = path.join(cwd, name);
        try {
            await fs.access(file);
            return file;
        } catch {

        }
    }
    return null;
}

/**
 * Load .env and .env.dploy into process.env (if they exist).
 * .env.dploy overrides .env for deployment-specific variables.
 */
export function loadDotenv(cwd: string) {
    const defaultEnv = path.join(cwd, ".env");
    const dployEnv = path.join(cwd, ".env.dploy");
    const deployEnv = path.join(cwd, ".env.deploy");

    try {
        if (fs.existsSync(defaultEnv)) {
            dotenv.config({ path: defaultEnv });
        }
        if (fs.existsSync(dployEnv)) {
            dotenv.config({ path: dployEnv, override: true });
        } else if (fs.existsSync(deployEnv)) {
            dotenv.config({ path: deployEnv, override: true });
        }
    } catch {
        // ignore if not exists
    }
}

function isDangerousKey(key: string): boolean {
    return key === "__proto__" || key === "constructor" || key === "prototype";
}

/**
 * Recursively substitute ${VAR} and ${VAR:-fallback}
 */
function substituteEnv(value: any): any {
    if (typeof value === "string") {
        return value.replace(/\$\{([^:}]+)(?::-(.*?)?)?}/g, (_, key, fallback) => {
            const envVal = process.env[key];
            if (envVal !== undefined && envVal !== "") return envVal;
            return fallback ?? "";
        });
    } else if (Array.isArray(value)) {
        return value.map(substituteEnv);
    } else if (value && typeof value === "object") {
        const result: AnyObject = {};
        for (const [k, v] of Object.entries(value)) {
            if (isDangerousKey(k)) continue;
            result[k] = substituteEnv(v);
        }
        return result;
    }
    return value;
}

/**
 * Simple deep merge (for inheritance)
 */
function deepMerge(base: AnyObject, override: AnyObject): AnyObject {
    const out: AnyObject = { ...base };
    for (const [key, val] of Object.entries(override)) {
        if (isDangerousKey(key)) continue;
        // Preserve inherited base values when override is undefined or an empty substituted string (e.g. unset ${VAR})
        if ((val === undefined || val === "") && base[key] !== undefined && base[key] !== "") {
            continue;
        }
        if (
            base[key] &&
            typeof base[key] === "object" &&
            typeof val === "object" &&
            !Array.isArray(base[key]) &&
            !Array.isArray(val)
        ) {
            out[key] = deepMerge(base[key], val);
        } else {
            out[key] = val;
        }
    }
    return out;
}


/**
 * Resolve environment inheritance chains
 */
function resolveInheritance(config: DeployConfig): DeployConfig {
    if (!config.environments) return config;

    const resolved: Record<string, EnvironmentConfig> = {};
    const envs = config.environments;

    function resolveEnv(name: string): EnvironmentConfig {
        if (resolved[name]) return resolved[name];
        const env = envs[name];
        if (!env) throw new Error(`Unknown environment: ${name}`);

        let merged = { ...env };
        if (env.extends) {
            const parent = resolveEnv(env.extends);
            merged = deepMerge(parent, env);
            merged.env = { ...(parent.env || {}), ...(env.env || {}) };
        }
        resolved[name] = merged;
        return merged;
    }

    for (const name of Object.keys(envs)) resolveEnv(name);
    return { ...config, environments: resolved };
}


/**
 * Parse YAML or JSON config
 */
async function parseConfig(file: string): Promise<DeployConfig> {
    const content = await fs.readFile(file, "utf8");
    if (file.endsWith(".json")) {
        return JSON.parse(content) as DeployConfig;
    }
    return (yaml.load(content) as DeployConfig) || {};
}


/**
 * Main loader
 */
export async function loadConfig(cwd: string =  process.cwd()): Promise<DeployConfig> {
    // 1. load .env for substitution
    loadDotenv(cwd);

    // 2. detect config file
    const file = await detectConfigFile(cwd);
    if (!file) {
        throw new Error(`No deploy.config.yml|yaml|json found in ${cwd}`);
    }

    // 3. parse config
    let config = await parseConfig(file);

    // 4. substitute env vars recursively
    config = substituteEnv(config);

    // 5. resolve environment inheritance
    config = resolveInheritance(config);

    // 6. normalize ssh paths and auto-load keys
    config = normalizeSSHConfig(config);

    return config;
}

/**
 * Normalize environment SSH fields (expand ~ and optionally read key file)
 */
function normalizeSSHConfig(config: DeployConfig): DeployConfig {
    if (!config.environments) return config;

    for (const env of Object.values(config.environments)) {
        if (!env) continue;

        // Auto-fallback host and username to DPLOY_HOST / DPLOY_USER if not set
        if (!env.host && (!env.hosts || env.hosts.length === 0) && process.env.DPLOY_HOST) {
            env.host = process.env.DPLOY_HOST;
        }
        if (!env.username && process.env.DPLOY_USER) {
            env.username = process.env.DPLOY_USER;
        }

        const envAny = env as any;
        if (envAny.port !== undefined && typeof envAny.port === "string" && /^\d+$/.test(envAny.port.trim())) {
            env.port = Number(envAny.port.trim());
        }

        if (envAny.keepVersions !== undefined && typeof envAny.keepVersions === "string" && /^\d+$/.test(envAny.keepVersions.trim())) {
            env.keepVersions = Number(envAny.keepVersions.trim());
        }

        if (env.ssh_key_path != null) {
            env.ssh_key_path = expandTilde(env.ssh_key_path);

            // 🌟 ADDED VALIDATION HERE 🌟
            if (typeof env.ssh_key_path !== 'string' || env.ssh_key_path.length === 0) {
                log.warn('SSH key path is invalid after expansion. Skipping key autofill.');
                continue; // Skip the rest of the loop for this environment
            }

            // Autofill ssh_key if not provided
            if (!env.ssh_key && fs.existsSync(env.ssh_key_path)) {
                try {
                    env.ssh_key = fs.readFileSync(env.ssh_key_path, "utf8").trim();
                } catch (err) {
                    log.warn(`Could not read SSH key from ${env.ssh_key_path}: ${(err as Error).message}`);
                }
            }
        }
    }

    assertValidDeployConfig(config);

    return config;
}

/**
 * Return the resolved environment config for a given envName.
 * It will throw if env not present.
 *
 * This returns a merged environment config (from extends) but does NOT
 * merge process.env automatically into the returned `.env` object.
 * If you'd like to overlay process.env over returned env: do:
 *   const finalEnv = { ...envCfg.env, ...process.env }
 */
export function getEnvironmentConfig(cfg: DeployConfig, envName: string): EnvironmentConfig {
    if (!cfg.environments) throw new Error("Config contains no environments");
    const env = cfg.environments[envName];
    if (!env) throw new Error(`Environment '${envName}' not found in config`);
    return env;
}

/**
 * Convenience: return the environment config merged with process.env
 * so you can directly use env variables with process env fallback.
 */
export function getMergedEnvValues(envCfg: EnvironmentConfig): Record<string, string> {
    // @ts-ignore
    return { ...(envCfg.env || {}), ...(process.env || {}) };
}

/**
 * Common config filenames
 */
export const configFiles = {
    config_yml: "deploy.config.yml",
    config_yaml: "deploy.config.yaml",
    config_json: "deploy.config.json",
    env: ".env",
    env_deploy: ".env.deploy",
    env_example: ".env.dploy.example",
    gitignore: [ ".env.dploy", "/build", "/builds" ],
};

export type CopyEntry = { from: string; to: string; optional?: boolean };
export type Strategy = "include" | "exclude" | "copy" | "hybrid";

export function getEnvName(cliEnv?: string): string {
    const envName = cliEnv ?? process.env.DPLOY_ENV ?? "production";
    log.debug(`Resolved environment name: ${envName} (cli: ${cliEnv}, env: ${process.env.DPLOY_ENV})`);
    return envName;
}
