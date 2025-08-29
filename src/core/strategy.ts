import fg from "fast-glob";
import fs from "fs-extra";
import path from "node:path";
import { DployConfig } from "./config.js";

export async function resolveFiles(cwd: string, cfg: DployConfig): Promise<{ from: string; to: string }[]> {
    const strategy = cfg.strategy ?? "copy";
    const results: { from: string; to: string }[] = [];

    if (strategy === "copy" || strategy === "hybrid") {
        for (const entry of cfg.copy ?? []) {
            const fromAbs = path.join(cwd, entry.from);
            const exists = await fs.pathExists(fromAbs);
            if (!exists && entry.optional) continue;
            if (!exists) throw new Error(`Missing path: ${entry.from}`);
            results.push({ from: fromAbs, to: entry.to });
        }
    }

    if (strategy === "include" || strategy === "hybrid") {
        const include = cfg.include ?? [];
        const exclude = cfg.exclude ?? [];

        if (include.length) {
            const files = await fg(include, { cwd, dot: true, ignore: exclude });
            for (const f of files) results.push({ from: path.join(cwd, f), to: f });
        }
    }

    if (strategy === "exclude") {
        const exclude = cfg.exclude ?? [];
        const files = await fg(["**/*"], { cwd, dot: true, ignore: exclude });
        for (const f of files) results.push({ from: path.join(cwd, f), to: f });
    }

    return results;
}