import assert from "node:assert/strict";
import { test } from "node:test";
import { generateNginxConfig, generateSystemdUnit } from "../src/features/server-wizard.js";

test("generateNginxConfig generates valid Nginx reverse proxy configuration for Node", async () => {
    const config = await generateNginxConfig({
        kind: "node",
        domains: ["api.example.com", "example.com"],
        port: 4000,
    });

    assert.ok(config.includes("server_name api.example.com example.com;"));
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
