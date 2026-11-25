# CLI Commands Reference

`dploy-cli` organizes root commands into four logical groups and supports short ergonomic aliases for daily workflows.

---

## Global Options

These flags can be passed before or after any command (shown under `Global Options:` in `--help`):

| Flag | Description |
| :--- | :--- |
| `-e, --env <env>` | Target environment (default: `production`, or `DPLOY_DEFAULT_ENV` / `DPLOY_ENV`) |
| `-v, --verbose` | Enable timestamped `[VERBOSE]` logging |
| `-d, --debug` | Enable timestamped `[DEBUG]` logging (includes truncated SSH stdout/stderr) |
| `-q, --quiet` | Suppress non-essential stdout and banners (errors/warnings still print to stderr) |
| `-y, --yes` | Automatic yes to interactive prompts |
| `--passphrase <passphrase>` | Passphrase for encrypted SSH private key |
| `-a, --app-version` | Output the `dploy-cli` version |
| `-h, --help` | Display help for command |

---

## Command Overview

### Setup & Infrastructure
| Command | Alias | Description |
| :--- | :--- | :--- |
| [`dploy init [template]`](#dploy-init) | — | Initialize `deploy.config.yml` and `.env.dploy.example` from templates |
| [`dploy setup`](#dploy-setup) | — | Interactive server wizard: Nginx, systemd, queue worker, SSL, and deploy user |
| [`dploy provision`](#dploy-provision) | `prov`, `setup-server` | Idempotently prepare remote directories, shared paths, and permissions |

### Deployment Lifecycle
| Command | Alias | Description |
| :--- | :--- | :--- |
| [`dploy build`](#dploy-build) | — | Package project locally into `.tar.gz` release archive |
| [`dploy deploy`](#dploy-deploy) | `d` | Zero-downtime deploy to remote server or cluster |
| [`dploy rollback`](#dploy-rollback) | `rb` | Switch `current` symlink back to a previous release |
| [`dploy clean`](#dploy-clean) | — | Prune old releases beyond `keepVersions` |

### Monitoring & Operations
| Command | Alias | Description |
| :--- | :--- | :--- |
| [`dploy status`](#dploy-status) | `st` | Show active release, host info, and deployment metadata |
| [`dploy list`](#dploy-list) | `ls`, `releases` | List releases on the remote server |
| [`dploy health`](#dploy-health) | — | Probe the configured HTTP health endpoint |
| [`dploy logs`](#dploy-logs) | — | Stream or tail remote app, Nginx, PM2, or systemd logs |
| [`dploy ssh`](#dploy-ssh--dploy-run) | — | Open an interactive SSH terminal in `<deployTo>/current` |
| [`dploy run <command>`](#dploy-ssh--dploy-run) | — | Execute an ad-hoc command inside `current` (or `--release`) |
| [`dploy down`](#dploy-down--dploy-up) | — | Enable HTTP 503 maintenance mode |
| [`dploy up`](#dploy-down--dploy-up) | — | Disable maintenance mode and restore live traffic |

### Resource Management
| Command | Alias | Description |
| :--- | :--- | :--- |
| [`dploy env`](#dploy-env) | `env:*` *(hidden)* | Manage remote `shared/.env` (`push`, `pull`, `set`, `edit`) |
| [`dploy site`](#dploy-site) | `remove` *(hidden)* | Manage sites (`add`, `info`, `ssl`, `backup`, `remove`) |
| [`dploy db`](#dploy-db) | `database`, `db:*` *(hidden)* | Manage remote databases (`create`, `drop`, `backup`, `restore`, `optimize`, `console`) |

> [!NOTE]
> Legacy top-level colon aliases (`env:push`, `env:pull`, `env:set`, `env:edit`, `db:create`, `db:drop`, `db:backup`, `db:restore`, `db:optimize`, `db:console`, and `dploy remove`) remain executable for backward compatibility, but are hidden from `dploy --help`.

---

## Detailed Command Specifications

### `dploy init`
Initialize deployment configuration in the current working directory (`src/commands/init.ts`).
```bash
dploy init [template]
```
- **Available Templates** (`templates/`): `node`, `laravel`, `ci4`, `fastapi`, `go`, `spa` (plus JSON variants `node`, `laravel` if selected interactively).
- Copies `.env.dploy.example` if missing and updates `.gitignore`.

### `dploy build`
Package your project files into a local `.tar.gz` archive (`src/commands/build.ts`).
```bash
dploy build [-V, --version <ver>] [-n, --dry-run]
```
- `-V, --version <ver>`: Override release version string.
- `-n, --dry-run`: Show planned build actions without writing files.

### `dploy deploy`
Execute an atomic zero-downtime deployment (`src/commands/deploy.ts`).
```bash
dploy deploy [options]   # alias: dploy d
```
- `-A, --artifact <path>`: Deploy a custom `.tar.gz` archive (skips build). Hidden alias: `--archive <path>`.
- `-s, --skip-build`: Skip local build and use the newest matching local artifact.
- `--version-override <ver>`: Override release version string (hidden alias: `-V, --version <ver>`).
- `-n, --dry-run`: Preview planned deploy actions without changing anything.
- `--keep-artifact`: Preserve local `.tar.gz` artifact after deployment.
- `--no-auto-rollback`: Disable automatic rollback if post-deploy health check fails.
- `--no-health-gate`: Do not abort deployment if health check fails.
- `--maintenance`: Enable maintenance mode before cutover and disable after completion.
- `--backup-db`: Take automated pre-deployment database backup before release cutover.

### `dploy rollback`
Roll back to a previous release (`src/commands/rollback.ts`).
```bash
dploy rollback [options]   # alias: dploy rb
```
- `--latest`: Roll back to the immediately preceding release without prompting.
- `--to <version>`: Roll back to a specific release by directory name.
- `-n, --dry-run`: Preview symlink switch without modifying the server.
- `--non-interactive`: Disable interactive prompts.

### `dploy list`
List releases on the remote server (`src/commands/list.ts`).
```bash
dploy list [-e <env>] [--json]   # aliases: dploy ls, dploy releases
```

### `dploy status`
Show active release and remote deployment status (`src/commands/status.ts`).
```bash
dploy status [-e <env>] [--json]   # alias: dploy st
```

### `dploy clean`
Remove old releases beyond `keepVersions` (`src/commands/clean.ts`).
```bash
dploy clean [-e <env>] [-n, --dry-run]
```

### `dploy provision`
Prepare directories, shared paths, and permissions idempotently (`src/commands/provision.ts`).
```bash
dploy provision [-e <env>] [-n, --dry-run] [--force] [--skip-checks] [--only <step>] [--json]
```
- **Aliases**: `prov`, `setup-server`
- `--only <step>`: Run a single step (`prereqs`, `dirs`, `shared`, `permissions`, `service`).

### `dploy setup`
Interactive server setup wizard (`src/commands/setup.ts`).
```bash
dploy setup [options]
```
- `--webserver <type>`: `nginx` or `none`
- `--kind <type>`: `node`, `php`, or `spa`
- `--domain <domain>`: Primary domain(s)
- `--port <port>`: Upstream port for Node.js reverse proxy
- `--php-socket <path>`: PHP-FPM socket path
- `--ssl <mode>`: `certbot`, `cloudflare-flexible`, `cloudflare-origin`, or `none`
- `--cloudflare`: Shortcut for `cloudflare-flexible` with Real-IP headers
- `--cf-cert <pathOrContent>`: Cloudflare Origin CA certificate (`.pem` path or PEM content)
- `--cf-key <pathOrContent>`: Cloudflare Origin CA private key (`.key` path or PEM content)
- `--certbot`: Shortcut for `--ssl certbot`
- `--service`: Create and enable a systemd background service
- `--exec-start <cmd>`: `ExecStart` command for the systemd service
- `--queue-worker`: Create and enable a background queue worker (e.g., Laravel)
- `--worker-command <cmd>`: Command for the queue worker service
- `--admin-user <user>`, `--admin-key <path>`, `--admin-password <pass>`: Admin/sudo SSH credentials
- `--create-deployer`: Create unprivileged deploy user and configure `/etc/sudoers.d/dploy-<app>`
- `-n, --dry-run`: Preview generated Nginx and systemd configs without modifying the server

### `dploy down` & `dploy up`
Toggle HTTP 503 maintenance mode (`src/commands/maintenance.ts`).
```bash
dploy down [-e <env>] [-m, --message <msg>] [--retry <seconds>]
dploy up [-e <env>]
```

### `dploy ssh` & `dploy run`
Interactive shell or one-off remote command execution (`src/commands/ssh.ts`, `src/commands/run.ts`).
```bash
dploy ssh [-e <env>]
dploy run "<command>" [-e <env>] [--release <name>] [-A, --as-admin] [--admin-user <user>] [--admin-key <path>] [--admin-password <pass>]
```

### `dploy logs`
Stream or tail remote logs (`src/commands/logs.ts`).
```bash
dploy logs [-e <env>] [-f, --follow] [-n, --lines <count>] [--type <app|nginx|pm2|systemd>] [--file <path>] [--latest] [--sudo] [-A, --as-admin]
```
- `--type nginx` tails `/var/log/nginx/<domain>.error.log` and `<domain>.access.log` (falling back to global Nginx logs).
- `--latest` automatically selects the newest daily log file (e.g., `laravel-YYYY-MM-DD.log`).

### `dploy env`
Manage remote `shared/.env` (`src/commands/env.ts`).
```bash
dploy env push [-e <env>] [-f, --file <path>] [--force]
dploy env pull [-e <env>] [-o, --out <path>] [--force]
dploy env set KEY=VALUE [-e <env>]
dploy env edit [-e <env>] [--editor <cmd>] [--force]
```

### `dploy site`
Manage websites, Nginx vhosts, SSL, and teardown (`src/commands/site.ts`).
```bash
# Add a 2nd domain/site to an already-provisioned VPS (skips user & sudoers creation)
dploy site add [-e <env>] [-D, --domain <domain>] [--kind <node|php|spa>] [--ssl <mode>] [-A, --as-admin] [-n, --dry-run]

# Inspect Nginx vhost, systemd units, SSL status, and current release
dploy site info [-e <env>] [-D, --domain <domain>] [-A, --as-admin]

# Switch SSL mode without re-running full setup
dploy site ssl [-e <env>] [-D, --domain <domain>] [--ssl <certbot|cloudflare-flexible|cloudflare-origin|none>] [--cloudflare] [--certbot] [-A, --as-admin] [-n, --dry-run]

# Snapshot Nginx, systemd, sudoers, and shared/.env into a local .tar.gz
dploy site backup [-e <env>] [-D, --domain <domain>] [-o, --output <dir>] [-A, --as-admin]

# Remove site configs, services, and optionally SSL/files (aliases: rm, delete)
dploy site remove [-e <env>] [-D, --domain <domain>] [-f, --force] [--no-backup] [--purge-ssl] [--purge-files] [-A, --as-admin] [-n, --dry-run]
```

### `dploy db`
Manage MySQL, PostgreSQL, and SQLite databases (`src/commands/database.ts`, alias: `dploy database`).
```bash
dploy db create [name] [-e <env>] [--type <mysql|postgres|sqlite>] [-u <user>] [-p <password>] [--host <host>] [--port <port>] [--db-root-user <user>] [--db-root-password <pass>] [--charset <charset>] [--collation <collation>] [-n, --dry-run] [-A, --as-admin]
dploy db drop [name] [-e <env>] [--type <type>] [--drop-user] [-f, --force] [-n, --dry-run] [-A, --as-admin]
dploy db backup [-e <env>] [--type <type>] [--name <name>] [--download [path]] [-o, --output <path>] [-A, --as-admin]
dploy db restore <file> [-e <env>] [--type <type>] [--name <name>] [-f, --force] [-A, --as-admin]
dploy db optimize [-e <env>] [--type <type>] [--name <name>] [-A, --as-admin]
dploy db console [-e <env>] [--type <type>] [--name <name>] [-A, --as-admin]   # aliases: cli, sh, shell
```
