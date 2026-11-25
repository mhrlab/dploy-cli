# Operational Safety: Maintenance Mode, Databases, Logs & Env

`dploy-cli` includes built-in safeguards for production cutovers, database operations, remote log inspection, and environment management.

---

## 1. Maintenance Mode (`dploy down` / `dploy up`)

Implemented in `src/commands/maintenance.ts` and `src/features/maintenance.ts`.

### Ad-Hoc CLI Usage
```bash
dploy down -e production --message "Database upgrade in progress." --retry 300
dploy up -e production
```

### Automatic Deploy Integration
Enable `maintenanceMode: true` in `deploy.config.yml` or pass `--maintenance`:
```bash
dploy deploy -e production --maintenance
```

### How It Works
1. `dploy down` creates `<deployTo>/shared/maintenance.json` and `<deployTo>/shared/maintenance.html` (a dark-themed responsive 503 page).
2. Nginx templates (`templates/services/nginx-*.conf`) check `if (-f {{DEPLOY_TO}}/shared/maintenance.json) { return 503; }` and serve `maintenance.html` with `Retry-After` and `Cache-Control: no-store` headers—no Nginx reload required.
3. `dploy up` (or automatic deploy completion) removes `shared/maintenance.json` and `shared/maintenance.html`.

---

## 2. Database Suite (`dploy db`) & Pre-Deploy Backups

Implemented in `src/commands/database.ts` and `src/features/database-backup.ts`.

### Automated Pre-Deploy Backups
Enable `database.enabled: true` in `deploy.config.yml` or pass `--backup-db`:
```bash
dploy deploy -e production --backup-db
```
- **MySQL / MariaDB**: Runs `mysqldump` into `<deployTo>/backups/db-<version>-<timestamp>.sql.gz`.
- **PostgreSQL**: Runs `pg_dump` into `<deployTo>/backups/db-<version>-<timestamp>.sql.gz`.
- **SQLite**: Runs `sqlite3 <dbPath> ".backup ..."` and compresses to `.sqlite.gz`.
- **Safety Gate**: If the pre-deploy backup fails, `dploy deploy` **aborts before switching `current`**.
- **Pruning**: Retains the latest `database.keep` snapshots (default `5`).

### Database Credentials & `DB_ROOT_USER`
`resolveDatabaseContext()` (`src/commands/database.ts`) resolves DB settings in order:
1. CLI flags (`--name`, `--user`, `--password`, `--db-root-user`, `--db-root-password`)
2. `environments.<env>.database`
3. Top-level `database`
4. `process.env.DB_ROOT_USER` / `process.env.DB_ROOT_PASSWORD` (loaded from `.env.dploy` / `.env`)
5. Remote `<deployTo>/shared/.env` (`DB_CONNECTION`, `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`)
6. Defaults (`127.0.0.1`, port `3306`/`5432`, `utf8mb4`)

> [!TIP]
> SSH admin (`env.admin.username` / `-A`) and database admin (`database.admin_user` / `DB_ROOT_USER`) are decoupled. When a database password is provided, `dploy` authenticates directly with `-u <admin_user> -p'<admin_password>'` instead of wrapping in `sudo -n`.

---

## 3. Remote Logs (`dploy logs`)

Implemented in `src/commands/logs.ts`:
- **App logs**: Scans `logsPath` (if configured), `shared/storage/logs`, `shared/writable/logs`, `shared/logs`, and `current/storage/logs`. If multiple daily logs exist, prompts interactively or auto-selects the newest file with `--latest`.
- **Nginx logs (`--type nginx`)**: Tails both `/var/log/nginx/<domain>.error.log` and `<domain>.access.log` (falling back to global `/var/log/nginx/error.log` and `access.log`).
- **PM2 / Systemd**: `--type pm2` (`pm2 logs`) and `--type systemd` (`journalctl -u <appName>`).

---

## 4. Remote `.env` Management (`dploy env`)

Implemented in `src/commands/env.ts` and `src/features/env-sync.ts`:
- `dploy env push` / `pull` / `set KEY=VALUE`: Uploads (with timestamped backup), downloads, or updates `shared/.env` with `chmod 600`.
- `dploy env edit`: Downloads `shared/.env` to a temp file, opens `$VISUAL` / `$EDITOR` (or `notepad` on Windows / `nano` on Linux/macOS), compares SHA-256 digests, prompts for confirmation, creates a backup, and uploads.
