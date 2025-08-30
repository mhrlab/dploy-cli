import fs from "fs-extra";
import path from "node:path";
import * as dotenv from "dotenv";
import { expandTilde } from "./utils.js";


export type CopyEntry = { from: string; to: string; optional?: boolean };


export type EnvConfig = {
    description?: string;
    deployTo: string; // e.g., /var/www/myapp
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    privateKeyPath?: string; // path to private key
    keepVersions?: number; // default 5
    healthCheckPath?: string; // e.g., /health
    baseUrl?: string; // e.g., https://example.com
};

export type Strategy = "include" | "exclude" | "copy" | "hybrid";


export type DployConfig = {
    buildDir: string;
    cleanAfterDeploy?: boolean;
    strategy?: Strategy;
    include?: string[];
    exclude?: string[];
    copy?: CopyEntry[];
    shared?: string[];
    sharedDefaults?: Record<string, string>;
    hooks?: Partial<Record<"preBuild" | "postBuild" | "preDeploy" | "postDeploy", string[]>>; // NEW
    environments: Record<string, EnvConfig>;
};


export async function loadConfig(cwd = process.cwd()): Promise<DployConfig> {
    const configPath = path.join(cwd, "dploy.config.json");
    if (!(await fs.pathExists(configPath))) {
        throw new Error(`Missing dploy.config.json at ${configPath}`);
    }
    const raw = await fs.readJSON(configPath);


// .env.deploy (optional)
    const envPath = path.join(cwd, ".env.dploy");
    dotenv.config({ path: envPath, override: true });

    const defaults: Partial<DployConfig> = {
        buildDir: "build",
        cleanAfterDeploy: true,
        copy: [],
        include: [],
        exclude: [],
        shared: [],
        sharedDefaults: {},
        hooks: {},
        environments: {},
    };

    const cfg: DployConfig = { ...defaults, ...raw };



// Inject env vars defaults per environment
    for (const [name, env] of Object.entries(cfg.environments)) {
        env.port = env.port ?? Number(resolveEnvVar(name, "PORT") ?? 22);
        env.host = env.host ?? resolveEnvVar(name, "HOST");
        env.username = env.username ?? resolveEnvVar(name, "USER");
        env.password = env.password ?? resolveEnvVar(name, "PASSWORD");
        env.privateKeyPath = expandTilde(
            env.privateKeyPath ?? resolveEnvVar(name, "PRIVATE_KEY")
        );
        env.baseUrl = env.baseUrl ?? resolveEnvVar(name, "BASE_URL");
        env.keepVersions = env.keepVersions ?? 5;
    }


    return cfg;
}


export function getEnvName(cliEnv?: string): string {
    return cliEnv ?? process.env.DPLOY_ENV ?? "production";
}

function resolveEnvVar(env: string, key: string): string | undefined {
    const upperEnv = env.toUpperCase();
    const upperKey = key.toUpperCase();

    // 1. Try environment-specific variable
    const scoped = process.env[`DPLOY_${upperEnv}_${upperKey}`];
    if (scoped) return scoped;

    // 2. Fallback: global variable
    const global = process.env[`DPLOY_${upperKey}`];
    if (global) return global;

    return undefined;
}

