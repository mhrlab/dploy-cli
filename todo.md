# Project Task List & Issue Tracker: dploy-cli

Last Updated: 2026-10-22
Review Status: In Progress

---

## 1. Critical Build Blockers & Runtime Hazards

- [x] **[CRITICAL] [QUAL-01] Fix TypeScript Compilation Error in `status.ts`**
  - **Location**: `src/features/status.ts:4, 18`
  - **Issue**: `ReleaseInfo` is referenced on line 18 (`releases: ReleaseInfo[];`) but never imported from `./release-metadata.js`. Breaks `tsc` and `npm test` completely.
  - **Fix**: Add `type ReleaseInfo` to the import list from `./release-metadata.js`.

- [x] **[CRITICAL] [SEC-01] Prevent Catastrophic Remote `/tmp` Deletion in `deploy.ts`**
  - **Location**: `src/commands/deploy.ts:27-31, 220-224`
  - **Issue**: `deploy.ts` never validates `env.deployTo`. If `deployTo` is missing or empty, `posixJoin(remoteRoot, "tmp")` resolves to `"/tmp"`. When `cfg.cleanAfterDeploy` runs, it executes `rm -rf "/tmp"` on the remote host as the remote user.
  - **Fix**: Require `if (!env.deployTo || typeof env.deployTo !== "string") throw new Error(...)` before constructing remote paths.

---

## 2. Security Vulnerabilities

- [x] **[HIGH] [SEC-02] Eliminate Shell Command Injection in Remote SSH Executions**
  - **Location**: `src/commands/deploy.ts:170-174`, `src/core/hooks.ts:40`, `src/core/ssh.ts:74`
  - **Issue**: CLI options (`--version`) and remote path strings (`releaseDir`) are concatenated directly into raw shell commands (`mkdir -p "${releaseDir}" && tar -xzf ...`). Special characters or shell metacharacters in version strings allow remote code execution.
  - **Fix**: Enforce strict alphanumeric regex `/^[a-zA-Z0-9._-]+$/` in `detectVersion` / `assertValidVersion`, and sanitize path strings before shell interpolation.

- [x] **[HIGH] [SEC-03] Fix Local Path Traversal in Packaging / Staging**
  - **Location**: `src/features/packager.ts:58-61`, `src/features/strategy.ts:25-32`
  - **Issue**: `copy` strategy entries copy files directly to `path.join(stagingDir, f.to)` without verifying that `f.to` stays inside `stagingDir`. Traversal paths (e.g. `../../target`) can overwrite arbitrary files on the local machine during packaging.
  - **Fix**: Validate that `path.resolve(stagingDir, f.to)` is strictly contained within `path.resolve(stagingDir)` .

- [x] **[MEDIUM] [SEC-04] Disable Dangerous Symlink Dereferencing During Artifact Packaging**
  - **Location**: `src/features/packager.ts:60`
  - **Issue**: `fs.copy(f.from, dest, { dereference: true })` resolves symlinks on the host. Symlinks pointing to sensitive host directories (e.g., `~/.ssh` or `/etc`) get bundled into deployment archives.
  - **Fix**: Set `{ dereference: false }` or validate symlink targets against the project root.

---

## 3. Configuration & Template Schema Alignment

- [x] **[HIGH] [QUAL-02] Align `shared`, `sharedDefaults`, and `cleanAfterDeploy` in YAML Templates vs. `deploy.ts`**
  - **Location**: `src/commands/deploy.ts:98, 107, 185`, `templates/node.yaml:14`, `templates/fastapi.yaml:14`, `templates/laravel.yaml:14`
  - **Issue**: Starter YAML templates place `shared`, `sharedDefaults`, and `cleanAfterDeploy` inside `build:`. `deploy.ts` checks root-level `cfg.shared`, `cfg.sharedDefaults`, and `cfg.cleanAfterDeploy`. As a result, shared symlinking and cleanup are silently skipped for projects using YAML templates.
  - **Fix**: Fallback to `cfg.shared ?? cfg.build?.shared`, `cfg.sharedDefaults ?? cfg.build?.sharedDefaults`, and `cfg.cleanAfterDeploy ?? cfg.build?.cleanAfterDeploy`.

