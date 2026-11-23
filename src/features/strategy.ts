import fg from "fast-glob";
import fs from "fs-extra";
import path from "node:path";
import { DeployConfig } from "../core/config.js";
import { log } from "../core/logger.js";

export async function loadDployIgnore(cwd: string): Promise<string[]> {
    const ignorePath = path.join(cwd, ".dployignore");
    if (await fs.pathExists(ignorePath)) {
        try {
            const content = await fs.readFile(ignorePath, "utf8");
            return content
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line && !line.startsWith("#"));
        } catch {}
    }
    return [];
}

export async function resolveFiles(cwd: string, cfg: DeployConfig): Promise<{ from: string; to: string }[]> {
    const strategy = cfg.build?.strategy ?? cfg.strategy ?? "copy";
    const copyEntries = cfg.build?.copy ?? cfg.copy ?? [];
    const include = cfg.build?.include ?? cfg.include ?? [];
    const configExclude = cfg.build?.exclude ?? cfg.exclude ?? [];
    const dployIgnore = await loadDployIgnore(cwd);
    const exclude = Array.from(new Set([...configExclude, ...dployIgnore]));

    log.debug(`Resolving files using strategy: ${strategy}`);
    log.debug(`Strategy config - copy: ${copyEntries.length}, include: ${include.length}, exclude: ${exclude.length}`);

    const results: { from: string; to: string }[] = [];

    if (strategy === "copy" || strategy === "hybrid") {
        log.verbose(`Processing copy strategy entries`);
        if (copyEntries.length) {
            log.verbose(`Processing ${copyEntries.length} copy entries...`);
        }
        for (const entry of copyEntries) {
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
        log.verbose(`Include patterns: ${JSON.stringify(include)}`);
        log.verbose(`Exclude patterns: ${JSON.stringify(exclude)}`);

        if (include.length) {
            log.debug(`Globbing files with include patterns`);
            log.verbose(`Finding files matching include patterns...`);
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
        log.debug(`Exclude patterns: ${JSON.stringify(exclude)}`);

        log.debug(`Globbing all files except exclude patterns`);
        log.verbose(`Finding all files (excluding patterns)...`);
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
