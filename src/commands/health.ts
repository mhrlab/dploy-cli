import { loadConfig, getEnvName } from "../core/config.js";
import { log } from "../core/logger.js";

export async function health(opts: { env?: string }) {
    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    const env = cfg.environments[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);

    const base = env.baseUrl || process.env.DPLOY_BASE_URL;
    const path = env.healthCheckPath || "/health";
    if (!base) throw new Error("Missing baseUrl");

    const url = new URL(path, base).toString();
    log.info(`GET ${url}`);
    try {
        const res = await fetch(url);
        const text = await res.text();
        if (res.ok) {
            log.ok(`Health OK (${res.status})`);
            console.log(text);
        } else {
            log.warn(`Health not OK (${res.status})`);
            console.log(text);
            process.exitCode = 1;
        }
    } catch (e: any) {
        log.err(e.message || String(e));
        process.exit(1);
    }
}
