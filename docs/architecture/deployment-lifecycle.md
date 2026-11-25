# Deployment Lifecycle & Data Flow

This document traces what happens internally when `dploy deploy` runs (`src/commands/deploy.ts`).

---

## End-to-End Sequence

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer / CI
    participant CLI as dploy deploy
    participant Local as Local Build & Hooks
    participant SSH as Remote Host (SSH/SFTP)
    participant Health as HTTP Health Endpoint
    participant Hooks as Webhooks (Slack/Discord/Telegram)

    Dev->>CLI: dploy deploy -e production
    CLI->>CLI: Load config + .env + .env.dploy
    CLI->>Hooks: Dispatch "start" (non-blocking)

    alt Build enabled (not --skip-build / --artifact)
        CLI->>Local: Run hooks.preBuild
        CLI->>Local: Resolve files (strategy + .dployignore)
        CLI->>Local: Package .tar.gz + compute SHA-256
        CLI->>Local: Run hooks.postBuild
    end

    loop For each target host (parallel or rolling)
        CLI->>SSH: Connect & ensure releases/shared/tmp/backups dirs
        CLI->>SSH: Upload .tar.gz to <deployTo>/tmp/
        CLI->>SSH: Verify SHA-256 checksum remotely
        CLI->>SSH: Extract into <deployTo>/releases/<version>/
        CLI->>SSH: Fix permissions on bootstrap/cache (2775/664)

        opt database.enabled or --backup-db
            CLI->>SSH: Dump DB to <deployTo>/backups/ (abort on failure)
        end

        opt maintenanceMode or --maintenance
            CLI->>SSH: Write shared/maintenance.json & maintenance.html
        end

        CLI->>SSH: linkShared() -> sync & symlink .env, storage, etc.
        CLI->>SSH: Run hooks.preDeploy inside releaseDir
        CLI->>SSH: Switch "current" symlink atomically
        CLI->>SSH: Run hooks.postDeploy inside releaseDir

        opt maintenanceMode or --maintenance
            CLI->>SSH: Remove maintenance files
        end

        opt baseUrl configured
            CLI->>Health: GET <baseUrl><healthCheckPath> (with retries)
            alt Health check fails & healthGate=true
                CLI->>SSH: Rollback "current" to previous release
                CLI->>Hooks: Dispatch "rollback" / "failure"
            end
        end

        CLI->>SSH: Write deploy-metadata.json & prune old releases
    end

    CLI->>Hooks: Dispatch "success"
```

---

## Step-by-Step Breakdown

1. **Configuration & Version Resolution (`src/core/config.ts`, `src/core/utils.ts`)**:
   - Loads `deploy.config.yml` / `.yaml` / `.json`, resolves `extends` inheritance, and interpolates `${VAR:-default}` from `.env` and `.env.dploy`.
   - Resolves release version in priority order: `--version-override` / `-V` → `versionCommand` → `versionFile` → `VERSION` → `composer.json` → `package.json` → timestamp fallback.
2. **Artifact Resolution (`src/features/deploy-artifact.ts`, `src/features/packager.ts`)**:
   - Uses `--artifact <path>` (custom archive), `--skip-build` (latest matching `release-*.tar.gz`), or builds a new archive using `build.strategy` (`copy`, `include`, `exclude`, `hybrid`) while honoring `.dployignore`.
3. **Upload & Checksum Gate (`src/core/ssh.ts`, `src/features/checksum.ts`)**:
   - Uploads archive to `<deployTo>/tmp/` with live byte progress (`src/core/progress.ts`) and verifies SHA-256 remotely before extracting.
4. **Release Extraction & Framework Permission Healing (`src/commands/deploy.ts`, `src/features/shared.ts`)**:
   - Extracts archive into `<deployTo>/releases/<version>/`.
   - If `bootstrap/cache` exists, applies `2775` (directories) and `664` (files) so PHP-FPM (`www-data`) and the deploy user can both write compiled manifests.
   - `linkShared()` initializes or syncs shared paths into `<deployTo>/shared/`, scaffolds standard subdirectories for `storage` (Laravel) and `writable` (CodeIgniter 4), applies `2775`/`664` permissions on `storage` and `writable`, removes the release's local copy, and creates the symlink.
5. **Atomic Cutover & Health Gate (`src/core/ssh.ts`, `src/commands/health.ts`)**:
   - Captures the previous `current` target before switching.
   - Switches `<deployTo>/current` atomically.
   - If `baseUrl` is configured, polls `<baseUrl><healthCheckPath>` with retries. When `healthGate` and `autoRollback` are enabled, a failed probe automatically restores `current` to the previous release.
6. **Metadata & Cleanup (`src/features/release-metadata.ts`, `src/features/cleaner.ts`)**:
   - Writes `deploy-metadata.json` (version, environment, timestamp, git SHA/branch/commit message, deployer).
   - Prunes old releases beyond `keepVersions`.
