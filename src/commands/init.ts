import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../core/logger.js";
import { configFiles } from "../core/config.js";
import { updateGitignore } from "../core/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/src/commands → go back 3 levels → project root → templates
const templatesDir = path.resolve(__dirname, "../../../templates");

export async function init(opts: { template?: string }) {
    log.debug(`Init started with template: ${opts.template || "node"}`);

    const template = opts.template || "node"; // default to node
    const src = path.join(templatesDir, `${template}.json`);
    const dest = path.resolve(process.cwd(), configFiles.config_json);
    log.debug(`Template source: ${src}, Destination: ${dest}`);

    log.verbose(`Checking if template exists`);
    if (!(await fs.pathExists(src))) {
        log.verbose(`Template file not found: ${src}`);
        log.err(`Template file for '${template}' template not found.`);
        process.exit(1);
    }

    let setup_success: boolean = false;

    log.verbose(`Checking if config file already exists`);
    if (!(await fs.pathExists(dest))) {
        // Copy config
        try {
            log.info(`Creating ${configFiles.config_json} from '${template}' template`);
            await fs.copy(src, dest);
            log.ok(`Created ${configFiles.config_json} from '${template}' template`);
            setup_success = true;
        } catch (e) {
            log.err(`Error creating ${configFiles.config_json} from '${template}' template`);
        }
    } else {
        log.debug(`Config file already exists: ${dest}`);
        log.warn(`${configFiles.config_json} already exists, skipped`);
    }


    // Also export .env.dploy.example if available
    const envSrc = path.join(templatesDir,configFiles.env_example);
    const envDest = path.resolve(process.cwd(), configFiles.env_example);
    log.debug(`Environment example source: ${envSrc}, Destination: ${envDest}`);

    log.verbose(`Checking if environment example template exists`);
    if (await fs.pathExists(envSrc)) {
        if (!(await fs.pathExists(envDest))) {
            log.info(`Creating ${configFiles.env_example}`);
            await fs.copy(envSrc, envDest);
            log.ok(`Created ${configFiles.env_example}`);
            setup_success = true;
        } else {
            log.warn(`${configFiles.env_example} already exists, skipped`);
        }
    } else {
        log.verbose(`No ${configFiles.env_example} template found`);
    }

    if (setup_success) {
        log.info("Updating .gitignore to exclude sensitive deployment files from version control...");
        await updateGitignore();
        log.ok(".gitignore successfully updated.");
    }

}