- [x] **[HIGH] [QUAL-03] Align JSON Templates with `cfg.build` Schema**
  - **Location**: `src/features/strategy.ts:7`, `templates/node.json:3-5`, `templates/laravel.json:2-4`
  - **Issue**: `templates/node.json` and `laravel.json` define `strategy`, `include`, and `buildDir` at the root object instead of inside `build:`. `strategy.ts` looks for `cfg.build?.strategy`, falling back to `"copy"` with 0 files found.
  - **Fix**: Update JSON templates to nest build settings under `"build": { ... }` and add defensive fallback in `strategy.ts` (`cfg.build?.strategy ?? cfg.strategy`).

- [x] **[MEDIUM] [QUAL-05] Load `.env.dploy` in `loadConfig`**
  - **Location**: `src/core/config.ts:61-68`
  - **Issue**: Starter files instruct users to copy to `.env.dploy`, and `.gitignore` excludes `.env.dploy`, but `loadDotenv()` only loads `.env`. Any settings placed in `.env.dploy` are ignored.
  - **Fix**: Check for `.env.dploy` first in `loadDotenv()`, then fallback to `.env`.

- [x] **[LOW] [QUAL-09] Fix Logging Field Typo in `strategy.ts`**
  - **Location**: `src/features/strategy.ts:9`
  - **Issue**: Logs `cfg.copy?.length` instead of `cfg.build?.copy?.length`, always printing `copy: 0`.
  - **Fix**: Change `cfg.copy?.length` to `cfg.build?.copy?.length`.

---

## 4. Reliability, Error Handling & Performance

- [x] **[MEDIUM] [QUAL-04] Register Stream `'error'` Event Listeners in `ssh.exec()`**
  - **Location**: `src/core/ssh.ts:58-75`
  - **Issue**: Neither `stream` nor `stream.stderr` handles `'error'` events. Any network interruption or channel fault causes an unhandled Node EventEmitter error, terminating the CLI process immediately and bypassing cleanup handlers.
  - **Fix**: Attach `.on("error", (err) => reject(err))` to `stream` and `stream.stderr`.

- [x] **[MEDIUM] [PERF-01] Eliminate Concurrent SSH Channel Exhaustion in `list` & `status`**
  - **Location**: `src/features/status.ts:31-38`, `src/commands/list.ts:33-40`
  - **Issue**: `Promise.all(dirs.map(readRemoteReleaseMetadata))` opens concurrent `ssh.exec()` channels simultaneously for all releases on the server. If releases exceed OpenSSH `MaxSessions` (typically 10), commands crash with channel open errors.
  - **Fix**: Batch execution with a concurrency limit (e.g., chunk size 3-5) or fetch all release metadata in a single combined remote shell command.

- [x] **[MEDIUM] [PERF-02] Add Abort Timeout to HTTP Health Check**
  - **Location**: `src/commands/health.ts:25`
  - **Issue**: `await fetch(url)` lacks a timeout. If the health check endpoint hangs or deadlocks, `dploy health` hangs indefinitely in CI/CD pipelines.
  - **Fix**: Pass `{ signal: AbortSignal.timeout(env.healthCheckTimeout ?? 10000) }` to `fetch()`.

- [x] **[LOW] [QUAL-06] Clean Up Dead Code and False Warnings in Commander `preAction` Hook**
  - **Location**: `bin/dploy.ts:42-63`
  - **Issue**: Hook loads configuration into `(thisCommand as any).config`, but no command ever reads it. Defaulting to `opts.env = "production"` outputs a false warning (`[HOOK] Error: Environment 'production' not found`) for commands like `dploy build`.
  - **Fix**: Simplify `preAction` to only set logging verbosity, removing the duplicate config loading.

- [x] **[LOW] [QUAL-07] Remove Dead Logger Object `log_new`**
  - **Location**: `src/core/logger.ts:13-25`
  - **Issue**: `log_new` is exported but completely unused across the codebase.
  - **Fix**: Consolidate logger implementation into `log` and remove `log_new`.

- [x] **[LOW] [QUAL-08] Harden Relative Path Resolution for `package.json` and Templates**
  - **Location**: `src/core/utils.ts:57`, `src/commands/init.ts:10`
  - **Issue**: Hardcoded 3-level directory traversal (`../../../package.json`) breaks when running outside standard `dist/` directory nesting.
  - **Fix**: Search upward for root `package.json` or resolve relative to package root dynamically.

---

## 5. Test Coverage Gaps

