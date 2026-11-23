import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import inquirer from "inquirer";
import { log } from "../core/logger.js";
import { configFiles } from "../core/config.js";
import { updateGitignore, findPackageRoot } from "../core/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.resolve(findPackageRoot(__dirname), "templates");

export async function init(opts: { template?: string }) {
    log.debug(`Init started with template: ${opts.template || "interactive"}`);

    // 🔍 Step 1. Find all templates in templates directory
    const files = await fs.readdir(templatesDir);
    const available = files.filter(f => f.endsWith(".json") || f.endsWith(".yaml") || f.endsWith(".yml"));

    if (!available.length) {
        log.err("No templates found in templates directory.");
        process.exit(1);
    }

    // 🧭 Step 2. Determine chosen template
    let chosenFile: string | undefined;
    if (opts.template) {
        const match = available.find(f => path.basename(f, path.extname(f)) === opts.template);
        if (!match) {
            log.err(`Template '${opts.template}' not found. Available templates: ${available.join(", ")}`);
            process.exit(1);
        }
        chosenFile = match;
    } else {
        const answer = await inquirer.prompt([
            {
                type: "list",
                name: "template",
                message: "Select a template to initialize:",
                choices: available.map(f => path.basename(f)),
            },
        ]);
        chosenFile = available.find(f => f.startsWith(answer.template))!;
    }

    const src = path.join(templatesDir, chosenFile);
    const ext = path.extname(chosenFile);
    const dest =
        ext === ".json"
            ? path.resolve(process.cwd(), configFiles.config_json)
            : path.resolve(process.cwd(), configFiles.config_yaml);

    log.debug(`Template source: ${src}, Destination: ${dest}`);

    // 🧩 Step 3. Copy deploy config if not exists
    let setupSuccess = false;
    if (!(await fs.pathExists(dest))) {
        try {
            log.info(`Creating ${path.basename(dest)} from '${chosenFile}' template`);
            await fs.copy(src, dest);
            log.ok(`Created ${path.basename(dest)} from '${chosenFile}'`);
            setupSuccess = true;
        } catch (e) {
            log.err(`Error creating ${path.basename(dest)}: ${(e as Error).message}`);
        }
    } else {
        log.warn(`${path.basename(dest)} already exists, skipped.`);
    }

    // 🌱 Step 4. Copy environment example if present
    const envSrc = path.join(templatesDir, configFiles.env_example);
    const envDest = path.resolve(process.cwd(), configFiles.env_example);

    if (await fs.pathExists(envSrc)) {
        if (!(await fs.pathExists(envDest))) {
            log.info(`Creating ${configFiles.env_example}`);
            await fs.copy(envSrc, envDest);
            log.ok(`Created ${configFiles.env_example}`);
            setupSuccess = true;
        } else {
            log.warn(`${configFiles.env_example} already exists, skipped.`);
        }
    }

    // 🧹 Step 5. Update .gitignore if needed
    if (setupSuccess) {
        log.info("Updating .gitignore to exclude deployment files...");
        await updateGitignore();
        log.ok(".gitignore successfully updated.");
    }

    log.ok("Initialization complete!");
}
