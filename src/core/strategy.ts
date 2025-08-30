import fg from "fast-glob";
import fs from "fs-extra";
import path from "node:path";
import { DployConfig } from "./config.js";
import { log } from "./logger.js";

export async function resolveFiles(cwd: string, cfg: DployConfig): Promise<{ from: string; to: string }[]> {
    const strategy = cfg.strategy ?? "copy";
    const results: { from: string; to: string }[] = [];

    if (strategy === "copy" || strategy === "hybrid") {
        if (cfg.copy?.length) {
            log.info(`Processing ${cfg.copy.length} copy entries...`);
        }
        for (const entry of cfg.copy ?? []) {
            const fromAbs = path.join(cwd, entry.from);
            const exists = await fs.pathExists(fromAbs);
            results.push({ from: fromAbs, to: entry.to });
        }
    }

    if (strategy === "include" || strategy === "hybrid") {
        const include = cfg.include ?? [];
        const exclude = cfg.exclude ?? [];

        if (include.length) {
            log.info(`Finding files matching include patterns...`);
            const files = await fg(include, { cwd, dot: true, ignore: exclude });
            for (const f of files) {
                results.push({ from: path.join(cwd, f), to: f });
            }
        }
    }

    if (strategy === "exclude") {
        const exclude = cfg.exclude ?? [];
        log.info(`Finding all files (excluding patterns)...`);
        const files = await fg(["**/*"], { cwd, dot: true, ignore: exclude });
        for (const f of files) {
            results.push({ from: path.join(cwd, f), to: f });
        }
    }

    return results;
}