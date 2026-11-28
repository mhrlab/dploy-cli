# Configuration Guide (`deploy.config.yml`)

`dploy-cli` reads its configuration from `deploy.config.yml`, `deploy.config.yaml`, or `deploy.config.json` in the root of your project. YAML is recommended because it supports inline comments and is what `dploy init` generates.

If you are new to `dploy-cli`, start with `dploy init <template>` and customize only the blocks you need.

---

## Quick Annotated Example

```yaml
name: my-app
domain: example.com
versionCommand: "git describe --tags --always"
keepArtifact: false
cleanAfterDeploy: true

build:
  strategy: exclude       # Options: copy | include | exclude | hybrid
  buildDir: build
  exclude:
    - .git/**
    - node_modules/**
    - tests/**
    - "*.md"
  shared:
    - .env
    - storage
  sharedDefaults:
    .env: .env.example

hooks:
  preBuild:
    - npm ci
    - npm run build
  preDeploy:
    - php artisan migrate --force
  postDeploy:
    - sudo systemctl reload php8.4-fpm || sudo systemctl reload php-fpm
    - sudo systemctl reload nginx

database:
  enabled: true
  type: mysql             # Options: mysql | postgres | sqlite
  host: 127.0.0.1
  port: 3306
  name: ${DB_DATABASE:-myapp_prod}
  user: ${DB_USERNAME:-myapp_user}
  password: ${DB_PASSWORD}
  admin_user: ${DB_ROOT_USER:-root}
  admin_password: ${DB_ROOT_PASSWORD}
  keep: 5

environments:
  default:
    port: ${SSH_PORT:-22}
    ssh_key_path: ${SSH_KEY_PATH:-~/.ssh/id_ed25519}
    keepVersions: 5
    healthCheckPath: /health
    healthGate: true
    autoRollback: true
    admin:
      username: root

  production:
    extends: default
    host: ${PROD_HOST}
    username: ${PROD_USER:-deploy}
    deployTo: /var/www/example.com
    baseUrl: https://example.com
    maintenanceMode: true
    env:
      APP_ENV: production
```

---

## 1. Top-Level Properties

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | folder name | Application name (used for default `deployTo` path and systemd service names). |
| `domain` | `string` | - | Primary domain name for Nginx virtual hosts and SSL certificates. |
| `domains` | `string[]` | - | Additional domain names / aliases (e.g. `["example.com", "www.example.com"]`). |
| `versionCommand` | `string` | - | Local shell command used to determine the release version (e.g. `git rev-parse --short HEAD`). |
| `versionFile` | `string` | - | File to read the version from (supports plain text or JSON with a `"version"` field). |
| `logsPath` | `string` | - | Custom log file or directory scanned by `dploy logs` (also supports `logPath` or nested `logs.app`, at top level or per environment). |
| `keepArtifact` | `boolean` | `false` | When `true`, keeps the generated `.tar.gz` file locally after deployment. |
| `cleanAfterDeploy` | `boolean` | `false` | Deletes the temporary `.tar.gz` archive from `<deployTo>/tmp/` after extraction. |
| `maintenanceMode` | `boolean` | `false` | Default maintenance mode toggle during deployments (can be set per-environment). |
| `shared` | `string[]` | `[]` | Top-level shared files/folders (can also be set inside `build.shared`, or per environment for `dploy provision`). |
| `sharedDefaults` | `object` | `{}` | Map of shared file -> template file used to seed it on first deploy (e.g. `.env: .env.example`). |

---

## 2. Build & Packaging (`build`)

The `build` block controls which files from your project are packed into the release `.tar.gz` archive.

### Choosing a Build Strategy

| Strategy | How It Works | Best For |
| :--- | :--- | :--- |
| `exclude` | Packages **everything** in your project except paths in `exclude` (and `.dployignore`). | Simple Node, static, or PHP apps where most files should be uploaded. |
| `include` | Packages **only** files matching `include` glob patterns (minus `exclude`). | Clean builds where you only want `dist/**`, `package.json`, etc. |
| `copy` | Copies explicit `from` -> `to` entries into `buildDir` and packages them. | Custom folder restructuring before upload. |
| `hybrid` | Combines `include` patterns **and** explicit `copy` entries. | **Laravel / CI4** apps (e.g. include `app/**`, `public/**`, plus copy `public/build`). |

