import { loadConfig, getEnvName } from "../core/config.js";
import { log } from "../core/logger.js";

export async function performHealthCheck(url: string, timeoutMs: number = 10000): Promise<{ ok: boolean; status: number; text: string }> {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
}

export async function health(opts: { env?: string }) {
    log.debug(`Health command started with options: ${JSON.stringify(opts)}`);

    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    log.verbose(`Using environment: ${envName}`);

    const env = cfg.environments?.[envName];
    if (!env) throw new Error(`Unknown environment: ${envName}`);

    const base = env.baseUrl || process.env.DPLOY_BASE_URL;
    const path = env.healthCheckPath || "/health";
    log.debug(`Health check config - baseUrl: ${base}, path: ${path}`);

    if (!base) {
        log.debug(`No baseUrl found in config or environment`);
        throw new Error("Missing baseUrl");
    }

    const url = new URL(path, base).toString();
    const timeoutMs = Number(env.healthCheckTimeout ?? process.env.DPLOY_HEALTH_CHECK_TIMEOUT ?? 10000);
    log.info(`Performing health check: GET ${url} (timeout: ${timeoutMs}ms)`);

    try {
        log.verbose(`Sending HTTP request to health endpoint`);
        const { ok, status, text } = await performHealthCheck(url, timeoutMs);
        log.debug(`Health check response - status: ${status}, content length: ${text.length}`);

        if (ok) {
            log.ok(`Health check passed (${status})`);
            if (text.trim()) {
                console.log(text);
            }
        } else {
            log.warn(`Health check failed (${status})`);
            if (text.trim()) {
                console.log(text);
            }
            process.exitCode = 1;
        }
    } catch (e: any) {
        log.err(`Health check failed: ${e.message || String(e)}`);
        process.exit(1);
    }
}
