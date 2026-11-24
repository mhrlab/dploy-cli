import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageRoot } from "../core/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type AppKind = "spa" | "node" | "php";
export type SslMode = "none" | "certbot" | "cloudflare-flexible" | "cloudflare-origin";

export interface NginxConfigParams {
    kind: AppKind;
    domains: string[];
    rootDir?: string;
    port?: number;
    phpSocket?: string;
    ssl?: SslMode;
    cloudflareRealIp?: boolean;
    sslCertPath?: string;
    sslKeyPath?: string;
}

export interface SystemdConfigParams {
    appName: string;
    user: string;
    workingDir: string;
    execStart: string;
    isQueueWorker?: boolean;
}

export const CLOUDFLARE_REAL_IP_CONFIG = `    # Cloudflare Real IP Restoring
    set_real_ip_from 173.245.48.0/20;
    set_real_ip_from 103.21.244.0/22;
    set_real_ip_from 103.22.200.0/22;
    set_real_ip_from 103.31.4.0/22;
    set_real_ip_from 141.101.64.0/18;
    set_real_ip_from 108.162.192.0/18;
    set_real_ip_from 190.93.240.0/20;
    set_real_ip_from 188.114.96.0/20;
    set_real_ip_from 197.234.240.0/22;
    set_real_ip_from 198.41.128.0/17;
    set_real_ip_from 162.158.0.0/15;
    set_real_ip_from 104.16.0.0/13;
    set_real_ip_from 104.24.0.0/14;
    set_real_ip_from 172.64.0.0/13;
    set_real_ip_from 131.0.72.0/22;
    set_real_ip_from 2400:cb00::/32;
    set_real_ip_from 2606:4700::/32;
    set_real_ip_from 2803:f800::/32;
    set_real_ip_from 2405:b500::/32;
    set_real_ip_from 2405:8100::/32;
    set_real_ip_from 2a06:98c0::/29;
    set_real_ip_from 2c0f:f248::/32;
    real_ip_header CF-Connecting-IP;`;

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

    // Cloudflare Real IP configuration
    if (params.cloudflareRealIp || params.ssl === "cloudflare-flexible" || params.ssl === "cloudflare-origin") {
        content = content.replace(
            /(# Security Headers)/,
            `${CLOUDFLARE_REAL_IP_CONFIG}\n\n    $1`
        );
    }

    // Cloudflare Flexible SSL: Nginx listens on 80, but passes HTTPS hints so apps (Laravel/CI4/Express) don't redirect loop
    if (params.ssl === "cloudflare-flexible") {
        if (params.kind === "php") {
            content = content.replace(
                "fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;",
                `fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;\n        # Cloudflare Flexible SSL detection\n        fastcgi_param HTTP_X_FORWARDED_PROTO $http_x_forwarded_proto;\n        fastcgi_param HTTPS $https_forwarded;`
            );
            // Add map in server block or before location
            content = content.replace(
                "server {",
                `# Detect Cloudflare HTTPS proxying\nmap $http_x_forwarded_proto $https_forwarded {\n    default off;\n    https on;\n}\n\nserver {`
            );
        } else if (params.kind === "node") {
            content = content.replace(
                "proxy_set_header X-Forwarded-Proto $scheme;",
                `proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;\n        proxy_set_header CF-Visitor $http_cf_visitor;`
            );
        }
    }

    // Cloudflare Origin Certificate: Listen on 443 SSL HTTP2 with Cloudflare Origin CA certificate
    if (params.ssl === "cloudflare-origin") {
        const primaryDomain = params.domains[0] || "app";
        const certPath = params.sslCertPath || `/etc/ssl/certs/cf-origin-${primaryDomain}.pem`;
        const keyPath = params.sslKeyPath || `/etc/ssl/private/cf-origin-${primaryDomain}.key`;

        const sslListenBlock = `    listen 443 ssl http2;\n    listen [::]:443 ssl http2;\n\n    ssl_certificate ${certPath};\n    ssl_certificate_key ${keyPath};\n    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_ciphers HIGH:!aNULL:!MD5;`;

        content = content.replace(
            /listen 80;\s*\n\s*listen \[::\]:80;/,
            sslListenBlock
        );

        // Prepend an HTTP to HTTPS redirect block
        const redirectBlock = `server {\n    listen 80;\n    listen [::]:80;\n    server_name ${domainsStr};\n    return 301 https://$host$request_uri;\n}\n\n`;
        content = redirectBlock + content;
    }

    return content;
}

export async function generateSystemdUnit(params: SystemdConfigParams): Promise<string> {
    const templatesDir = getServicesTemplatesDir();
    const templateName = params.isQueueWorker ? "laravel-worker.service" : "systemd.service";
    const templatePath = path.join(templatesDir, templateName);
    let content = await fs.readFile(templatePath, "utf8");

    content = content.replace(/\{\{APP_NAME\}\}/g, params.appName);
    content = content.replace(/\{\{USER\}\}/g, params.user);
    content = content.replace(/\{\{WORKING_DIR\}\}/g, params.workingDir);
    content = content.replace(/\{\{EXEC_START\}\}/g, params.execStart);

    return content;
}