### Build Properties

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `strategy` | `string` | `copy` | Packaging strategy: `copy`, `include`, `exclude`, or `hybrid`. |
| `buildDir` | `string` | `dist` | Local temporary staging folder used while assembling the archive. |
| `include` | `string[]` | `[]` | Glob patterns of files to include (`include` and `hybrid` strategies). |
| `exclude` | `string[]` | `[]` | Glob patterns of files/folders to skip (`.dployignore` rules are also applied). |
| `copy` | `array` | `[]` | Explicit copy rules: `{ from: "src", to: "dest", optional: true }`. |
| `shared` | `string[]` | `[]` | Files/directories preserved across releases via symlinks (e.g. `.env`, `storage`, `writable`). |
| `sharedDefaults` | `object` | `{}` | Seed source in the release if the shared file does not exist on the server yet. |
| `cleanAfterDeploy` | `boolean` | `false` | Cleans up temporary uploaded archive after deployment. |

> [!TIP]
> You can also create a `.dployignore` file in your project root (using `.gitignore`-style patterns) to exclude files across all strategies.

---

## 3. Lifecycle Hooks (`hooks`)

Hooks run shell commands automatically at four points in the deployment lifecycle:

| Hook | Where It Runs | Working Directory | Common Uses |
| :--- | :--- | :--- | :--- |
| `preBuild` | **Local machine** | Project root | `npm ci`, `npm run build`, `composer install --no-dev` |
| `postBuild` | **Local machine** | Project root | Sign/verify artifact, notify local tooling |
| `preDeploy` | **Remote server** | `<deployTo>/releases/<version>` | `php artisan migrate --force`, `php artisan config:cache`, `npm ci --omit=dev` |
| `postDeploy` | **Remote server** | `<deployTo>/releases/<version>` | `sudo systemctl reload php8.4-fpm`, `sudo systemctl reload nginx`, `pm2 reload` |

```yaml
hooks:
  preBuild:
    - composer install --no-dev --optimize-autoloader
    - npm ci && npm run build
  preDeploy:
    - php artisan migrate --force
  postDeploy:
    - sudo systemctl reload php8.4-fpm || sudo systemctl reload php-fpm
    - sudo systemctl reload nginx
```

---

## 4. Database Configuration (`database`)

Used by automated pre-deploy snapshots (`--backup-db` or `enabled: true`) and the `dploy db` command suite (`create`, `drop`, `backup`, `restore`, `optimize`, `console`). Can be placed at the top level or overridden per environment.

```yaml
database:
  enabled: true
  type: mysql                     # Options: mysql | postgres | sqlite
  host: ${DB_HOST:-127.0.0.1}
  port: 3306
  name: ${DB_DATABASE:-myapp_prod}
  user: ${DB_USERNAME:-myapp_user}
  password: ${DB_PASSWORD}
  # Optional DB admin credentials (used by `dploy db create` / `drop`, decoupled from SSH admin)
  admin_user: ${DB_ROOT_USER:-root}
  admin_password: ${DB_ROOT_PASSWORD}
  charset: utf8mb4
  collation: utf8mb4_unicode_ci
  keep: 5                         # Retain latest 5 snapshots in <deployTo>/backups/
  # path: /var/www/app/shared/database.sqlite   # Required when type: sqlite
```

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `false` | When `true`, automatically dumps the database before every deploy cutover. |
| `type` | `string` | `mysql` | Database engine: `mysql`, `postgres`, or `sqlite`. |
| `host` | `string` | `127.0.0.1` | Database server host on the remote server. |
| `port` | `number` | `3306` / `5432` | Database server port. |
| `name` | `string` | - | Application database name (falls back to remote `shared/.env` `DB_DATABASE`). |
| `user` | `string` | - | Application database user (falls back to remote `shared/.env` `DB_USERNAME`). |
| `password` | `string` | - | Application database password (falls back to remote `shared/.env` `DB_PASSWORD`). |
| `admin_user` | `string` | `root` / `postgres` | Database admin username (also reads `root_user` or `DB_ROOT_USER`). |
| `admin_password` | `string` | - | Database admin password (also reads `root_password` or `DB_ROOT_PASSWORD`). |
| `charset` | `string` | `utf8mb4` | Character set used by `dploy db create`. |
| `collation` | `string` | `utf8mb4_unicode_ci` | Collation used by `dploy db create`. |
| `path` | `string` | - | Path to SQLite database file (for `type: sqlite`). |
| `keep` | `number` | `5` | Number of backup archives kept in `<deployTo>/backups/`. |
| `extraArgs` | `string[]` | `[]` | Extra CLI flags passed to `mysqldump` / `pg_dump`. |

