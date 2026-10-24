import { log } from "./logger.js";

export interface RetryOptions {
    retries?: number;
    delayMs?: number;
    backoffFactor?: number;
    onRetry?: (error: any, attempt: number, nextDelayMs: number) => void;
}

/**
 * Execute an async operation with automatic retry and backoff on failure.
 */
export async function withRetry<T>(
    fn: (attempt: number) => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const retries = Math.max(1, options.retries ?? 3);
    let delay = Math.max(0, options.delayMs ?? 1000);
    const factor = options.backoffFactor ?? 1.5;

    let lastError: any;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn(attempt);
        } catch (err: any) {
            lastError = err;
            if (attempt >= retries) break;

            if (options.onRetry) {
                options.onRetry(err, attempt, delay);
            } else {
                log.warn(`Attempt ${attempt}/${retries} failed: ${err.message || String(err)}. Retrying in ${delay}ms...`);
            }

            if (delay > 0) {
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
            delay = Math.round(delay * factor);
        }
    }
    throw lastError;
}
