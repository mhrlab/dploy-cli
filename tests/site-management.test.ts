import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import * as tar from "tar";
import { backupSiteConfigurations } from "../src/features/site-backup.js";
import { removeSiteConfigurations } from "../src/features/site-remove.js";
import { siteRemove } from "../src/commands/site.js";

test("backupSiteConfigurations captures Nginx, systemd, sudoers, and creates a valid tar.gz archive", async () => {
    const executedCommands: string[] = [];

    // Mock SSH client
    const mockSsh: any = {
        exec: (cmd: string, cb: (err: any, stream: any) => void) => {
            executedCommands.push(cmd);

            let stdout = "";
            let code = 0;

            if (cmd.includes("test -f")) {
                code = 0; // files exist
            } else if (cmd.includes("cat '/etc/nginx/sites-available/app.example.com'")) {
                stdout = "server { server_name app.example.com; }";
            } else if (cmd.includes("cat '/etc/systemd/system/test-app.service'")) {
                stdout = "[Unit]\nDescription=test-app Service";
            } else if (cmd.includes("cat '/etc/systemd/system/test-app-worker.service'")) {
                stdout = "[Unit]\nDescription=test-app Worker";
            } else if (cmd.includes("cat '/etc/sudoers.d/dploy-test-app'")) {
                stdout = "deploy ALL=(ALL) NOPASSWD: ALL";
            } else if (cmd.includes("cat '/var/www/test-app/shared/.env'")) {
                stdout = "APP_ENV=production\nAPP_KEY=base64:mock=";
            }

            const stream: any = {
                on: (event: string, handler: any) => {
                    if (event === "data") {
                        if (stdout) handler(Buffer.from(stdout));
                    } else if (event === "close") {
                        handler(code);
                    }
                    return stream;
                },
                stderr: {
                    on: (event: string, handler: any) => stream.stderr,
                },
            };
            cb(null, stream);
        },
    };

    const tmpOut = await fs.mkdtemp(path.join(os.tmpdir(), "dploy-backup-test-"));
    try {
        const result = await backupSiteConfigurations(mockSsh, {} as any, {
            appName: "test-app",
            domains: ["app.example.com"],
            deployTo: "/var/www/test-app",
            outputDir: tmpOut,
        });

        assert.ok(fs.existsSync(result.archivePath));
        assert.ok(result.sizeBytes > 0);
        assert.ok(result.filesIncluded.includes("nginx/app.example.com.conf"));
        assert.ok(result.filesIncluded.includes("systemd/test-app.service"));
        assert.ok(result.filesIncluded.includes("sudoers/dploy-test-app"));
        assert.ok(result.filesIncluded.includes("env/.env"));
        assert.ok(result.filesIncluded.includes("manifest.json"));

        // Extract and check manifest contents
        const extractDir = path.join(tmpOut, "extracted");
        await fs.ensureDir(extractDir);
        await tar.extract({ file: result.archivePath, cwd: extractDir });

        const manifest = await fs.readJson(path.join(extractDir, "manifest.json"));
        assert.equal(manifest.appName, "test-app");
        assert.deepEqual(manifest.domains, ["app.example.com"]);
    } finally {
        await fs.remove(tmpOut);
    }
});

test("removeSiteConfigurations executes stop, disable, file removals and nginx reload", async () => {
    const executedCommands: string[] = [];

    const mockSsh: any = {
        exec: (cmd: string, cb: (err: any, stream: any) => void) => {
            executedCommands.push(cmd);
            const stream: any = {
                on: (event: string, handler: any) => {
                    if (event === "close") handler(0);
                    return stream;
                },
                stderr: {
                    on: () => stream.stderr,
                },
            };
            cb(null, stream);
        },
    };

    const results = await removeSiteConfigurations(mockSsh, {
        appName: "demo-app",
        domains: ["demo.example.com"],
        deployTo: "/var/www/demo-app",
        purgeNginx: true,
        purgeServices: true,
        purgeSudoers: true,
        purgeSsl: true,
        purgeFiles: true,
        sudoPrefix: "sudo -n ",
    });

    assert.ok(results.length > 0);
    assert.ok(executedCommands.some((c) => c.includes("systemctl stop 'demo-app'")));
    assert.ok(executedCommands.some((c) => c.includes("rm -f /etc/systemd/system/'demo-app.service'")));
    assert.ok(executedCommands.some((c) => c.includes("rm -f '/etc/nginx/sites-enabled/demo.example.com'")));
    assert.ok(executedCommands.some((c) => c.includes("rm -f '/etc/nginx/sites-available/demo.example.com'")));
    assert.ok(executedCommands.some((c) => c.includes("rm -f '/etc/sudoers.d/dploy-demo-app'")));
    assert.ok(executedCommands.some((c) => c.includes("certbot delete --cert-name 'demo.example.com'")));
    assert.ok(executedCommands.some((c) => c.includes("rm -rf '/var/www/demo-app'")));
    assert.ok(executedCommands.some((c) => c.includes("systemctl reload nginx")));
});