---

## 5. Server Provisioning (`provision`)

Used by `dploy provision` to prepare directories, permissions, runtime checks, and services. Can be placed at the top level or inside an environment block.

```yaml
provision:
  checkPrerequisites: true
  runtime:
    php: "8.4"
    composer: "2.0"
  dirs:
    - storage/logs
  permissions:
    owner: deploy
    group: www-data
    mode: "755"
    sharedMode: "775"
  service:
    type: systemd
    name: my-app
    action: check   # Options: check | restart | reload | enable
```

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `checkPrerequisites` | `boolean` | `true` | Verifies required remote tools (`tar`, `curl`, configured `runtime`). |
| `runtime` | `object` | `{}` | Map of runtime names and minimum expected versions (e.g. `node: "20"`, `php: "8.4"`). |
| `dirs` | `string[]` | `[]` | Extra subdirectories to ensure under `<deployTo>`. |
| `permissions` | `object` | - | Ownership and modes: `owner`, `group`, `mode` (e.g. `"755"`), `sharedMode` (e.g. `"775"`). |
| `service` / `services` | `object` / `array` | - | Systemd or PM2 services to `check`, `restart`, `reload`, or `enable`. |

---

## 6. Team Notifications (`notifications`)

Send non-blocking alerts to Slack, Discord, Telegram, or custom HTTP webhooks on `start`, `success`, `failure`, and `rollback`. See [Webhooks & Notifications](./notifications.md) for full examples.

---

## 7. Environments (`environments`)

Define one or more target environments (`default`, `staging`, `production`, etc.). Use `extends: default` to share common SSH and health-check settings without repeating them.

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `extends` | `string` | - | Inherit all settings from another environment block (usually `default`). |
| `host` | `string` | - | Single server hostname or IP address. |
| `hosts` | `string[]` | - | Multiple hosts for cluster deployments (`parallel` or `rolling`). |
| `strategy` | `string` | `parallel` | Cluster rollout strategy: `parallel` or `rolling`. |
| `port` | `number` | `22` | SSH port. |
| `username` | `string` | - | Everyday unprivileged SSH deploy user (e.g. `deploy`). |
| `ssh_key_path` | `string` | `~/.ssh/id_rsa` | Path to local SSH private key (`~` is expanded automatically). |
| `ssh_key` | `string` | - | Inline SSH private key string (useful in CI/CD secrets). |
| `password` | `string` | - | SSH password (or `DPLOY_PASSWORD` / `SSH_PASSWORD`). |
| `passphrase` | `string` | - | Passphrase for encrypted SSH private key (or `--passphrase` / `DPLOY_PASSPHRASE`). |
| `deployTo` | `string` | - | Absolute path on the remote server (e.g. `/var/www/example.com`). Must not be `/`. |
| `domain` / `domains` | `string` / `string[]` | - | Environment-specific domain(s) for Nginx/SSL. |
| `keepVersions` | `number` | `5` | Number of previous releases retained on the server. |
| `baseUrl` | `string` | - | Public URL used for post-deploy HTTP health checks. |
| `healthCheckPath` | `string` | `/health` | Path appended to `baseUrl` for the health probe (expects 2xx). |
| `healthCheckTimeout` | `number` | `10000` | Timeout per health check request in milliseconds. |
| `healthCheckRetries` | `number` | `3` | Retry attempts before marking the health check failed. |
| `healthGate` | `boolean` | `true` | Fails the deploy if the health check does not return 2xx. |
| `autoRollback` | `boolean` | `true` | Automatically reverts `current` symlink if `healthGate` fails. |
| `maintenanceMode` | `boolean` | `false` | Enables `dploy down` before cutover and `dploy up` after completion. |
| `admin` | `object` | - | Privileged SSH credentials (`username`, `ssh_key_path`, `password`, `passphrase`, `port`) used by `setup`, `site`, and `-A`. |
| `database` | `object` | - | Environment-specific overrides for the `database` block. |
| `provision` | `object` | - | Environment-specific overrides for the `provision` block. |
| `notifications` | `array` | - | Environment-specific overrides for the `notifications` list. |
| `logsPath` | `string` | - | Custom log file or folder for `dploy logs` (alias: `logPath`, or nested `logs.app`). |
| `env` | `object` | `{}` | Key-value environment variables injected into remote hooks (e.g. `APP_ENV`, `NODE_ENV`). |

