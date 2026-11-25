# Troubleshooting & Common Errors

---

## 1. Cloudflare Error 521 (`Web server is down`)

**Symptom:** Site works via `certbot`, but returns **Error 521** when configured with `none` (Plain HTTP) or `cloudflare-flexible`.

**Cause:** Nginx listens only on port `80` in `none` and `cloudflare-flexible` modes, while Cloudflare's **SSL/TLS → Overview** defaults to **Full** or **Full (Strict)** and tries to connect to port `443`.

**Fix:**
- **Recommended:** Switch to `cloudflare-origin` (port `443` with Cloudflare Origin CA cert) and set Cloudflare **SSL/TLS → Overview** to **Full (Strict)**:
  ```bash
  dploy site ssl -e production --ssl cloudflare-origin -A
  ```
- **Alternative (Flexible):** Keep `cloudflare-flexible` and set Cloudflare **SSL/TLS → Overview** to **Flexible** (disable Automatic SSL/TLS if it upgrades to Full).

---

## 2. Laravel `storage/framework/cache/data` or `bootstrap/cache` Permission Denied

**Symptom:**
- `file_put_contents(.../storage/framework/cache/data/...): Failed to open stream: No such file or directory`
- `The .../bootstrap/cache directory must be present and writable.`
- `The stream or file ".../storage/logs/laravel.log" could not be opened in append mode: Permission denied`

**Cause:** The SSH deploy user (`deploy`) extracts files with `2755` / `0755` (`r-x` for group `www-data`), blocking PHP-FPM (`www-data`) from creating cache subdirectories or writing manifests; conversely, `www-data` creates `laravel.log` as `0644`, blocking `deploy` during `php artisan` commands.

**Fix:**
- Upgrade to the latest `dploy-cli`, which automatically scaffolds Laravel `storage` subdirectories and applies `2775` (dirs) / `664` (files) to `shared/storage` and `<releaseDir>/bootstrap/cache` on every deploy.
- In Laravel's `config/logging.php`, add `'permission' => 0664` to the `single` and `daily` channels so newly created log files are group-writable by both `www-data` and `deploy`.

---

## 3. `dploy db` Logs In as `root` Instead of `DB_ROOT_USER`

**Symptom:** `.env.dploy` defines `DB_ROOT_USER` and `DB_ROOT_PASSWORD`, or `database.admin_user` is set, yet `dploy db` attempts `root`.

**Cause & Fix:**
- Ensure `database.admin_user` / `database.admin_password` (or `DB_ROOT_USER` / `DB_ROOT_PASSWORD` in `.env.dploy`) are defined.
- `resolveDatabaseContext()` prioritizes CLI flags → `environments.<env>.database` → `database` → `process.env.DB_ROOT_USER` / `DB_ROOT_PASSWORD` → remote `shared/.env`.

---

## 4. `-d` Flag Behavior (`--debug` vs `--domain`)

**Symptom:** Passing `-d example.com` triggers debug logging instead of setting the domain.

**Cause:** `-d` is the global short flag for `--debug`.

**Fix:** Use `-D, --domain <domain>` on `dploy site` commands (e.g., `dploy site info -D example.com`).

---

## 5. Passphrase-Protected SSH Keys Fail Non-Interactively

**Fix:** Provide the passphrase via CLI flag or `.env.dploy`:
```bash
dploy deploy -e production --passphrase "your-passphrase"
# or in .env.dploy:
DPLOY_PASSPHRASE=your-passphrase
```