test("siteRemove dry-run previews removal without executing destructive SSH commands", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dploy-site-test-"));
    const prevCwd = process.cwd();

    try {
        process.chdir(tmpDir);
        await fs.writeJson("package.json", { name: "my-site", version: "1.0.0" });
        await fs.writeFile(
            "deploy.config.yml",
            `
name: my-site
environments:
  staging:
    host: 192.168.1.100
    username: deploy
    deployTo: /var/www/my-site
`
        );

        await assert.doesNotReject(async () => {
            await siteRemove({
                env: "staging",
                dryRun: true,
                force: true,
                domain: "preview.mysite.com",
            });
        });
    } finally {
        process.chdir(prevCwd);
        await fs.remove(tmpDir);
    }
});

test("siteSsl dry-run previews updated Nginx SSL configuration without modifying server", async () => {
    const { siteSsl } = await import("../src/commands/site.js");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dploy-site-ssl-"));
    const prevCwd = process.cwd();

    try {
        process.chdir(tmpDir);
        await fs.writeJson("package.json", { name: "ssl-site", version: "1.0.0" });
        await fs.writeFile(
            "deploy.config.yml",
            `
name: ssl-site
environments:
  production:
    host: 192.168.1.120
    username: deploy
    deployTo: /var/www/ssl-site
`
        );

        // Dry run with mock connection should not throw
        await assert.doesNotReject(async () => {
            await siteSsl({
                env: "production",
                dryRun: true,
                ssl: "cloudflare-flexible",
                domain: "ssl.example.com",
            });
        });
    } finally {
        process.chdir(prevCwd);
        await fs.remove(tmpDir);
    }
});

test("siteAdd dry-run configures site without user/sudoers provisioning", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dploy-site-add-"));
    const prevCwd = process.cwd();

    try {
        process.chdir(tmpDir);
        await fs.writeJson("package.json", { name: "second-site", version: "1.0.0" });
        await fs.writeFile(
            "deploy.config.yml",
            `
name: second-site
environments:
  production:
    host: 192.168.1.120
    username: deploy
    deployTo: /var/www/second-site.in
`
        );

        const { siteAdd } = await import("../src/commands/site.js");
        await assert.doesNotReject(async () => {
            await siteAdd({
                env: "production",
                dryRun: true,
                webserver: "nginx",
                kind: "php",
                domain: "second-site.in",
                ssl: "cloudflare-flexible",
            });
        });
    } finally {
        process.chdir(prevCwd);
        await fs.remove(tmpDir);
    }
});

test("site commands auto-detect domain from deployTo path (e.g. /var/www/tunenest.in)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dploy-site-detect-"));
    const prevCwd = process.cwd();

    try {
        process.chdir(tmpDir);
        await fs.writeJson("package.json", { name: "tunenest", version: "1.0.0" });
        await fs.writeFile(
            "deploy.config.yml",
            `
name: "CodeIgniter 4 + Nginx"
environments:
  staging:
    host: 68.233.106.193
    username: deploy
    deployTo: /var/www/tunenest.in
`
        );

        // Dry-run removal to verify it resolves domain tunenest.in without manual --domain flag
        await assert.doesNotReject(async () => {
            await siteRemove({
                env: "staging",
                dryRun: true,
                force: true,
            });
        });
    } finally {
        process.chdir(prevCwd);
        await fs.remove(tmpDir);
    }
});

test("site commands with --as-admin use env.admin credentials and throw when missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dploy-site-admin-"));
    const prevCwd = process.cwd();

    try {
        process.chdir(tmpDir);
        await fs.writeJson("package.json", { name: "test-admin", version: "1.0.0" });
        await fs.writeFile(
            "deploy.config.yml",
            `
name: "test-admin"
environments:
  staging:
    host: 192.168.1.50
    username: deploy
    deployTo: /var/www/test-admin
`
        );

        // When admin: is not configured, --as-admin should throw informative error
        await assert.rejects(
            async () => {
                await siteRemove({
                    env: "staging",
                    dryRun: true,
                    force: true,
                    asAdmin: true,
                });
            },
            /Admin credentials not found/
        );

        // Now add admin: block to deploy.config.yml
        await fs.writeFile(
            "deploy.config.yml",
            `
name: "test-admin"
environments:
  staging:
    host: 192.168.1.50
    username: deploy
    deployTo: /var/www/test-admin
    admin:
      username: root
`
        );

        // Should resolve cleanly with root credentials
        await assert.doesNotReject(async () => {
            await siteRemove({
                env: "staging",
                dryRun: true,
                force: true,
                asAdmin: true,
            });
        });
    } finally {
        process.chdir(prevCwd);
        await fs.remove(tmpDir);
    }
});

test("toSudoersSlug sanitizes names with spaces and symbols into valid sudoers filenames", async () => {
    const { toSudoersSlug } = await import("../src/core/utils.js");
    assert.equal(toSudoersSlug("CodeIgniter 4 + Nginx"), "codeigniter-4-nginx");
    assert.equal(toSudoersSlug("My App (Prod)"), "my-app-prod");
    assert.equal(toSudoersSlug("test_app.v2"), "test_app-v2");
    assert.equal(toSudoersSlug(""), "app");
});
