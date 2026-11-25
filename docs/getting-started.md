# Getting Started

This guide walks you through installing `dploy-cli`, initializing a project configuration, preparing a server, and running your first zero-downtime deployment.

---

## Prerequisites

- **Local Machine**:
  - **Node.js** `>= 20.17.0`
  - **SSH key** (recommended) or SSH password access to your target server
- **Remote Server** (Linux VPS, e.g., Ubuntu/Debian):
  - `tar` and `gzip`
  - `nginx` and runtime (`php-fpm`, `node`, etc.) if using `dploy setup` / `dploy site add`
  - `mysqldump` / `pg_dump` / `sqlite3` if using database backups or `dploy db`

---

## Installation

Install globally via `npm`:

```bash
npm install -g dploy-cli
```

Or run without global installation via `npx`:

```bash
npx dploy-cli --app-version
```

---

## 1. Initialize Configuration (`dploy init`)

Run `dploy init` in your project root, or pass a template name directly:

```bash
dploy init node      # Node.js / Express (deploy.config.yml)
dploy init laravel   # PHP / Laravel (deploy.config.yml)
dploy init ci4       # CodeIgniter 4 (deploy.config.yml)
dploy init fastapi   # Python / FastAPI (deploy.config.yml)
dploy init go        # Go binary/service (deploy.config.yml)
dploy init spa       # Static / SPA (deploy.config.yml)
```

`dploy init` performs three actions (`src/commands/init.ts`):
1. Copies the chosen template into `deploy.config.yml` (or `deploy.config.json` for `.json` templates).
2. Copies `templates/.env.dploy.example` to `.env.dploy` if it does not already exist.
3. Updates `.gitignore` so `.env.dploy` and generated build artifacts are not committed.

---

## 2. Configure Secrets in `.env.dploy`

`dploy-cli` loads `.env` first and `.env.dploy` second (`.env.dploy` overrides `.env` when both define the same key):

```bash
cp .env.dploy.example .env.dploy
```

Example `.env.dploy`:

```env
DPLOY_ENV=production
SSH_PORT=22
SSH_KEY_PATH=~/.ssh/id_ed25519
PROD_HOST=198.51.100.10
PROD_USER=deploy
DPLOY_BASE_URL=https://example.com
```

Reference these values in `deploy.config.yml` using `${VAR}` or `${VAR:-default}` fallback syntax.

---

## 3. Prepare the Remote Server

### Option A: Interactive Full Server Wizard (`dploy setup`)
Use `dploy setup` on a fresh VPS to create the `deploy` user, configure passwordless `sudo` rules for Nginx/PHP-FPM/systemd, initialize `<deployTo>/{releases,shared}`, create Nginx vhosts, and configure SSL:

```bash
dploy setup -e production --admin-user root --create-deployer
```

### Option B: Directory & Permission Bootstrap Only (`dploy provision`)
If Nginx and users are already configured, prepare only the release directory layout and permissions:

```bash
dploy provision -e production
```

### Option C: Adding a 2nd Domain to the Same VPS (`dploy site add`)
Use `dploy site add` to configure a new site directory, Nginx vhost, and SSL while skipping user and sudoers creation:

```bash
dploy site add -e production -D second-domain.com --kind php --ssl cloudflare-origin -A
```

---

## 4. Deploy Your Application

Preview first with `--dry-run`, then run the live deployment:

```bash
dploy deploy -e production --dry-run
dploy deploy -e production
```

Or use the short alias:

```bash
dploy d -e production
```