- [x] **[MEDIUM] Unit Tests for Core Commands**
  - **Location**: `tests/commands.test.ts` (new)
  - **Gap**: Zero automated tests exist for `deploy.ts`, `build.ts`, `rollback.ts`, `list.ts`, `clean.ts`, `status.ts`, `health.ts`, and `init.ts`.
  - **Action**: Add unit tests using mocked SSH/SFTP fixtures to test command branching, option handling, and error exits.

- [x] **[MEDIUM] Unit Tests for Packaging Strategies**
  - **Location**: `tests/strategy.test.ts` (new)
  - **Gap**: Only `include` strategy is tested indirectly. `copy`, `exclude`, and `hybrid` strategies have no dedicated tests.
  - **Action**: Add dedicated tests in `tests/strategy.test.ts` covering globbing, optional copy files, and missing required copy files.

- [x] **[MEDIUM] Unit Tests for Shared Resource Linking**
  - **Location**: `tests/shared.test.ts` (new)
  - **Gap**: `linkShared` in `src/features/shared.ts` is completely untested.
  - **Action**: Test creation of shared directories, seeding from default templates, and symlink replacement logic with mock SSH commands.

---

## 6. Feature Roadmap

### 6.1 Operational & Safety Features
- [x] **Health-Gated Deploys**: Hit health endpoint post-deploy and fail if response is unhealthy.
- [x] **Auto-Rollback on Failed Health Check**: Automatically revert `current` symlink to previous release if health check fails.
- [x] **Deployment Retries**: Retry SSH connect, SFTP upload, and health check on transient network failure.
- [x] **Non-Interactive CI Mode**: Add `--yes` / `--non-interactive` flag to suppress all prompts for CI/CD runs.
- [x] **JSON Output Flag**: Support `--json` on `status` and `list` commands for scripting/piping.
- [x] **Keep Local Artifact Flag**: Add `--keep-artifact` to preserve local `.tar.gz` archive after deployment.

### 6.2 Build & Packaging Enhancements
- [ ] **`.dployignore` Support**: Respect `.dployignore` file for deployment packaging instead of relying solely on config globs.
- [ ] **Alternative Packaging Formats**: Support `.zip` and plain uncompressed directory synchronization.
- [ ] **Artifact Caching**: Skip rebuilding artifact if source files and git SHA have not changed.
- [ ] **Incremental Deploy Mode**: Support delta uploads (rsync-style) for large codebases.

### 6.3 Configuration System Improvements
- [ ] **Config Schema Validation**: Use a schema validator (e.g. Zod or JSON Schema) to provide immediate error messages on missing/invalid config fields.
- [ ] **Base Config File Inheritance**: Support `extends` across separate config files (e.g. `deploy.base.yml`), not just across environment blocks.
- [ ] **Template Placeholder Substitution in Hooks**: Allow hooks to interpolate `${RELEASE_DIR}`, `${VERSION}`, `${PREVIOUS_RELEASE}`.

---

## 7. Feature Spec: `dploy provision`

### Goal
[x] Add a dedicated command (`dploy provision` / alias `dploy setup-server`) to prepare a fresh server for deployments in an idempotent manner without polluting the core deploy flow.

### Command Options
- `-e, --env <env>`: Target environment (default: `production`).
- `-n, --dry-run`: Preview planned server changes without executing.
- `--force`: Re-run all steps even if directories/files exist.
- `--skip-checks`: Skip prerequisite verification (tar, curl, runtime).
- `--only <step>`: Run a specific provisioning step (`prereqs`, `dirs`, `shared`, `permissions`, `service`).
- `--json`: Output machine-readable JSON status.

### Configuration Schema (`provision` block in `deploy.config.yml`)
```yaml
environments:
  production:
    host: ${DPLOY_HOST}
    username: ${DPLOY_USER}
    deployTo: /var/www/myapp
    keepVersions: 5
    provision:
      enabled: true
      createDirs: true
      configurePermissions: true
      seedShared: true
      checkPrerequisites: true
      dirs:
        - releases
        - shared
        - tmp
        - logs
      permissions:
        owner: deploy
        group: www-data
        mode: "755"
        sharedMode: "775"
      runtime:
        node: "20"
      service:
        type: systemd
        name: myapp
```

