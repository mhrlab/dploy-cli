import fg from "fast-glob";
import fs from "fs-extra";
import path from "node:path";
import { DployConfig } from "./config.js";
import { log } from "./logger.js";

export async function resolveFiles(cwd: string, cfg: DployConfig): Promise<{ from: string; to: string }[]> {
    const strategy = cfg.strategy ?? "copy";
    log.debug(`Resolving files using strategy: ${strategy}`);
    log.debug(`Strategy config - copy: ${cfg.copy?.length || 0}, include: ${cfg.include?.length || 0}, exclude: ${cfg.exclude?.length || 0}`);

    const results: { from: string; to: string }[] = [];

    if (strategy === "copy" || strategy === "hybrid") {
        log.verbose(`Processing copy strategy entries`);
        if (cfg.copy?.length) {
            log.info(`Processing ${cfg.copy.length} copy entries...`);
        }
        for (const entry of cfg.copy ?? []) {
            const fromAbs = path.join(cwd, entry.from);
            log.debug(`Checking copy entry: ${entry.from} -> ${entry.to} (optional: ${entry.optional})`);

            const exists = await fs.pathExists(fromAbs);
            if (!exists && entry.optional) {
                log.debug(`Skipping optional missing path: ${entry.from}`);
                continue;
            }
            if (!exists) {
                log.debug(`Missing required path: ${entry.from}`);
                throw new Error(`Missing path: ${entry.from}`);
            }
            log.debug(`Adding copy entry: ${fromAbs} -> ${entry.to}`);
            results.push({ from: fromAbs, to: entry.to });
        }
    }

    if (strategy === "include" || strategy === "hybrid") {
        log.verbose(`Processing include strategy`);
        const include = cfg.include ?? [];
        const exclude = cfg.exclude ?? [];

        log.verbose(`Include patterns: ${JSON.stringify(include)}`);
        log.verbose(`Exclude patterns: ${JSON.stringify(exclude)}`);

        if (include.length) {
            log.debug(`Globbing files with include patterns`);
            log.info(`Finding files matching include patterns...`);
            const files = await fg(include, { cwd, dot: true, ignore: exclude });
            log.verbose(`Found ${files.length} files matching include patterns`);

            for (const f of files) {
                log.debug(`Adding include file: ${f}`);
                results.push({ from: path.join(cwd, f), to: f });
            }
        }
    }

    if (strategy === "exclude") {
        log.verbose(`Processing exclude strategy`);
        const exclude = cfg.exclude ?? [];
        log.debug(`Exclude patterns: ${JSON.stringify(exclude)}`);

        log.debug(`Globbing all files except exclude patterns`);
        log.info(`Finding all files (excluding patterns)...`);
        const files = await fg(["**/*"], { cwd, dot: true, ignore: exclude });
        log.verbose(`Found ${files.length} files after excluding patterns`);

        for (const f of files) {
            log.debug(`Adding exclude file: ${f}`);
            results.push({ from: path.join(cwd, f), to: f });
        }
    }

    log.verbose(`File resolution completed. Total files: ${results.length}`);
    return results;
}