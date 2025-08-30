#!/usr/bin/env node
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {log} from "../core/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/src/commands → go back 3 levels → project root → templates
const templatesDir = path.resolve(__dirname, "../../../templates");

export async function init(opts: { template?: string }) {
    const template = opts.template || "node"; // default to node
    const src = path.join(templatesDir, `${template}.json`);
    const dest = path.resolve(process.cwd(), "dploy.config.json");

    // Debug (optional)
    // console.log("Templates directory:", templatesDir);
    // console.log("Looking for template:", src);

    if (!(await fs.pathExists(src))) {
        log.err(`Template '${template}' not found @ ${src}`);
        process.exit(1);
    }

    if (await fs.pathExists(dest)) {
        log.err(`dploy.config.json already exists in this project`);
        process.exit(1);
    }

    // Copy config
    await fs.copy(src, dest);
    log.ok(`Created dploy.config.json from '${template}' template`);

    // Also export .env.dploy.example if available
    const envSrc = path.join(templatesDir, ".env.dploy.example");
    const envDest = path.resolve(process.cwd(), ".env.dploy.example");

    if (await fs.pathExists(envSrc)) {
        if (!(await fs.pathExists(envDest))) {
            await fs.copy(envSrc, envDest);
            log.ok(`Created .env.dploy.example`);
        } else {
            log.warn(`.env.dploy.example already exists, skipped`);
        }
    }
}