### Implementation Details
- [x] **Core Provisioning & Feature Engine**: Implemented `src/features/provisioner.ts` with prerequisite checks (`tar`, `curl`, configured runtimes), remote directory layout creation, shared directory/file seeding, permission and ownership enforcement, and systemd / PM2 service verification.
- [x] **Command CLI Integration**: Implemented `src/commands/provision.ts` with alias `setup-server` in `bin/dploy.ts`, supporting `--dry-run`, `--force`, `--skip-checks`, `--only <step>`, and `--json`.
- [x] **Offline Dry-Run & Safe Validation**: Refuses root `/` provisioning, ensures safe argument escaping via `escapeShellArg`, and supports offline dry-run when remote host is not reachable.
- [x] **Starter Templates & Types**: Updated `src/core/config.ts` with TypeScript interfaces and added default provisioning config to `templates/node.yaml`.
- [x] **Automated Test Suite**: Added comprehensive unit tests in `tests/provision.test.ts` covering live execution, `--only` filtering, prerequisite failures, and offline dry-run JSON output.

## 8. Bugs
### Implementation 
- [x] fix options conflict for Inconsistent `-e/--env` Add `.option("-e, --env <env>", "Target environment (default: production)")` to all environment-specific commands (`deploy`, `rollback`, `status`, `clean`, `list`, `health`).
- [x] fix option conflict for duplicate archive flags. `deploy` has `--artifact <path>` AND `-A,` `--archive <path>`. Two different flags doing the exact same thing clutters CLI documentation and autocomplete.

---

## 9. Comprehensive Bug & Issue Fixes (Review & Hardening)

### 9.1 Tier 1: Critical Safety & Runtime Cutover
- [x] **[CRITICAL] [SEC-01] Validate `deployTo` in `clean.ts` to Prevent Remote Root Deletion**
  - **Location**: `src/commands/clean.ts:17`
  - **Issue**: Unvalidated `deployTo` defaults to `"/releases"` and deletes `/releases` on root server filesystem.
  - **Fix**: Require `deployTo` exists, is non-empty, and is not `"/"`.

- [x] **[CRITICAL] [QUAL-01] Surface Symlink Cutover Failures in `deploy.ts` and `rollback.ts`**
  - **Location**: `src/core/ssh.ts:236-245`, `src/commands/deploy.ts:253`, `src/commands/rollback.ts:108`
  - **Issue**: `switchCurrentSymlink` exit codes are ignored; failed cutovers report success.
  - **Fix**: Make `switchCurrentSymlink` throw an `Error` on non-zero exit code and clean up temporary symlinks on fallback.

- [x] **[HIGH] [QUAL-02] Check Return Codes on Critical Remote Commands in `shared.ts` and `ssh.ts`**
  - **Location**: `src/features/shared.ts:19, 105`, `src/core/ssh.ts:228`
  - **Issue**: `mkdir -p`, `ln -sfn`, and `removePath` ignore exit codes, silently proceeding on failure.
  - **Fix**: Check `code === 0` on all critical remote executions and throw on error.

- [x] **[MEDIUM] [QUAL-04] Fix Open SSH Socket Leak on SFTP Connect Failure**
  - **Location**: `src/core/ssh.ts:39-56`
  - **Issue**: If `sftp.connect` fails, the `ssh` client socket is never closed.
  - **Fix**: Add try/catch around `sftp.connect` to close `ssh` if SFTP initialization fails.

### 9.2 Tier 2: Security & Shared Resource Hardening
- [x] **[HIGH] [SEC-02] Prevent Path Traversal in `shared` Configuration Items**
  - **Location**: `src/features/shared.ts:25-28`, `src/features/provisioner.ts:240-275`
  - **Issue**: Unvalidated shared items (e.g. `.` or `..`) can delete the release directory or arbitrary paths.
  - **Fix**: Validate each shared item to ensure it is relative, does not escape root, and is not `.` or `..`.

- [x] **[HIGH] [QUAL-03] Prevent Data Overwrite Hazard in `shared.ts` Fallback**
  - **Location**: `src/features/shared.ts:88`
  - **Issue**: Fallback `cp -r` overwrites existing files in `shared/` with release defaults.
  - **Fix**: Use non-clobbering sync (`rsync -a --ignore-existing` or explicit file check).

- [x] **[MEDIUM] [SEC-04] Prevent Prototype Pollution in Config Loader**
  - **Location**: `src/core/config.ts:153-157, 165-181`
  - **Issue**: `deepMerge` and `substituteEnv` do not guard against `__proto__`, `constructor`, `prototype`.
  - **Fix**: Filter dangerous object keys.

- [x] **[MEDIUM] [SEC-05] Tighten Version Validation Regex Against Directory Traversal**
  - **Location**: `src/core/utils.ts:27-31`
  - **Issue**: Regex matches `.` and `..`.
  - **Fix**: Require version to start with alphanumeric and forbid `.` and `..`.

