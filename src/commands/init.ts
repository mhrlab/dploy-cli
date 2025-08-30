import fs from "fs-extra";
import path from "node:path";
import {log} from "../core/logger.js";

export async function init(opts: { template?: string }) {
    const template = opts.template || "node"; // default
    const templatesDir = path.resolve(new URL("../../templates", import.meta.url).pathname);
    const src = path.join(templatesDir, `${template}.json`);
    const dest = path.resolve(process.cwd(), "dploy.config.json");

    if (!(await fs.pathExists(src))) {
        log.err(`Template '${template}' not found`);
        process.exit(1);
    }

    if (await fs.pathExists(dest)) {
        log.err(`dploy.config.json already exists in this project`);
        process.exit(1);
    }

    await fs.copy(src, dest);
    log.ok(`Created dploy.config.json from '${template}' template`);
}
