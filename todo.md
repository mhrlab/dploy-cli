# Project Task List & Issue Tracker: dploy-cli

Last Updated: 2026-10-22
Review Status: In Progress

---

## 1. Critical Build Blockers & Runtime Hazards

- [x] **[CRITICAL] [QUAL-01] Fix TypeScript Compilation Error in `status.ts`**
  - **Location**: `src/features/status.ts:4, 18`
  - **Issue**: `ReleaseInfo` is referenced on line 18 (`releases: ReleaseInfo[];`) but never imported from `./release-metadata.js`. Breaks `tsc` and `npm test` completely.
  - **Fix**: Add `type ReleaseInfo` to the import list from `./release-metadata.js`.

- [ ] **[CRITICAL] [SEC-01] Prevent Catastrophic Remote `/tmp` Deletion in `deploy.ts`**
  - **Location**: `src/commands/deploy.ts:27-31, 220-224`
  - **Issue**: `deploy.ts` never validates `env.deployTo`. If `deployTo` is missing or empty, `posixJoin(remoteRoot, "tmp")` resolves to `"/tmp"`. When `cfg.cleanAfterDeploy` runs, it executes `rm -rf "/tmp"` on the remote host as the remote user.
  - **Fix**: Require `if (!env.deployTo || typeof env.deployTo !== "string") throw new Error(...)` before constructing remote paths.

---

## 2. Security Vulnerabilities

- [ ] **[HIGH] [SEC-02] Eliminate Shell Command Injection in Remote SSH Executions**
  - **Location**: `src/commands/deploy.ts:170-174`, `src/core/hooks.ts:40`, `src/core/ssh.ts:74`
  - **Issue**: CLI options (`--version`) and remote path strings (`releaseDir`) are concatenated directly into raw shell commands (`mkdir -p "${releaseDir}" && tar -xzf ...`). Special characters or shell metacharacters in version strings allow remote code execution.
  - **Fix**: Enforce strict alphanumeric regex `/^[a-zA-Z0-9._-]+$/` in `detectVersion` / `assertValidVersion`, and sanitize path strings before shell interpolation.

- [ ] **[HIGH] [SEC-03] Fix Local Path Traversal in Packaging / Staging**
  - **Location**: `src/features/packager.ts:58-61`, `src/features/strategy.ts:25-32`
  - **Issue**: `copy` strategy entries copy files directly to `path.join(stagingDir, f.to)` without verifying that `f.to` stays inside `stagingDir`. Traversal paths (e.g. `../../target`) can overwrite arbitrary files on the local machine during packaging.
  - **Fix**: Validate that `path.resolve(stagingDir, f.to)` is strictly contained within `path.resolve(stagingDir)`.

- [ ] **[MEDIUM] [SEC-04] Disable Dangerous Symlink Dereferencing During Artifact Packaging**
  - **Location**: `src/features/packager.ts:60`
  - **Issue**: `fs.copy(f.from, dest, { dereference: true })` resolves symlinks on the host. Symlinks pointing to sensitive host directories (e.g., `~/.ssh` or `/etc`) get bundled into deployment archives.
  - **Fix**: Set `{ dereference: false }` or validate symlink targets against the project root.

---

## 3. Configuration & Template Schema Alignment

- [ ] **[HIGH] [QUAL-02] Align `shared`, `sharedDefaults`, and `cleanAfterDeploy` in YAML Templates vs. `deploy.ts`**
  - **Location**: `src/commands/deploy.ts:98, 107, 185`, `templates/node.yaml:14`, `templates/fastapi.yaml:14`, `templates/laravel.yaml:14`
  - **Issue**: Starter YAML templates place `shared`, `sharedDefaults`, and `cleanAfterDeploy` inside `build:`. `deploy.ts` checks root-level `cfg.shared`, `cfg.sharedDefaults`, and `cfg.cleanAfterDeploy`. As a result, shared symlinking and cleanup are silently skipped for projects using YAML templates.
  - **Fix**: Fallback to `cfg.shared ?? cfg.build?.shared`, `cfg.sharedDefaults ?? cfg.build?.sharedDefaults`, and `cfg.cleanAfterDeploy ?? cfg.build?.cleanAfterDeploy`.

