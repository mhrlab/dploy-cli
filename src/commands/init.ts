#!/usr/bin/env node
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../core/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/src/commands → go back 3 levels → project root → templates
const templatesDir = path.resolve(__dirname, "../../../templates");

export async function init(opts: { template?: string }) {
    log.debug(`Init started with template: ${opts.template || "node"}`);

    const template = opts.template || "node"; // default to node
    const src = path.join(templatesDir, `${template}.json`);
    const dest = path.resolve(process.cwd(), "dploy.config.json");
    log.debug(`Template source: ${src}, Destination: ${dest}`);

    log.verbose(`Checking if template exists`);
    if (!(await fs.pathExists(src))) {
        log.verbose(`Template file not found: ${src}`);
        log.err(`Template file for '${template}' template not found.`);
        process.exit(1);
    }

    log.verbose(`Checking if config file already exists`);
    if (await fs.pathExists(dest)) {
        log.debug(`Config file already exists: ${dest}`);
        log.err(`dploy.config.json already exists in this project`);
        process.exit(1);
    }

    // Copy config
    log.info(`Creating dploy.config.json from '${template}' template`);
    await fs.copy(src, dest);
    log.ok(`Created dploy.config.json from '${template}' template`);

    // Also export .env.dploy.example if available
    const envSrc = path.join(templatesDir, ".env.dploy.example");
    const envDest = path.resolve(process.cwd(), ".env.dploy.example");
    log.debug(`Environment example source: ${envSrc}, Destination: ${envDest}`);

    log.verbose(`Checking if environment example template exists`);
    if (await fs.pathExists(envSrc)) {
        if (!(await fs.pathExists(envDest))) {
            log.info(`Creating .env.dploy.example`);
            await fs.copy(envSrc, envDest);
            log.ok(`Created .env.dploy.example`);
        } else {
            log.warn(`.env.dploy.example already exists, skipped`);
        }
    } else {
        log.verbose(`No .env.dploy.example template found`);
    }
}
