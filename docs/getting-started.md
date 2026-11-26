# Getting Started (Beginner's Step-by-Step Guide)

This guide takes you from zero to a live, HTTPS-enabled zero-downtime deployment—even if this is your first time deploying with `dploy-cli`.

---

## What You Need Before Starting

1. **On your computer (local):**
   - **Node.js `20.17.0` or newer** (`node -v`)
   - An **SSH key** (recommended) or SSH login credentials for your server
2. **On your server (Linux VPS, e.g., Ubuntu/Debian):**
   - `nginx` (and `php8.4-fpm` for Laravel/PHP, or `node` for Node.js apps)
   - `tar` and `gzip` (pre-installed on almost every Linux server)

---

## Step 1: Install `dploy-cli`

Install globally so the `dploy` command is available in every project:

```bash
npm install -g dploy-cli
```

Verify the installation:

```bash
dploy --app-version
```

---

## Step 2: Initialize Your Project (`dploy init`)

Open your project folder in the terminal and run:

```bash
dploy init
```

Or pick a starter template directly:

```bash
dploy init laravel   # PHP / Laravel + Vite
dploy init ci4       # CodeIgniter 4 + Nginx
dploy init node      # Node.js + PM2 / systemd
dploy init fastapi   # Python / FastAPI
dploy init go        # Go binary
dploy init spa       # React / Vue / Static SPA
```

This creates:
1. **`deploy.config.yml`** — tells `dploy` what files to build, which folders to keep shared (`.env`, `storage`), and which server to deploy to.
2. **`.env.dploy.example`** — a template for your private server IP, SSH user, and passwords.
3. Updates **`.gitignore`** so secrets and build archives are never committed to Git.

---

## Step 3: Add Your Server Details in `.env.dploy`

Copy the example secrets file:

```bash
cp .env.dploy.example .env.dploy
```

Edit `.env.dploy` with your actual server IP and SSH user:

```env
DPLOY_ENV=production
SSH_PORT=22
SSH_KEY_PATH=~/.ssh/id_ed25519

PROD_HOST=203.0.113.10
PROD_USER=deploy
DPLOY_BASE_URL=https://example.com
```

> [!TIP]
> `dploy` reads `.env` first and `.env.dploy` second. Anything in `.env.dploy` overrides `.env`, so you can keep deployment credentials separate from your app's `.env`.

---

## Step 4: Set Up the Server (First Time Only)

You have three ways to prepare your server depending on what is already installed:

### A. Fresh VPS (Configure Nginx, SSL & `deploy` User)
Run the interactive setup wizard:

```bash
dploy setup -e production --admin-user root --create-deployer
```

The wizard asks you simple questions (app type: Node/PHP/SPA, domain name, PHP socket—default `php8.4-fpm.sock`, and SSL: Certbot / Cloudflare Origin CA / Cloudflare Flexible / Plain HTTP) and configures everything automatically.

### B. Adding a 2nd Website/Domain to the Same VPS
If your `deploy` user and sudo rules already exist on that VPS, use `dploy site add`:

```bash
dploy site add -e production -D second-site.com --kind php --ssl certbot -A
```

### C. Nginx Already Configured? (Directories & Permissions Only)
If you already configured Nginx yourself and only want `dploy` to create `<deployTo>/releases`, `shared`, and permissions:

```bash
dploy provision -e production
```

---

## Step 5: Preview & Deploy (`--dry-run` -> Live)

Always preview your first deploy with `--dry-run`—it checks your config and shows every step without touching the server:

```bash
dploy deploy -e production --dry-run
```

When everything looks good, run the live deploy (you can also use the short alias `dploy d`):

```bash
dploy deploy -e production
```

### What Happens During `dploy deploy`?
1. Runs your local `preBuild` hooks (like `composer install` or `npm run build`).
2. Packs your app into a `.tar.gz` archive.
3. Uploads it to `<deployTo>/tmp/` over SFTP and verifies the SHA-256 checksum.
4. Extracts into a new folder `<deployTo>/releases/<version>/` (and fixes Laravel `bootstrap/cache` permissions automatically).
5. Links `shared/.env` and `shared/storage` into the new release.
6. Runs `preDeploy` hooks (like `php artisan migrate --force`).
7. Switches the `current` symlink atomically—zero downtime.
8. Runs `postDeploy` hooks (like reloading PHP-FPM / Nginx) and checks your health URL.

---

## Step 6: Useful Day-to-Day Commands

```bash
dploy status -e production          # Check which release is currently live (alias: dploy st)
dploy list -e production            # List all deployed releases on server (alias: dploy ls)
dploy logs -e production -f         # Stream live application logs
dploy env edit -e production        # Edit remote .env safely in your local editor
dploy rollback -e production        # Instantly switch back to an earlier release (alias: dploy rb)
```

If you get stuck, check the **[Troubleshooting Guide](./troubleshooting.md)**.
