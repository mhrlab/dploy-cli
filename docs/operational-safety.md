# Operational Safety: Maintenance Mode & Database Backups

Safety features in `dploy-cli` protect your production infrastructure from broken releases, failed migrations, and transient downtime.

---

## 1. Maintenance Mode (`dploy down` / `dploy up`)

Gracefully take your application offline before major updates or database schema migrations, and return to service once verified.

### Ad-Hoc CLI Commands
```bash
# Take site down with custom message and retry header
dploy down -e production --message "System upgrade in progress. Back shortly." --retry 300

# Bring site back online
dploy up -e production
```

### Automatic Pipeline Integration
Configure `maintenanceMode: true` in `deploy.config.yml` or pass `--maintenance` during deployment:
```bash
dploy deploy -e production --maintenance
```

**How it works**:
1. Before preDeploy hooks execute, `dploy` writes `<deployTo>/shared/maintenance.flag` and `<deployTo>/current/down`.
2. Traffic is diverted to a maintenance page (Nginx can be configured to check for `maintenance.flag`).
3. Deploy completes, symlink is switched, and post-deploy health check passes.
4. Maintenance flag is removed automatically.

---

## 2. Automated Pre-Deploy Database Backups

Avoid data corruption during destructive schema migrations by taking automated snapshots before traffic is switched.

### Configuration
```yaml
database:
  enabled: true
  type: postgres     # mysql | postgres | sqlite
  name: production_db
  user: db_user
  keep: 5            # Retain latest 5 database snapshots
```

### CLI Flag Override
```bash
dploy deploy -e production --backup-db
```

### Backup Execution
- **Postgres**: Executes `pg_dump` into `<deployTo>/backups/db-<version>-<timestamp>.sql.gz`.
- **MySQL / MariaDB**: Executes `mysqldump` into `<deployTo>/backups/db-<version>-<timestamp>.sql.gz`.
- **SQLite**: Safely uses `sqlite3 <dbPath> ".backup ..."` into `<deployTo>/backups/`.
- **Pruning**: Automatically prunes older database backups based on `database.keep`.
- **Safety Gate**: If the database dump fails, **the deployment aborts immediately** before code is activated.