- [ ] **[HIGH] [QUAL-03] Align JSON Templates with `cfg.build` Schema**
  - **Location**: `src/features/strategy.ts:7`, `templates/node.json:3-5`, `templates/laravel.json:2-4`
  - **Issue**: `templates/node.json` and `laravel.json` define `strategy`, `include`, and `buildDir` at the root object instead of inside `build:`. `strategy.ts` looks for `cfg.build?.strategy`, falling back to `"copy"` with 0 files found.
  - **Fix**: Update JSON templates to nest build settings under `"build": { ... }` and add defensive fallback in `strategy.ts` (`cfg.build?.strategy ?? cfg.strategy`).

- [ ] **[MEDIUM] [QUAL-05] Load `.env.dploy` in `loadConfig`**
  - **Location**: `src/core/config.ts:61-68`
  - **Issue**: Starter files instruct users to copy to `.env.dploy`, and `.gitignore` excludes `.env.dploy`, but `loadDotenv()` only loads `.env`. Any settings placed in `.env.dploy` are ignored.
  - **Fix**: Check for `.env.dploy` first in `loadDotenv()`, then fallback to `.env`.

- [ ] **[LOW] [QUAL-09] Fix Logging Field Typo in `strategy.ts`**
  - **Location**: `src/features/strategy.ts:9`
  - **Issue**: Logs `cfg.copy?.length` instead of `cfg.build?.copy?.length`, always printing `copy: 0`.
  - **Fix**: Change `cfg.copy?.length` to `cfg.build?.copy?.length`.

---

## 4. Reliability, Error Handling & Performance

- [ ] **[MEDIUM] [QUAL-04] Register Stream `'error'` Event Listeners in `ssh.exec()`**
  - **Location**: `src/core/ssh.ts:58-75`
  - **Issue**: Neither `stream` nor `stream.stderr` handles `'error'` events. Any network interruption or channel fault causes an unhandled Node EventEmitter error, terminating the CLI process immediately and bypassing cleanup handlers.
  - **Fix**: Attach `.on("error", (err) => reject(err))` to `stream` and `stream.stderr`.

- [ ] **[MEDIUM] [PERF-01] Eliminate Concurrent SSH Channel Exhaustion in `list` & `status`**
  - **Location**: `src/features/status.ts:31-38`, `src/commands/list.ts:33-40`
  - **Issue**: `Promise.all(dirs.map(readRemoteReleaseMetadata))` opens concurrent `ssh.exec()` channels simultaneously for all releases on the server. If releases exceed OpenSSH `MaxSessions` (typically 10), commands crash with channel open errors.
  - **Fix**: Batch execution with a concurrency limit (e.g., chunk size 3-5) or fetch all release metadata in a single combined remote shell command.

- [ ] **[MEDIUM] [PERF-02] Add Abort Timeout to HTTP Health Check**
  - **Location**: `src/commands/health.ts:25`
  - **Issue**: `await fetch(url)` lacks a timeout. If the health check endpoint hangs or deadlocks, `dploy health` hangs indefinitely in CI/CD pipelines.
  - **Fix**: Pass `{ signal: AbortSignal.timeout(env.healthCheckTimeout ?? 10000) }` to `fetch()`.

- [ ] **[LOW] [QUAL-06] Clean Up Dead Code and False Warnings in Commander `preAction` Hook**
  - **Location**: `bin/dploy.ts:42-63`
  - **Issue**: Hook loads configuration into `(thisCommand as any).config`, but no command ever reads it. Defaulting to `opts.env = "production"` outputs a false warning (`[HOOK] Error: Environment 'production' not found`) for commands like `dploy build`.
  - **Fix**: Simplify `preAction` to only set logging verbosity, removing the duplicate config loading.

