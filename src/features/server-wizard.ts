import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageRoot } from "../core/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type AppKind = "spa" | "node" | "php";

export interface NginxConfigParams {
    kind: AppKind;
    domains: string[];
    rootDir?: string;
    port?: number;
    phpSocket?: string;
}

export interface SystemdConfigParams {
    appName: string;
    user: string;
    workingDir: string;
    execStart: string;
}

export function getServicesTemplatesDir(): string {
    const root = findPackageRoot(__dirname);
    return path.join(root, "templates", "services");
}

export async function generateNginxConfig(params: NginxConfigParams): Promise<string> {
    const templatesDir = getServicesTemplatesDir();
    let templateName: string;

    switch (params.kind) {
        case "spa":
            templateName = "nginx-spa.conf";
            break;
        case "node":
            templateName = "nginx-proxy.conf";
            break;
        case "php":
            templateName = "nginx-php.conf";
            break;
        default:
            throw new Error(`Unsupported app kind: ${params.kind}`);
    }

    const templatePath = path.join(templatesDir, templateName);
    let content = await fs.readFile(templatePath, "utf8");

    const domainsStr = params.domains.join(" ");
    content = content.replace(/\{\{DOMAINS\}\}/g, domainsStr);

    if (params.rootDir) {
        content = content.replace(/\{\{ROOT_DIR\}\}/g, params.rootDir);
    }
    if (params.port) {
        content = content.replace(/\{\{PORT\}\}/g, String(params.port));
    }
    if (params.phpSocket) {
        content = content.replace(/\{\{PHP_SOCKET\}\}/g, params.phpSocket);
    }

    return content;
}

export async function generateSystemdUnit(params: SystemdConfigParams): Promise<string> {
    const templatesDir = getServicesTemplatesDir();
    const templatePath = path.join(templatesDir, "systemd.service");
    let content = await fs.readFile(templatePath, "utf8");

    content = content.replace(/\{\{APP_NAME\}\}/g, params.appName);
    content = content.replace(/\{\{USER\}\}/g, params.user);
    content = content.replace(/\{\{WORKING_DIR\}\}/g, params.workingDir);
    content = content.replace(/\{\{EXEC_START\}\}/g, params.execStart);

    return content;
}
