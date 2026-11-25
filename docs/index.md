# `dploy-cli` Documentation

Welcome to the `dploy-cli` documentation. `dploy-cli` is a zero-downtime deployment CLI built in TypeScript/Node.js that packages applications locally, transfers release archives over SSH/SFTP, manages shared state and permissions, and switches releases atomically via symlinks.

---

## Documentation Map

| Guide | What It Covers |
| :--- | :--- |
| **[Getting Started](./getting-started.md)** | Prerequisites, installation, `dploy init` templates, `.env.dploy` secrets, and first deploy |
| **[Architecture Overview](./architecture/overview.md)** | Layered architecture (`bin/` → `commands/` → `features/` → `core/`), module map, and design decisions |
| **[Deployment Lifecycle](./architecture/deployment-lifecycle.md)** | End-to-end build, upload, SHA-256 verification, shared linking, cutover, health gate, and rollback flow |
| **[CLI Commands Reference](./cli-reference.md)** | Global options, grouped commands, short aliases, hidden legacy aliases, and all flags |
| **[Configuration Guide](./configuration.md)** | Full `deploy.config.yml` / `.json` schema, `extends`, `${VAR:-default}` interpolation, and `.dployignore` |
| **[Server Provisioning & SSL](./server-provisioning.md)** | `dploy provision`, `dploy setup`, `dploy site add`, Cloudflare Origin CA / Flexible SSL, and Laravel permissions |
| **[Cluster Deployments](./cluster-deployments.md)** | Multi-host `parallel` and `rolling` deployment orchestration |
| **[Operational Safety](./operational-safety.md)** | Maintenance mode (`dploy down`/`up`), `dploy db` suite, pre-deploy DB backups, `dploy logs`, and `dploy env` |
| **[Notifications](./notifications.md)** | Non-blocking Slack, Discord, Telegram, and custom webhook alerts |
| **[Development Guide](./development.md)** | Local TypeScript setup, adding commands/options, logger conventions, testing, and CI/CD |
| **[Troubleshooting](./troubleshooting.md)** | Fixes for Cloudflare 521, Laravel `storage`/`bootstrap/cache` permissions, SSH keys, and DB root auth |
