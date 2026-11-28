# CLI Commands Reference

This reference lists every `dploy` command, its short aliases, and what each flag does with practical examples.

---

## Global Options (Work on Every Command)

You can pass global flags **before or after** any command name:

| Flag | Plain-English Meaning | Example |
| :--- | :--- | :--- |
| `-e, --env <env>` | Which environment from `deploy.config.yml` to target (default: `production`, or `DPLOY_ENV`). | `dploy deploy -e staging` |
| `-v, --verbose` | Print timestamped `[VERBOSE]` progress details (which commands/steps are running). | `dploy deploy -v` |
| `-d, --debug` | Print timestamped `[DEBUG]` diagnostics (SSH exit codes, truncated stdout/stderr, config details). Secrets are auto-redacted. | `dploy deploy -d` |
| `-q, --quiet` | Hide banners and normal info messages; only errors and warnings print to `stderr`. Great for CI scripts. | `dploy status -q --json` |
| `-y, --yes` | Answer "yes" automatically to confirmation prompts. | `dploy env push -y` |
| `--passphrase <text>` | Passphrase for an encrypted SSH private key (so you aren't prompted). | `dploy deploy --passphrase "..."` |
| `-a, --app-version` | Print the installed `dploy-cli` version and exit. | `dploy -a` |
| `-h, --help` | Show help for `dploy` or any subcommand. | `dploy site --help` |

> [!TIP]
> Notice `-d` means `--debug` everywhere. When passing a domain to `dploy site` commands, use uppercase **`-D, --domain`**.

---

## Root Commands at a Glance

### Setup & Infrastructure
- `dploy init [template]` — Create `deploy.config.yml` and `.env.dploy.example`
- `dploy setup` — Full first-time VPS wizard (user, sudoers, Nginx, systemd, SSL)
- `dploy provision` *(alias: `prov`)* — Create `<deployTo>` directories, shared paths, and permissions

### Deployment Lifecycle
- `dploy build` — Package your app locally into a `.tar.gz` archive
- `dploy deploy` *(alias: `d`)* — Build, upload, verify, link shared files, and switch `current`
- `dploy rollback` *(alias: `rb`)* — Switch `current` back to an earlier release
- `dploy clean` — Delete old releases beyond `keepVersions`

### Monitoring & Operations
- `dploy status` *(alias: `st`)* — Show active release and deployment metadata
- `dploy list` *(aliases: `ls`, `releases`)* — List releases stored on the server
- `dploy health` — Check your app's HTTP health endpoint
- `dploy logs` — Tail or stream app, Nginx, PM2, or systemd logs
- `dploy ssh` — Open an interactive SSH shell in `<deployTo>/current`
- `dploy run <command>` — Run one command on the server inside `current`
- `dploy down` / `dploy up` — Turn HTTP 503 maintenance mode on/off

### Resource Management
- `dploy env` — Manage remote `shared/.env` (`push`, `pull`, `set`, `edit`)
- `dploy site` — Manage sites (`add`, `info`, `ssl`, `backup`, `remove`)
- `dploy db` *(alias: `database`)* — Manage databases (`create`, `drop`, `backup`, `restore`, `optimize`, `console`)

---

## Detailed Command & Flag Guide

### `dploy init [template]`
Creates starter configuration files in your current folder.
```bash
dploy init            # Interactive template picker
dploy init laravel    # Directly use templates/laravel.yaml
```
Available templates: `laravel`, `ci4`, `node`, `fastapi`, `go`, `spa`.

---

### `dploy build`
Packages your project into a local `.tar.gz` without uploading it. Useful for testing `build.include` / `build.exclude` / `.dployignore`.
```bash
dploy build [-V, --version <ver>] [-n, --dry-run]
```
- `-V, --version <ver>`: Force a specific version name (e.g., `1.4.0`) instead of auto-detecting from Git/`package.json`.
- `-n, --dry-run`: List which files would be packed without creating the `.tar.gz`.

---

### `dploy deploy` *(alias: `dploy d`)*
Runs the full zero-downtime deployment pipeline.
```bash
dploy deploy -e production
dploy d -e staging --dry-run
```
| Flag | What It Does |
| :--- | :--- |
| `-n, --dry-run` | Preview every local and remote step without modifying anything. |
| `-A, --artifact <path>` | Upload an existing `.tar.gz` file directly (skips local build). Hidden alias: `--archive`. |
| `-s, --skip-build` | Reuse the latest `release-*.tar.gz` already on disk instead of rebuilding. |
| `--version-override <ver>` | Override the release version string (hidden alias: `-V, --version`). |
| `--keep-artifact` | Keep the local `.tar.gz` file after deploy finishes (normally deleted if `keepArtifact: false`). |
| `--no-health-gate` | Do not fail the deployment if the post-deploy HTTP health check returns non-2xx. |
| `--no-auto-rollback` | Do not automatically revert `current` if the health check fails. |
| `--maintenance` | Automatically run `dploy down` before cutover and `dploy up` after health checks pass. |
| `--backup-db` | Take a pre-deploy database dump before cutover (aborts deploy if the dump fails). |

---

### `dploy rollback` *(alias: `dploy rb`)*
Instantly switches `<deployTo>/current` back to a previous release.
```bash
dploy rollback -e production           # Pick a release interactively
dploy rb -e production --latest        # Jump straight to the previous release
dploy rb -e production --to v1.2.0     # Jump to a specific release folder
```
- `--latest`: Roll back to the immediately preceding release without prompting.
- `--to <version>`: Target a specific release directory name.
- `-n, --dry-run`: Preview the symlink change without applying it.
- `--non-interactive`: Fail instead of waiting for terminal input if no target is given.

---

### `dploy list` *(aliases: `ls`, `releases`)* & `dploy status` *(alias: `st`)*
Inspect what is currently deployed on the server.
```bash
dploy list -e production
dploy status -e production --json
```
- `--json`: Print machine-readable JSON (banners are automatically suppressed).

---

### `dploy clean`
Deletes old release folders beyond `keepVersions` (never deletes the currently active release).
```bash
dploy clean -e production --dry-run
```
- `-n, --dry-run`: Show which release directories would be deleted without removing them.

---

### `dploy provision` *(aliases: `prov`, `setup-server`)*
Bootstraps `<deployTo>` directories (`releases`, `shared`, `backups`, `tmp`), shared paths, permissions, and runtime checks.
```bash
dploy provision -e production
dploy provision -e production --only dirs --dry-run
```
- `--force`: Re-run all steps even if directories/files already exist.
- `--skip-checks`: Skip verifying remote tools (`tar`, `curl`, runtime versions).
- `--only <step>`: Run only one step: `prereqs`, `dirs`, `shared`, `permissions`, or `service`.
- `--json`: Output JSON provisioning report.
- `-n, --dry-run`: Preview planned actions (works offline if SSH cannot connect).

---

### `dploy setup`
Interactive wizard for first-time server setup (creates `deploy` user, sudoers rules, `<deployTo>`, Nginx vhost, systemd/queue worker, and SSL).
```bash
dploy setup -e production --admin-user root --create-deployer
```
| Flag | What It Does |
| :--- | :--- |
| `--webserver <type>` | Web server to configure: `nginx` or `none`. |
| `--kind <type>` | App type: `node` (reverse proxy), `php` (PHP-FPM), or `spa` (static HTML). |
| `--domain <domain>` | Domain name(s), space-separated (e.g. `"example.com www.example.com"`). |
| `--port <port>` | Upstream local port for Node.js apps (default: `3000`). |
| `--php-socket <path>` | PHP-FPM socket path (default: `unix:/run/php/php8.4-fpm.sock`). |
| `--ssl <mode>` | SSL mode: `certbot`, `cloudflare-flexible`, `cloudflare-origin`, or `none`. |
| `--certbot` | Shortcut for `--ssl certbot`. |
| `--cloudflare` | Shortcut for `--ssl cloudflare-flexible`. |
| `--cf-cert <pathOrContent>` | Cloudflare Origin CA certificate (`.pem` path or PEM text). |
| `--cf-key <pathOrContent>` | Cloudflare Origin CA private key (`.key` path or PEM text). |
| `--service` | Create and enable a systemd app service. |
| `--exec-start <cmd>` | Command for the systemd service (`ExecStart`). |
| `--queue-worker` | Create and enable a Laravel queue worker systemd service. |
| `--worker-command <cmd>` | Custom command for the queue worker. |
| `--create-deployer` | Create the unprivileged `deploy` user, copy your SSH key, and configure `/etc/sudoers.d/`. |
| `--admin-user`, `--admin-key`, `--admin-password` | Sudo/root SSH credentials used for OS-level setup. |
| `-n, --dry-run` | Print generated Nginx/systemd files without modifying the server. |

---

### `dploy site`
Manage websites on your server without re-running full user/sudoers setup.

| Subcommand | Purpose & Key Flags |
| :--- | :--- |
| `dploy site add` | Add a 2nd+ domain/app to an existing VPS (same Nginx/SSL/systemd flags as `setup`, skips user & sudoers creation). Uses `-D, --domain <domain>`. |
| `dploy site info` | Inspect Nginx vhost, syntax check, systemd/worker status, SSL expiry/mode, and current release. Flag: `-D, --domain <domain>`. |
| `dploy site ssl` | Switch SSL mode (`--ssl <certbot\|cloudflare-flexible\|cloudflare-origin\|none>`, `--cloudflare`, `--certbot`, `-D, --domain`, `-n, --dry-run`). |
| `dploy site backup` | Download a `.tar.gz` snapshot of Nginx config, systemd units, sudoers rule, and `shared/.env`. Flags: `-D, --domain`, `-o, --output <dir>`. |
| `dploy site remove` *(aliases: `rm`, `delete`)* | Safely remove Nginx vhost, systemd units, and sudoers rule. Flags: `-D, --domain`, `-f, --force`, `--no-backup`, `--purge-ssl`, `--purge-files`, `-n, --dry-run`. |

All `dploy site` subcommands support `-A, --as-admin`, `--admin-user`, `--admin-key`, and `--admin-password`.

---

### `dploy db` *(alias: `dploy database`)*
Manage MySQL, PostgreSQL, and SQLite databases remotely.

```bash
dploy db create myapp_prod -u myapp -p secret -A
dploy db backup -e production --download ./backups
dploy db restore ./backups/dump.sql.gz -e production -A
dploy db console -e production
```

- `create [name]` — Create DB, user, and grant privileges (`--type`, `-u/--user`, `-p/--password`, `--host`, `--port`, `--db-root-user`, `--db-root-password`, `--charset`, `--collation`, `-n/--dry-run`).
- `drop [name]` — Drop DB (`--drop-user`, `-f/--force`, `-n/--dry-run`).
- `backup` — Create dump on server (`--name`, `--type`, `--download [path]`, `-o/--output`).
- `restore <file>` — Restore from local or remote `.sql` / `.sql.gz` (`--name`, `--type`, `-f/--force`).
- `optimize` — Optimize tables (`--name`, `--type`).
- `console` *(aliases: `cli`, `sh`, `shell`)* — Open interactive `mysql`, `psql`, or `sqlite3` session.

All `dploy db` subcommands support `-A, --as-admin`, `--admin-user`, `--admin-key`, and `--admin-password`.

---

### `dploy env`
Manage `<deployTo>/shared/.env` securely:
```bash
dploy env push [-f, --file <localPath>] [--force]   # Upload local .env (creates remote backup)
dploy env pull [-o, --out <localPath>] [--force]    # Download remote shared/.env
dploy env set KEY=VALUE                             # Set or update one key
dploy env edit [--editor <cmd>] [--force]           # Edit in local editor with SHA-256 diff check
```

---

### `dploy logs`, `dploy ssh`, `dploy run`, `dploy down`, `dploy up`
```bash
dploy logs -e production -f -n 100                  # Stream last 100 lines of app logs
dploy logs -e production --entries 4                # Show last 4 complete log entries (with full stack traces)
dploy logs -e production --latest                   # Auto-pick newest daily log file
dploy logs -e production --type nginx -A            # Tail site-specific Nginx error + access logs
dploy logs -e production --type system              # Tail custom `logs.system` path from deploy.config.yml
dploy ssh -e production                             # Open SSH shell in <deployTo>/current
dploy run "php artisan migrate --force" -e production
dploy down -e production -m "Upgrading database" --retry 300
dploy up -e production
```
