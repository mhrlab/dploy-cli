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
    environments: Record<string, EnvConfig>;
};


export async function loadConfig(cwd = process.cwd()): Promise<DployConfig> {
    const configPath = path.join(cwd, "dploy.config.json");
    if (!(await fs.pathExists(configPath))) {
        throw new Error(`Missing dploy.config.json at ${configPath}`);
    }
    const raw = await fs.readJSON(configPath);


// .env.deploy (optional)
    const envPath = path.join(cwd, ".env.deploy");
    dotenv.config({ path: envPath, override: true });


    const cfg: DployConfig = {
        buildDir: raw.buildDir ?? "build",
        cleanAfterDeploy: raw.cleanAfterDeploy ?? true,
        copy: raw.copy ?? [],
        environments: raw.environments ?? {},
    };


// Inject env vars defaults per environment
    for (const [name, env] of Object.entries(cfg.environments)) {
        env.port = env.port ?? (process.env.DPLOY_PORT ? Number(process.env.DPLOY_PORT) : 22);
        env.host = env.host ?? process.env.DPLOY_HOST;
        env.username = env.username ?? process.env.DPLOY_USER;
        env.password = env.password ?? process.env.DPLOY_PASSWORD;
        env.privateKeyPath = expandTilde(env.privateKeyPath ?? process.env.DPLOY_PRIVATE_KEY);
        env.baseUrl = env.baseUrl ?? process.env.DPLOY_BASE_URL;
        env.keepVersions = env.keepVersions ?? 5;
    }


    return cfg;
}


export function getEnvName(cliEnv?: string): string {
    return cliEnv ?? process.env.DPLOY_ENV ?? "production";
}
