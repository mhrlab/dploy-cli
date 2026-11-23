# Configuration Guide (`deploy.config.yml`)

`dploy-cli` is configured via `deploy.config.yml`, `deploy.config.yaml`, or `deploy.config.json` in the root of your project.

---

## Full Schema Example

```yaml
name: my-app
versionCommand: "git describe --tags --always"
keepArtifact: false
cleanAfterDeploy: true

# Local Build Configuration
build:
  strategy: exclude      # Options: copy, include, exclude, hybrid
  buildDir: dist         # Staging directory for artifact creation
  exclude:
    - .git/**
    - node_modules/**
    - tests/**
    - "*.md"
  shared:
    - .env
    - storage/
    - uploads/
  sharedDefaults:
    .env: ".env.example"

# Lifecycle Hooks
hooks:
  preBuild:
    - npm run lint
    - npm run build
  postBuild: []
  preDeploy:
    - npm ci --omit=dev
    - npm run db:migrate
  postDeploy:
    - sudo systemctl reload my-app

# Automated Database Backups
database:
  enabled: true
  type: postgres         # Options: mysql, postgres, sqlite
  name: myapp_prod
  user: postgres
  keep: 5

# Team Notifications
notifications:
  - channel: slack
    url: ${SLACK_WEBHOOK_URL}
    on: [start, success, failure, rollback]
  - channel: discord
    url: ${DISCORD_WEBHOOK_URL}
    on: [failure, rollback]
  - channel: telegram
    token: ${TELEGRAM_BOT_TOKEN}
    chatId: ${TELEGRAM_CHAT_ID}
    on: [success, failure]

# Target Environments
environments:
  staging:
    host: 192.168.1.100
    port: 22
    username: deployer
    deployTo: /var/www/my-app-staging
    keepVersions: 3
    baseUrl: https://staging.example.com
    healthCheckPath: /health

  production:
    # Multi-host cluster deployment
    hosts:
      - 10.0.0.10
      - 10.0.0.11
    strategy: rolling     # Options: parallel, rolling
    port: 22
    username: deployer
    ssh_key_path: ~/.ssh/id_ed25519
    deployTo: /var/www/my-app
    keepVersions: 5
    maintenanceMode: true
    baseUrl: https://example.com
    healthCheckPath: /api/health
    healthCheckTimeout: 8000
    healthCheckRetries: 3
    healthGate: true
    autoRollback: true
```

---

## Configuration Properties

### Top-Level Properties

| Property | Type | Description |
| :--- | :--- | :--- |
| `name` | `string` | Application name. |
| `versionCommand` | `string` | Shell command executed locally to detect the version (e.g. `git rev-parse --short HEAD`). |
| `versionFile` | `string` | File to read version from (e.g. `package.json`, `VERSION`, `composer.json`). |
| `keepArtifact` | `boolean` | If true, preserves local `.tar.gz` archive in project root. |
| `cleanAfterDeploy` | `boolean` | Deletes remote temporary upload files after extraction. |
| `build` | `object` | Build and packaging options. |
| `hooks` | `object` | Lifecycle execution hooks. |
| `database` | `object` | Pre-deploy database backup configuration. |
| `notifications` | `array` | Notification webhook configurations. |
| `environments` | `object` | Map of deployment environments. |

---

### Environment Properties (`environments.<name>`)

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `host` | `string` | - | Primary SSH hostname or IP. |
| `hosts` | `string[]` | - | List of target hostnames/IPs for cluster deployments. |
| `strategy` | `string` | `parallel` | Cluster strategy (`parallel` or `rolling`). |
| `port` | `number` | `22` | SSH port. |
| `username` | `string` | - | SSH user. |
| `password` | `string` | - | SSH password (can also be read from `DPLOY_PASSWORD` or `SSH_PASSWORD`). |
| `passphrase` | `string` | - | Passphrase for encrypted private key (or CLI `--passphrase`, or `DPLOY_PASSPHRASE`). |
| `ssh_key` | `string` | - | Raw SSH private key string. |
| `ssh_key_path` | `string` | `~/.ssh/id_rsa` | Path to SSH private key file. |
| `deployTo` | `string` | - | Absolute path on remote server for deployments (must not be root `/`). |
| `keepVersions` | `number` | `5` | Number of previous releases to retain. |
| `baseUrl` | `string` | - | Base URL for post-deploy HTTP health checking. |
| `healthCheckPath`| `string` | `/health` | Relative path to probe for 2xx response. |
| `healthCheckTimeout` | `number` | `10000` | Health check timeout in milliseconds. |
| `healthCheckRetries` | `number` | `3` | Number of retry attempts on failure. |
| `healthGate` | `boolean` | `true` | If true, fails deployment if health check returns non-2xx. |
| `autoRollback` | `boolean` | `true` | If health check fails, automatically reverts `current` symlink. |
| `maintenanceMode`| `boolean` | `false` | Automatically toggle `dploy down` before cutover and `dploy up` after. |

---

## Environment Variable Interpolation

`dploy-cli` supports `${VARIABLE}` expansion inside your config file. Values can be provided in your shell environment, `.env`, or `.env.dploy`:

```yaml
environments:
  production:
    host: ${PROD_SERVER_IP}
    username: ${DEPLOY_USER}
    password: ${DEPLOY_PASSWORD}
```