### 9.3 Tier 3: CLI Polish, Performance & Consistency
- [x] **[MEDIUM] [QUAL-06] Fix `init` Skipping `.env.dploy.example` for YAML Templates**
  - **Location**: `src/commands/init.ts:70-84`
  - **Issue**: Only copies `.env.dploy.example` when `ext === ".json"`.
  - **Fix**: Remove `ext === ".json"` check.

- [x] **[MEDIUM] [PERF-01] Replace Synchronous Blocking I/O in Async Call Paths**
  - **Location**: `src/core/config.ts:217`, `src/core/utils.ts:93, 118`, `src/features/packager.ts:110`
  - **Issue**: `readFileSync` and `statSync` block the event loop.
  - **Fix**: Use non-blocking async `fs` methods.

- [x] **[MEDIUM] [PERF-02] Read `package.json` Directly Without Subprocess in `detectVersion`**
  - **Location**: `src/core/utils.ts:42`
  - **Issue**: `safeExec("node -p ...")` spawns node process with 150ms latency and requires node in PATH.
  - **Fix**: Read `./package.json` directly from disk.

- [x] **[MEDIUM] [PERF-03] Eliminate Redundant 4th HTTP Probe in Health Check Catch Block**
  - **Location**: `src/commands/health.ts:41-47`
  - **Issue**: Catch block executes an extra probe adding up to 10s delay on failures.
  - **Fix**: Retain last attempt result within `withRetry`.

- [x] **[LOW] [QUAL-07] Fix Syntax Typo in Interactive Rollback UI**
  - **Location**: `src/commands/rollback.ts:71`
  - **Issue**: Stray `\"` in template string.
  - **Fix**: Remove `\"`.

- [x] **[LOW] [QUAL-08] Fix Typo in `tsconfig.json` Include Path**
  - **Location**: `tsconfig.json:13`
  - **Issue**: Lists `"dploy.config.json"`.
  - **Fix**: Update to `"deploy.config.json"`.

---

## 10. Future Feature Roadmap & Architecture Ideas

### 10.1 Web Server & Service Provisioning Wizard (`dploy setup`)
Interactive server onboarding for fresh VPS/Ubuntu/Debian instances to configure web servers, process managers, and reverse proxies automatically.
- [ ] **Interactive Onboarding Prompts (`src/commands/setup.ts`)**
  - [ ] Web server selection: Nginx (default), Apache, None.
  - [ ] App type selection: Static/SPA (`current/dist`), Node.js (reverse proxy to port), PHP/Laravel (PHP-FPM socket), Python/Go/Docker.
  - [ ] Domain / hostname inputs (e.g. `app.example.com`, `example.com`).
  - [ ] Upstream port or PHP-FPM socket path input.
  - [ ] Automated SSL / Let's Encrypt prompt (`certbot --nginx -d <domain>`).
- [ ] **Template Engine & Config Generation (`templates/services/`)**
  - [ ] Nginx virtual host templates for SPA, Node.js proxy, and PHP-FPM with security headers, gzip, and static asset caching.
  - [ ] Systemd unit file generator (`/etc/systemd/system/<app>.service`) with auto-restart, logging, and environment file loading.
  - [ ] PM2 ecosystem generation if user selects PM2.
- [ ] **Remote Installation & Execution Workflow**
  - [ ] Check installed binaries via SSH (`which nginx`, `which certbot`, `which node`).
  - [ ] Install missing dependencies via `apt-get` if prompted/permitted by user (`sudo apt update && sudo apt install -y nginx`).
  - [ ] Upload and enable virtual hosts (`/etc/nginx/sites-available/<domain>` -> `/etc/nginx/sites-enabled/`).
  - [ ] Validate Nginx config (`nginx -t`) before issuing reload (`systemctl reload nginx`).
  - [ ] Add `--dry-run` flag to display generated service configurations without executing on remote host.

---

### 10.2 Remote Environment & Secret Synchronization (`dploy env:*`)
Eliminate the need to manually SSH into remote servers to edit `.env` files with nano/vim.
- [x] **`dploy env:push`**
  - [x] Support flags `-e <env>`, `--file <local-path>` (defaults to `.env.<env>` or `.env`).
  - [x] Safely upload to `<deployTo>/shared/.env`.
  - [x] Prompt for confirmation before overwriting unless `--force` / `--yes` is specified.
  - [x] Automatic remote backup: rename old `.env` to `.env.bak.<timestamp>` before replacing.
