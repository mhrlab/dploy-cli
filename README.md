# dploy-cli

> Fast, secure, zero-downtime deployments for modern web applications.

`dploy-cli` is a production-grade deployment tool that packages applications locally, transfers artifacts over SSH/SFTP, extracts them into atomic release directories, manages persistent shared state, and activates releases using symlink switching. It includes built-in cluster orchestration, automated pre-deploy database backups, maintenance mode, remote log streaming, and team notifications.

---

## Highlights

- ⚡ **Zero-Downtime Atomic Symlink Deployment**: Switch releases instantly with zero downtime.
- 🌐 **Cluster & Multi-Server Support**: Deploy simultaneously across multiple servers in **parallel** or **rolling** mode.
- 🛡️ **Health-Gated Deploys & Auto-Rollback**: Automated post-deploy verification reverts to the previous release on failure.
- 🗄️ **Pre-Deploy Database Snapshots**: Automatically dumps MySQL, PostgreSQL, or SQLite databases before cutover.
- 🚧 **Maintenance Mode Controls**: `dploy down` and `dploy up` toggle maintenance pages automatically or on demand.
- 🔔 **Team Notifications**: Non-blocking webhooks for Slack, Discord, Telegram, and custom APIs.
- 🪄 **Server Provisioning & Setup Wizard**: Generates and configures Nginx, Systemd units, and Certbot SSL certificates.
- 📺 **Remote Shell, Logs & Env**: Stream remote logs (`dploy logs -f`), execute ad-hoc commands (`dploy run`), and manage `.env` files remotely.
- 📦 **Artifact Caching & `.dployignore`**: Skips redundant builds and honors `.dployignore` rules.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Environment Variables & Secrets Setup](#environment-variables--secrets-setup)
- [Core Workflow](#core-workflow)
- [Configuration Summary](#configuration-summary)
- [Documentation Index](#documentation-index)
- [License](#license)

---

## Installation

Install globally via `npm`:

```bash
npm install -g dploy-cli
```

Or run directly without installation via `npx`:

```bash
npx dploy-cli <command>
```

---

## Quick Start

### 1. Initialize Configuration
Generate a starter configuration file for your stack:
```bash
dploy init node      # Node.js / Express / Next.js
dploy init laravel   # PHP / Laravel
dploy init fastapi   # Python / FastAPI
```

### 2. Prepare Remote Server
Prepare directories, shared storage, and permissions idempotently:
```bash
dploy provision -e production
```

### 3. Deploy
Package locally, upload, verify checksums, run hooks, and activate:
```bash
dploy deploy -e production
```

---

## Environment Variables & Secrets Setup

`dploy-cli` automatically loads environment variables into `deploy.config.yml` from two local files:

```
1. .env          (Base application variables)
       │
       ▼
2. .env.dploy    (Deployment overrides & SSH secrets — takes precedence)
```

### 1. Generating `.env.dploy`
When you run `dploy init`, a starter `.env.dploy.example` is created. Copy it to `.env.dploy`:

```bash
cp .env.dploy.example .env.dploy
```

> **Security Tip**: Always add `.env.dploy` to your `.gitignore` so deployment secrets and private keys are never committed to version control (`dploy init` automatically updates `.gitignore` for you).

### 2. Common Variables in `.env.dploy`

```env
# Default deployment environment
DPLOY_ENV=staging

# Common SSH Settings
SSH_PORT=22
SSH_KEY_PATH=~/.ssh/id_ed25519
# DPLOY_PASSPHRASE=your_key_passphrase # If SSH key is passphrase-encrypted

# Staging Server
STAGING_HOST=staging.example.com
STAGING_USER=deploy

# Production Server
PROD_HOST=prod.example.com
PROD_USER=deploy

# Health check base URL
DPLOY_BASE_URL=https://example.com

# Webhook Alert URLs (Optional)
# SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
# DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

### 3. Referencing in `deploy.config.yml`

Use `${VAR}` or fallback syntax `${VAR:-default}` in your configuration file:

```yaml
environments:
  default:
    port: ${SSH_PORT:-22}
    ssh_key_path: ${SSH_KEY_PATH:-~/.ssh/id_rsa}
    deployTo: /var/www/my-app

  staging:
    extends: default
    host: ${STAGING_HOST}
    username: ${STAGING_USER:-deploy}

  production:
    extends: default
    host: ${PROD_HOST}
    username: ${PROD_USER:-deploy}
```

---

## Core Workflow

```
[Local Machine]                            [Remote Server]
 1. Run local preBuild hooks                
 2. Package source into .tar.gz            
 3. Run local postBuild hooks              
 4. Connect via SSH/SFTP  ───────────────>  5. Upload to <deployTo>/tmp/
                                            6. Verify SHA256 checksum
                                            7. Extract to <deployTo>/releases/<version>/
                                            8. Pre-deploy DB backup (optional)
                                            9. Link shared files (.env, storage/)
                                           10. Run remote preDeploy hooks
                                           11. Atomically switch 'current' symlink
                                           12. Run remote postDeploy hooks
                                           13. Verify healthcheck endpoint (GET /health)
                                               └── If unhealthy: Auto-rollback to previous
                                           14. Prune old releases (keep latest N)
```

---

## Configuration Summary

Here is a minimal `deploy.config.yml` example:

```yaml
name: my-app
versionCommand: "git describe --tags --always"

build:
  strategy: exclude
  exclude:
    - .git/**
    - node_modules/**
    - tests/**
  shared:
    - .env
    - storage/

hooks:
  preDeploy:
    - npm ci --omit=dev
  postDeploy:
    - sudo systemctl reload my-app

environments:
  production:
    host: 198.51.100.1
    username: deployer
    deployTo: /var/www/my-app
    keepVersions: 5
    baseUrl: https://example.com
    healthCheckPath: /health
    healthGate: true
    autoRollback: true
```

---

## Documentation Index

Explore comprehensive guides and references in the [`docs/`](./docs) directory:

- 📖 **[CLI Commands Reference](./docs/cli-reference.md)**: Full syntax, arguments, and flags for all 17 CLI commands.
- ⚙️ **[Configuration Guide](./docs/configuration.md)**: Exhaustive schema documentation, hooks, and environment variable expansion.
- 🌐 **[Cluster & Multi-Server Deployments](./docs/cluster-deployments.md)**: Orchestrating parallel and rolling deployments across fleets.
- 🛠️ **[Server Provisioning & Setup Wizard](./docs/server-provisioning.md)**: Preparing fresh servers and configuring Nginx, Systemd, and Certbot.
- 🛡️ **[Operational Safety Guide](./docs/operational-safety.md)**: Maintenance mode controls and automated pre-deploy database snapshots.
- 🔔 **[Webhooks & Notifications](./docs/notifications.md)**: Configuring deployment alerts for Slack, Discord, and Telegram.

---

## Contributing & Development

```bash
# Clone the repository
git clone https://github.com/mhrlab/dploy-cli.git
cd dploy-cli

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run test suite
npm test
```

---

## License

MIT © [Hemant Kumar Meena](https://github.com/mhrlab)
