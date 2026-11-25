# Server Provisioning, Setup & SSL Guide

`dploy-cli` automates server directory preparation, Nginx virtual host generation, systemd services, SSL configuration, and framework permission healing over SSH.

---

## 1. Choosing the Right Command

| Command | When to Use | Creates User & Sudoers? | Configures Nginx, Systemd & SSL? |
| :--- | :--- | :--- | :--- |
| `dploy setup` | First-time setup of a VPS or app | Yes (`--create-deployer` / `/etc/sudoers.d/`) | Yes |
| `dploy site add` | Adding a 2nd+ domain/app to an existing VPS | **No** (skips user & sudoers) | Yes |
| `dploy provision` | Bootstrapping directories, shared paths & permissions only | No | No (directories/permissions only) |
| `dploy site ssl` | Switching SSL mode on an existing Nginx site | No | Updates Nginx SSL & Certbot |

---

## 2. Idempotent Directory Provisioning (`dploy provision`)

`src/commands/provision.ts` & `src/features/provisioner.ts` prepare:

```text
<deployTo>/
├── releases/       # Versioned release directories
├── shared/         # Persistent files/dirs (.env, storage/, writable/)
├── current -> ...  # Atomic symlink to active release
├── backups/        # Database snapshots
└── tmp/            # Temporary upload staging
```

```bash
dploy provision -e production
dploy provision -e staging --dry-run
dploy provision --only dirs
```

Supported `--only` steps: `prereqs`, `dirs`, `shared`, `permissions`, `service`.

---

## 3. Full Server Wizard (`dploy setup`) & Multi-Site (`dploy site add`)

Both commands use `src/commands/setup.ts` and `src/features/server-wizard.ts`.

### Interactive Mode
```bash
dploy setup -e production --admin-user root --create-deployer
```

### Non-Interactive Examples
- **PHP / Laravel with Cloudflare Origin CA:**
  ```bash
  dploy setup -e production --webserver nginx --kind php --domain example.com \
    --php-socket /run/php/php8.3-fpm.sock --ssl cloudflare-origin \
    --cf-cert ./origin.pem --cf-key ./origin.key --admin-user root --create-deployer
  ```
- **Adding a 2nd Domain to the Same VPS (`dploy site add`):**
  ```bash
  dploy site add -e production -D second-domain.com --kind php --ssl certbot -A
  ```
- **Node.js Reverse Proxy with Systemd:**
  ```bash
  dploy setup -e production --webserver nginx --kind node --domain api.example.com \
    --port 3000 --service --exec-start "node dist/server.js" --ssl certbot --admin-user root
  ```

---

## 4. SSL Modes & Cloudflare Integration

`dploy-cli` supports four SSL modes (`SslMode` in `src/features/server-wizard.ts`):

| `dploy` Mode | Nginx Port | Cloudflare Dashboard SSL/TLS Mode | Notes |
| :--- | :--- | :--- | :--- |
| `certbot` | `443` (Let's Encrypt) | **Full** or **Full (Strict)** | Runs `certbot --nginx --redirect`. |
| `cloudflare-origin` | `443` (Origin CA cert) | **Full (Strict)** *(Recommended for proxied sites)* | Restores visitor IP via `CF-Connecting-IP` and redirects HTTP `80` → `443`. |
| `cloudflare-flexible` | `80` only | **Flexible** | Restores visitor IP and forwards `HTTPS`/`X-Forwarded-Proto` hints to PHP/Node. |
| `none` | `80` only | **Flexible** (if proxied) or DNS-only | Plain HTTP. |

> [!WARNING]
> **Avoiding Cloudflare Error 521 (Web Server Is Down):**
> If your domain is proxied through Cloudflare (orange cloud) and Cloudflare's **SSL/TLS → Overview** is set to **Full** or **Full (Strict)**, Cloudflare connects to your VPS on port `443`. If your Nginx site uses `none` or `cloudflare-flexible` (port `80` only), port `443` refuses the connection and Cloudflare returns **Error 521**. Either set Cloudflare to **Flexible** or switch `dploy` to `cloudflare-origin` / `certbot` via `dploy site ssl`.

### Getting a Cloudflare Origin Certificate (`cloudflare-origin`)
1. Open **Cloudflare Dashboard** → select your domain → **SSL/TLS → Origin Server**.
2. Click **Create Certificate** (keep *Generate private key and CSR with Cloudflare*, RSA 2048).
3. Ensure hostnames include `yourdomain.com` and `*.yourdomain.com`, then click **Create**.
4. Copy both the **Origin Certificate** (`PEM`) and **Private Key** (shown once).
5. Set **Cloudflare Dashboard → SSL/TLS → Overview** to **Full (Strict)**.

`dploy setup` and `dploy site ssl` also print these steps automatically when `cloudflare-origin` is chosen.

---

## 5. Automatic Framework Permissions (Laravel & CodeIgniter 4)

In zero-downtime deployments, the SSH deploy user (`deploy`) extracts releases while PHP-FPM runs as `www-data`. To prevent `Permission denied` errors on web requests and `artisan` commands:

- **`linkShared()` (`src/features/shared.ts`)**:
  - When `storage` (Laravel) or `writable` (CodeIgniter 4) is in `shared`, missing subdirectories are synced into `shared/` even without a trailing slash.
  - Automatically ensures standard Laravel directories exist (`app/public`, `framework/cache/data`, `framework/sessions`, `framework/views`, `logs`) and standard CI4 directories exist (`cache`, `logs`, `session`, `uploads`, `debugbar`).
  - Applies group-writable permissions (`2775` on directories, `664` on files) on `shared/storage` and `shared/writable`.
- **Release Extraction (`src/commands/deploy.ts`)**:
  - Automatically applies `2775` (directories) and `664` (files) to `<releaseDir>/bootstrap/cache` if present.
- **Laravel `laravel.log` tip**:
  - If `www-data` creates a brand-new `storage/logs/laravel.log`, PHP-FPM's default umask creates it as `0644`. Adding `'permission' => 0664` to your `single` and `daily` channels in Laravel's `config/logging.php` ensures the `deploy` user can also append to rotated logs.