- [x] **`dploy env:pull`**
  - [x] Download `<deployTo>/shared/.env` to local file (e.g. `.env.<env>.remote` or `.env`).
  - [x] Add safety check to prevent overwriting local `.env` without `--force`.
- [x] **`dploy env:set KEY=VALUE`**
  - [x] Parse remote `.env`, update or append the specific key-value pair, and save back to `<deployTo>/shared/.env`.

---

### 10.3 Direct Remote Shell & Command Runner (`dploy ssh` & `dploy run`)
Direct CLI shortcuts for remote server administration without manually looking up credentials or IP addresses.
- [x] **`dploy ssh -e <env>`**
  - [x] Read environment configuration (host, user, port, key/password).
  - [x] Spawn native interactive SSH session (`child_process.spawn("ssh", [...])`) or pty forward.
  - [x] Automatically set starting working directory to `<deployTo>/current`.
- [x] **`dploy run "<command>" -e <env>`**
  - [x] Execute arbitrary ad-hoc remote commands inside `<deployTo>/current` (e.g. `dploy run "php artisan migrate --force"` or `dploy run "npm run db:migrate"`).
  - [x] Stream stdout/stderr in real time to local console.

---

### 10.4 Automated Database Backups Pre-Deployment (`backupBeforeDeploy`)
Guard against destructive schema migrations by taking snapshots before switching traffic.
- [ ] **Config Schema Extension in `DeployConfig`**
  - [ ] Add `database?: { type: "mysql" | "postgres" | "sqlite", name?: string, keep?: number }` or `backupBeforeDeploy?: boolean`.
- [ ] **Backup Execution in Deployment Pipeline**
  - [ ] Execute `mysqldump` or `pg_dump` over SSH into `<deployTo>/backups/db-<version>-<timestamp>.sql.gz`.
  - [ ] Retain latest N database backups (matching `keepVersions`).
  - [ ] Abort deployment and alert user if backup fails before release cutover.

---

### 10.5 Deployment Notifications & Webhooks (Slack, Discord, Telegram)
Real-time alerts on deployment status, failures, and rollbacks for engineering teams.
- [ ] **Notification Configuration in `deploy.config.yml`**
  - [ ] Support channels: `slack`, `discord`, `telegram`, or generic HTTP `webhook`.
  - [ ] Event triggers: `on: [start, success, failure, rollback]`.
- [ ] **Payload Dispatcher (`src/features/notifications.ts`)**
  - [ ] Send rich embed/payload containing version, git commit, commit message, deployer, environment, duration, and status.
  - [ ] Non-blocking execution so notification failure never blocks or fails a deployment.

---

### 10.6 Maintenance Mode Controls (`dploy down` / `dploy up`)
Gracefully take websites offline during major upgrades or database schema changes.
- [ ] **`dploy down -e <env>`**
  - [ ] Create maintenance flag file (`<deployTo>/shared/maintenance.flag` or `current/down`).
  - [ ] Support custom message, retry-after header, or maintenance HTML template.
- [ ] **`dploy up -e <env>`**
  - [ ] Remove maintenance flag file to immediately restore normal traffic.
- [ ] **Integration with Deployment Pipeline**
  - [ ] Add option `maintenanceMode: true` in `deploy.config.yml` to automatically toggle `down` before hooks and `up` after healthcheck passes.

---

### 10.7 Live Remote Log Streaming (`dploy logs`)
Stream server, application, and error logs directly to the local terminal.
- [x] **`dploy logs -e <env>`**
  - [x] Support flags: `-f, --follow` (tail live), `-n <lines>` (default 50), `--type <app|nginx|pm2|systemd>`.
  - [x] Execute remote `tail -n 50 -f <logPath>` over SSH stream and pipe output locally with timestamps.

---

### 10.8 Multi-Server / Cluster Deployments
Support deploying to multiple web/worker instances for scalable architectures.
- [ ] **Config Schema Support for Multiple Hosts**
  - [ ] Allow `hosts: string[]` under `environments.<name>` in addition to single `host`.
- [ ] **Deployment Strategies**
  - [ ] Parallel deployment across all hosts.
  - [ ] Rolling deployment (deploy host 1 -> health check -> deploy host 2) for zero downtime on clusters without taking all nodes offline.


