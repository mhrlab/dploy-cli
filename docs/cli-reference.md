# CLI Commands Reference

`dploy-cli` provides commands for every stage of modern zero-downtime deployment workflows.

---

## Command Overview

| Command | Description |
| :--- | :--- |
| [`dploy init`](#dploy-init) | Generate starter deployment configuration from templates |
| [`dploy build`](#dploy-build) | Package project locally into `.tar.gz` release archive |
| [`dploy deploy`](#dploy-deploy) | Zero-downtime deploy to remote server or cluster |
| [`dploy rollback`](#dploy-rollback) | Switch `current` symlink back to a previous release |
| [`dploy list`](#dploy-list) | List release history with commits, timestamps, and active status |
| [`dploy status`](#dploy-status) | Show current active release and health summary |
| [`dploy clean`](#dploy-clean) | Prune old release directories on the remote server |
| [`dploy provision`](#dploy-provision) | Idempotently prepare remote server directory layout & permissions |
| [`dploy setup`](#dploy-setup) | Interactive server wizard for Nginx, Systemd, Certbot, & Queue workers |
| [`dploy down`](#dploy-down--dploy-up) | Put application into HTTP 503 maintenance mode with styled template |
| [`dploy up`](#dploy-down--dploy-up) | Disable maintenance mode and restore live web traffic |
| [`dploy ssh`](#dploy-ssh--dploy-run) | Open interactive native SSH session into `current/` |
| [`dploy run`](#dploy-ssh--dploy-run) | Execute arbitrary remote command in `current/` |
| [`dploy logs`](#dploy-logs) | Stream remote logs (`tail -f`) directly to your terminal |
| [`dploy env`](#dploy-env) | Manage remote shared `.env` variables (`push`, `pull`, `set`) |
| [`dploy site info`](#dploy-site-info) | Inspect remote site status (Nginx vhost, systemd, SSL, release) |
| [`dploy site backup`](#dploy-site-backup) | Snapshot remote Nginx, systemd, sudoers, & `.env` into local `.tar.gz` |
| [`dploy site ssl`](#dploy-site-ssl) | Switch SSL modes on the fly (Certbot, Cloudflare Flexible, Origin CA) |
| [`dploy site remove`](#dploy-site-remove) | Safely decommission site with confirmation and optional backup |

---

## Detailed Command Specifications

### `dploy init`
Initialize deployment configuration in the current working directory.
```bash
dploy init [template] [-f, --force]
```
- **Templates**: `node`, `laravel`, `fastapi`, `static`, `nextjs`
- **Options**:
  - `-f, --force`: Overwrite existing `deploy.config.yml` if present.

### `dploy build`
Package your project files into a local deployable `.tar.gz` archive.
```bash
dploy build [-V, --version <version>] [-n, --dry-run]
```
- **Options**:
  - `-V, --version <version>`: Explicit release version override.
  - `-n, --dry-run`: Preview files to be packaged without creating the archive.

### `dploy deploy`
Execute an atomic zero-downtime deployment to a single server or cluster.
```bash
dploy deploy [options]
```
- **Options**:
  - `-e, --env <name>`: Target environment (defaults to `production` or `DPLOY_DEFAULT_ENV`).
  - `-V, --version <version>`: Override release version.
  - `-n, --dry-run`: Preview planned deployment steps without remote execution.
  - `--skip-build`: Use an existing prebuilt artifact instead of building.
  - `--artifact <path>` / `--archive <path>`: Deploy a specific custom `.tar.gz` archive.
  - `--keep-artifact`: Retain the local `.tar.gz` build artifact after deployment.
  - `--no-health-gate`: Disable health-check verification failure gating.
  - `--no-auto-rollback`: Disable automatic rollback if the post-deploy health check fails.
  - `--health-retries <count>`: Number of retry attempts for health endpoint check.
  - `--maintenance`: Enable maintenance mode before cutover and disable after completion.
  - `--backup-db`: Trigger automated pre-deploy database snapshot.
  - `--strategy <parallel|rolling>`: Multi-server deployment strategy (default: `parallel`).

### `dploy rollback`
Roll back to an earlier release on the remote server.
```bash
dploy rollback [options]
```
- **Options**:
  - `-e, --env <name>`: Target environment.
  - `-n, --dry-run`: Preview symlink change without executing.
  - `--latest`: Automatically roll back to the immediately preceding release.
  - `--to <version>`: Roll back to a specific target release version non-interactively.

### `dploy list`
List releases on the remote server.
```bash
dploy list [-e <env>] [--json]
```
- **Options**:
  - `--json`: Output machine-readable JSON array of release objects.

### `dploy status`
Display the currently active release, health status, and metadata.
```bash
dploy status [-e <env>] [--json]
```

### `dploy clean`
Prune old releases on the remote server according to `keepVersions`.
```bash
dploy clean [-e <env>] [--keep <number>] [-n, --dry-run]
```

### `dploy provision`
Prepare directories, shared storage, and permissions on a fresh server.
```bash
dploy provision [-e <env>] [-n, --dry-run] [--force] [--skip-checks] [--only <step>]
```
- **Steps**: `prereqs`, `dirs`, `shared`, `permissions`, `service`.

### `dploy setup`
Automated server wizard for generating and deploying production system services.
```bash
dploy setup [options]
```
- **Options**:
  - `-e, --env <name>`: Target environment.
  - `--service <nginx|systemd|certbot|laravel-worker>`: Generate specific service configuration.
  - `--type <proxy|spa|php>`: Nginx configuration type.
  - `--domain <domain>`: Server domain name (e.g. `api.example.com`).
  - `--upstream <port>`: Local proxy port (default: 3000).
  - `--certbot`: Request SSL certificates automatically via Certbot.
  - `--dry-run`: Preview generated service files without writing to remote disk.
  - `--yes`: Run non-interactively with defaults or provided CLI flags.

### `dploy down` & `dploy up`
Manage application maintenance mode. Automatically serves a responsive, dark-themed HTTP 503 maintenance page via Nginx without requiring an Nginx reload.
```bash
dploy down [-e <env>] [--message "Updating database"] [--retry 120]
dploy up [-e <env>]
```

### `dploy ssh` & `dploy run`
Remote access without managing passwords or keys manually.
```bash
# Interactive TTY shell directly in <deployTo>/current
dploy ssh [-e <env>]

# Execute remote command (use --as-admin to execute via env.admin credentials)
dploy run "php artisan migrate --force" [-e <env>]
dploy run "npm run db:migrate" [-e <env>]
dploy run "systemctl restart php8.2-fpm" --as-admin [-e <env>]
```

### `dploy logs`
Real-time remote log streaming (`tail -f`). Supports custom configured paths in `deploy.config.yml`, framework logs (`storage/logs`, `writable/logs`), and elevated streaming via `--as-admin` (alias `--as-sudo`) using `env.admin` credentials.
```bash
dploy logs [-e <env>] [-f, --follow] [-n <lines>] [--type <app|nginx|pm2|systemd>] [--file <path>] [--as-admin] [--sudo]
```

### `dploy env` (aliases: `dploy env:*`)
Manage remote environment variables securely.
```bash
dploy env push [-e <env>] [--file <local-path>] [--force]
dploy env pull [-e <env>] [--out <local-path>] [--force]
dploy env set KEY=VALUE [-e <env>]
```

### `dploy site`
Remote server and website lifecycle management. Automatically detects domain names from `env.domain`, `cfg.domain`, or `deployTo` path (e.g. `/var/www/tunenest.in`), with support for `--as-admin` (or `--as-sudo`) to connect using `env.admin` credentials.
```bash
# Inspect live remote Nginx virtual host, systemd status, SSL, and current release
dploy site info [-e <env>] [-d <domain>] [--as-admin]

# Create a local timestamped snapshot of Nginx, systemd units, sudoers, and .env
dploy site backup [-e <env>] [-d <domain>] [-o ./backups] [--as-admin]

# Switch SSL mode without re-running setup (Certbot, Cloudflare Flexible, Origin CA)
dploy site ssl [-e <env>] [--ssl cloudflare-flexible] [--cloudflare] [--as-admin]

# Decommission and clean up site services and Nginx configs (alias: dploy remove)
dploy site remove [-e <env>] [-d <domain>] [--dry-run] [--force] [--as-admin]
dploy remove [-e <env>] [--as-admin]
```