---

## 8. Remote Logs Configuration (`logsPath` & `logs.app`)

By default, `dploy logs` (which defaults to `--type app`) scans common framework log directories (`current/writable/logs`, `current/storage/logs`, `shared/logs`, `<deployTo>/logs`). You can point it to a custom directory at **either** the top level or inside an environment (environment-level takes precedence) using `logsPath`, `logPath`, or `logs.app`:

```yaml
# Top-level (applies to all environments unless overridden)
logs:
  app: storage/logs/

environments:
  production:
    host: ${PROD_HOST}
    username: ${PROD_USER:-deploy}
    deployTo: /var/www/example.com
    domain: example.com

    # Option 1: Direct path (relative to current/ or absolute)
    logsPath: storage/logs/

    # Option 2: Nested logs block (supports custom --type keys like `dploy logs --type system`)
    logs:
      app: storage/logs/
      system: storage/system/logs/
      worker: storage/logs/worker.log
```

### How `--type` Maps to Log Sources in `dploy logs`

| Command | Source Used on Remote Server |
| :--- | :--- |
| `dploy logs` *(default `app`)* | Scans `environments.<env>.logsPath` / `logs.app` first, then `current/writable/logs`, `current/storage/logs`, `shared/logs`, `<deployTo>/logs` for `*.log`, `log-*.php`, `*.txt`. |
| `dploy logs --type <custom>` | Looks up `environments.<env>.logs.<custom>` or top-level `logs.<custom>` (e.g., `dploy logs --type system`). |
| `dploy logs --type nginx` | Tails `/var/log/nginx/<domain>.error.log` (red title) and `<domain>.access.log` (blue title), falling back to global `/var/log/nginx/{error,access}.log`. |
| `dploy logs --type pm2` | Streams `pm2 logs <name>`. |
| `dploy logs --type systemd` | Streams `journalctl -u <name>.service`. |

---

## Variable Resolution Hierarchy & Interpolation

1. **Variable Interpolation**: Use `${VAR}` or `${VAR:-default}` anywhere in `deploy.config.yml`. `dploy-cli` loads `.env` first and `.env.dploy` second (`.env.dploy` takes precedence), on top of shell environment variables.
2. **Database & Runtime Parameter Precedence** (highest to lowest):
   1. CLI Flags (`--name`, `--user`, `--host`, `-A`, `--db-root-user`)
   2. Environment block (`environments.<env>.database`, `environments.<env>.admin`)
   3. Top-level config (`database`, `domain`, `logsPath`)
   4. Remote `shared/.env` (`DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`)
   5. System defaults (`127.0.0.1`, port `3306`/`5432`, `utf8mb4`)
