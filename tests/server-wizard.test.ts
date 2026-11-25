import assert from "node:assert/strict";
import { test } from "node:test";
import { generateNginxConfig, generateSystemdUnit, getSslModeGuidance } from "../src/features/server-wizard.js";

test("generateNginxConfig generates valid Nginx reverse proxy configuration for Node", async () => {
    const config = await generateNginxConfig({
        kind: "node",
        domains: ["api.example.com", "example.com"],
        port: 4000,
    });

    assert.ok(config.includes("server_name api.example.com example.com;"));
    assert.ok(config.includes("access_log /var/log/nginx/api.example.com.access.log;"));
    assert.ok(config.includes("error_log /var/log/nginx/api.example.com.error.log warn;"));
    assert.ok(config.includes("proxy_pass http://127.0.0.1:4000;"));
    assert.ok(config.includes("proxy_set_header Upgrade $http_upgrade;"));
    assert.ok(config.includes("proxy_set_header Host $host;"));
});

test("generateNginxConfig generates valid Nginx SPA configuration", async () => {
    const config = await generateNginxConfig({
        kind: "spa",
        domains: ["app.example.com"],
        rootDir: "/var/www/app/current/dist",
    });

    assert.ok(config.includes("server_name app.example.com;"));
    assert.ok(config.includes("root /var/www/app/current/dist;"));
    assert.ok(config.includes("try_files $uri $uri/ /index.html;"));
    assert.ok(config.includes("gzip on;"));
});

test("generateNginxConfig generates valid Nginx PHP-FPM configuration", async () => {
    const config = await generateNginxConfig({
        kind: "php",
        domains: ["laravel.example.com"],
        rootDir: "/var/www/laravel/current/public",
        phpSocket: "unix:/run/php/php8.3-fpm.sock",
    });

    assert.ok(config.includes("server_name laravel.example.com;"));
    assert.ok(config.includes("root /var/www/laravel/current/public;"));
    assert.ok(config.includes("fastcgi_pass unix:/run/php/php8.3-fpm.sock;"));
    assert.ok(config.includes("try_files $uri $uri/ /index.php?$query_string;"));
});

test("generateSystemdUnit generates systemd service unit file with correct directives", async () => {
    const unit = await generateSystemdUnit({
        appName: "my-node-app",
        user: "deploy",
        workingDir: "/var/www/my-node-app/current",
        execStart: "node dist/server.js",
    });

    assert.ok(unit.includes("Description=my-node-app Node Application"));
    assert.ok(unit.includes("User=deploy"));
    assert.ok(unit.includes("WorkingDirectory=/var/www/my-node-app/current"));
    assert.ok(unit.includes("ExecStart=node dist/server.js"));
    assert.ok(unit.includes("Restart=always"));
    assert.ok(unit.includes("WantedBy=multi-user.target"));
});

test("generateSystemdUnit generates queue worker service unit file for Laravel", async () => {
    const unit = await generateSystemdUnit({
        appName: "laravel-app",
        user: "www-data",
        workingDir: "/var/www/laravel-app/current",
        execStart: "php artisan queue:work --sleep=3 --tries=3",
        isQueueWorker: true,
    });

    assert.ok(unit.includes("Description=laravel-app Queue Worker"));
    assert.ok(unit.includes("User=www-data"));
    assert.ok(unit.includes("WorkingDirectory=/var/www/laravel-app/current"));
    assert.ok(unit.includes("ExecStart=php artisan queue:work --sleep=3 --tries=3"));
    assert.ok(unit.includes("SyslogIdentifier=laravel-app-worker"));
});

test("generateNginxConfig generates Cloudflare Flexible SSL and Real-IP headers", async () => {
    const config = await generateNginxConfig({
        kind: "php",
        domains: ["cloudflare.example.com"],
        rootDir: "/var/www/cf/current/public",
        phpSocket: "unix:/run/php/php8.2-fpm.sock",
        ssl: "cloudflare-flexible",
    });

    assert.ok(config.includes("real_ip_header CF-Connecting-IP;"));
    assert.ok(config.includes("set_real_ip_from 173.245.48.0/20;"));
    assert.ok(config.includes("map $http_x_forwarded_proto $https_forwarded"));
    assert.ok(config.includes("fastcgi_param HTTPS $https_forwarded;"));
});

test("generateNginxConfig generates Cloudflare Origin CA certificate configuration", async () => {
    const config = await generateNginxConfig({
        kind: "node",
        domains: ["secure.example.com"],
        port: 5000,
        ssl: "cloudflare-origin",
    });

    assert.ok(config.includes("listen 443 ssl http2;"));
    assert.ok(config.includes("ssl_certificate /etc/ssl/certs/cf-origin-secure.example.com.pem;"));
    assert.ok(config.includes("ssl_certificate_key /etc/ssl/private/cf-origin-secure.example.com.key;"));
    assert.ok(config.includes("return 301 https://$host$request_uri;"));
    assert.ok(config.includes("real_ip_header CF-Connecting-IP;"));
});

test("setup command executes with --dry-run and honors --admin-user privileged mode", async () => {
    const { setup } = await import("../src/commands/setup.js");
    const fs = (await import("fs-extra")).default;
    const path = await import("node:path");
    const os = await import("node:os");

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dploy-setup-test-"));
    const prevCwd = process.cwd();

    try {
        process.chdir(tmp);
        await fs.writeJson("package.json", { name: "test-wizard-app", version: "1.0.0" });

        const configYml = `
name: test-wizard-app
environments:
  production:
    host: 192.168.1.50
    username: deployer
    deployTo: /var/www/test-wizard-app
    admin:
      username: root
`;
        await fs.writeFile("deploy.config.yml", configYml.trim(), "utf-8");

        // Running with --dry-run should not throw and should handle admin user
        await assert.doesNotReject(async () => {
            await setup({
                env: "production",
                dryRun: true,
                webserver: "nginx",
                kind: "node",
                domain: "test.local",
                adminUser: "root",
                createDeployer: true,
            });
        });
    } finally {
        process.chdir(prevCwd);
        await fs.remove(tmp);
    }
});

test("getSslModeGuidance provides Cloudflare Origin CA instructions and 521 prevention notes", () => {
    const originLines = getSslModeGuidance("cloudflare-origin", "examsolved.in");
    assert.ok(originLines.some((l) => l.includes("Origin Server")));
    assert.ok(originLines.some((l) => l.includes("examsolved.in")));
    assert.ok(originLines.some((l) => l.includes("Full (Strict)")));

    const flexLines = getSslModeGuidance("cloudflare-flexible", "examsolved.in");
    assert.ok(flexLines.some((l) => l.includes("Flexible")));
    assert.ok(flexLines.some((l) => l.includes("521")));

    const noneLines = getSslModeGuidance("none", "examsolved.in");
    assert.ok(noneLines.some((l) => l.includes("521")));

    const certbotLines = getSslModeGuidance("certbot", "examsolved.in");
    assert.equal(certbotLines.length, 0);
});
