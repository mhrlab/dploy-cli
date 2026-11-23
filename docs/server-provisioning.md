# Server Provisioning & Setup Wizard

`dploy-cli` provides built-in automation to prepare brand new servers and generate production service configurations without third-party dependencies like Ansible or Docker.

---

## 1. Idempotent Server Provisioning (`dploy provision`)

Prepares remote directories, configures access permissions, creates shared directories, and verifies runtime prerequisites.

```bash
# Provision default production environment
dploy provision

# Target specific environment with dry-run
dploy provision -e staging --dry-run

# Run only a specific step
dploy provision --only dirs
dploy provision --only permissions
dploy provision --only shared
```

### Directory Structure Created
```text
<deployTo>/
├── releases/       # Versioned deployment directories
├── shared/         # Persistent files (.env, storage/, logs/)
├── current -> ...  # Symlink to the currently active release
├── backups/        # Pre-deploy database snapshots
└── tmp/            # Staging directory for incoming archives
```

---

## 2. Interactive Server Wizard (`dploy setup`)

The `setup` command generates, uploads, and configures system services directly on your target server.

### Sudo & Admin User Support

Since configuring Nginx, Systemd services, and Certbot SSL requires root privileges, `dploy setup` supports connecting as an admin/root user:

1. **Via CLI flags**:
   ```bash
   dploy setup --admin-user root --admin-key ~/.ssh/id_rsa --create-deployer
   ```
2. **Via Configuration (`deploy.config.yml`)**:
   ```yaml
   environments:
     production:
       host: 198.51.100.1
       username: deployer          # Everyday unprivileged deploy user
       deployTo: /var/www/my-app
       admin:
         username: root            # Used ONLY by dploy setup
         ssh_key_path: ~/.ssh/id_admin
   ```
3. **Automated Deployer User Provisioning (`--create-deployer`)**:
   When `--create-deployer` is passed:
   - Creates the unprivileged `deployer` user on the remote server.
   - Copies your local public SSH key to `/home/deployer/.ssh/authorized_keys`.
   - Sets directory ownership of `/var/www/my-app` to `deployer:www-data`.
   - Configures a secure `/etc/sudoers.d/dploy-<app>` rule allowing passwordless service reloads (`systemctl reload nginx`, `systemctl restart <app>`).

### Interactive Mode
Run `dploy setup` without arguments to walk through an interactive configuration prompt:
```bash
dploy setup
```

### Automated / CI CLI Flags

#### Nginx Reverse Proxy (Node.js, Python, Go)
```bash
dploy setup --service nginx --type proxy --domain api.example.com --upstream 3000 --certbot
```
- Generates `/etc/nginx/sites-available/<app>.conf`.
- Sets up HTTP proxy pass, WebSockets (`Upgrade` and `Connection` headers), and security headers.
- Tests configuration with `nginx -t` over SSH.
- Enables site via symlink to `sites-enabled/` and reloads Nginx.

#### Nginx Static / Single Page App (SPA)
```bash
dploy setup --service nginx --type spa --domain app.example.com --certbot
```
- Configures `try_files $uri $uri/ /index.html` for client-side routing (React, Vue, Svelte, Angular).

#### Nginx PHP-FPM (Laravel, Symfony, WordPress)
```bash
dploy setup --service nginx --type php --domain example.com --certbot
```
- Sets root to `<deployTo>/current/public`.
- Configures PHP fastcgi socket (`/run/php/php-fpm.sock`).

#### Systemd Background Service
```bash
dploy setup --service systemd
```
- Generates `/etc/systemd/system/<app>.service`.
- Runs `systemctl daemon-reload` and enables the service on boot.

#### Laravel Background Queue Worker
```bash
dploy setup --service laravel-worker
```
- Sets up automated background worker executing `php <deployTo>/current/artisan queue:work --sleep=3 --tries=3 --max-time=3600`.