- [ ] **[LOW] [QUAL-07] Remove Dead Logger Object `log_new`**
  - **Location**: `src/core/logger.ts:13-25`
  - **Issue**: `log_new` is exported but completely unused across the codebase.
  - **Fix**: Consolidate logger implementation into `log` and remove `log_new`.

- [ ] **[LOW] [QUAL-08] Harden Relative Path Resolution for `package.json` and Templates**
  - **Location**: `src/core/utils.ts:57`, `src/commands/init.ts:10`
  - **Issue**: Hardcoded 3-level directory traversal (`../../../package.json`) breaks when running outside standard `dist/` directory nesting.
  - **Fix**: Search upward for root `package.json` or resolve relative to package root dynamically.

---

## 5. Test Coverage Gaps

- [ ] **[MEDIUM] Unit Tests for Core Commands**
  - **Location**: `tests/commands.test.ts` (new)
  - **Gap**: Zero automated tests exist for `deploy.ts`, `build.ts`, `rollback.ts`, `list.ts`, `clean.ts`, `status.ts`, `health.ts`, and `init.ts`.
  - **Action**: Add unit tests using mocked SSH/SFTP fixtures to test command branching, option handling, and error exits.

- [ ] **[MEDIUM] Unit Tests for Packaging Strategies**
  - **Location**: `tests/strategy.test.ts` (new)
  - **Gap**: Only `include` strategy is tested indirectly. `copy`, `exclude`, and `hybrid` strategies have no dedicated tests.
  - **Action**: Add dedicated tests in `tests/strategy.test.ts` covering globbing, optional copy files, and missing required copy files.

- [ ] **[MEDIUM] Unit Tests for Shared Resource Linking**
  - **Location**: `tests/shared.test.ts` (new)
  - **Gap**: `linkShared` in `src/features/shared.ts` is completely untested.
  - **Action**: Test creation of shared directories, seeding from default templates, and symlink replacement logic with mock SSH commands.

---

## 6. Feature Roadmap

### 6.1 Operational & Safety Features
- [ ] **Health-Gated Deploys**: Hit health endpoint post-deploy and fail if response is unhealthy.
- [ ] **Auto-Rollback on Failed Health Check**: Automatically revert `current` symlink to previous release if health check fails.
- [ ] **Deployment Retries**: Retry SSH connect, SFTP upload, and health check on transient network failure.
- [ ] **Non-Interactive CI Mode**: Add `--yes` / `--non-interactive` flag to suppress all prompts for CI/CD runs.
- [ ] **JSON Output Flag**: Support `--json` on `status` and `list` commands for scripting/piping.
- [ ] **Keep Local Artifact Flag**: Add `--keep-artifact` to preserve local `.tar.gz` archive after deployment.

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
Add a dedicated command (`dploy provision` / alias `dploy setup-server`) to prepare a fresh server for deployments in an idempotent manner without polluting the core deploy flow.

### Command Options
- `-e, --env <env>`: Target environment (default: `production`).
- `-n, --dry-run`: Preview planned server changes without executing.
- `--force`: Re-run all steps even if directories/files exist.
- `--skip-checks`: Skip prerequisite verification (tar, curl, runtime).
- `--only <step>`: Run a specific provisioning step (`dirs`, `shared`, `permissions`, `runtime`, `service`, `health`).
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

### Planned Implementation Phases
1. **Phase 1: Core Provisioning**: `src/commands/provision.ts`, base directory creation, shared seeding, permission application, dry-run mode.
2. **Phase 2: Prerequisite Checks & Idempotency**: Verify remote binaries (`tar`, `curl`, `node`), safe non-destructive checks, `--json` output.
3. **Phase 3: Service & Web Server Integration**: Systemd / PM2 service templates and nginx config generation.
4. **Phase 4: Starter Templates & Documentation**: Update `templates/` and `README.md` with provisioning defaults.
