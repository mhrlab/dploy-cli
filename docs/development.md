# Development Guide

This guide covers local development, project conventions, adding commands or options, running tests, and CI/CD workflows.

---

## Local Setup

```bash
git clone https://github.com/mhrlab/dploy-cli.git
cd dploy-cli
npm install
npm run build
npm test
```

- **Node.js**: `>= 20.17.0` (`package.json`)
- **Module System**: ESM (`"type": "module"`). Relative imports in TypeScript source files **must** use `.js` extensions (e.g., `import { log } from "../core/logger.js";`).
- **Build Output**: `tsc` compiles `bin/` and `src/` + `tests/` into `dist/`.

---

## Adding or Modifying Commands

1. **Create or update the handler** in `src/commands/<name>.ts`.
   - Accept an options object typed cleanly in TypeScript.
   - Use `log` from `src/core/logger.ts` (`info`, `ok`, `warn`, `err`, `spinner`, `verbose`, `debug`). Never interpolate raw secrets into strings outside `redactSecrets`-protected logger calls.
   - Support `--dryRun` previews before executing destructive or remote state-changing actions.
2. **Register the command** in `bin/dploy.ts`:
   - Use `lazyAction(() => import("../src/commands/<name>.js"), "<exportName>")` so startup stays fast.
   - Reuse `withDryRun(cmd)`, `withJson(cmd)`, and `withAdminAuth(cmd)` instead of duplicating option definitions.
   - Do **not** re-declare global flags (`-e, --env`, `-v, --verbose`, `-d, --debug`, `-q, --quiet`, `-y, --yes`, `--passphrase`); read them via `cmd.optsWithGlobals()`.
   - Add new root commands to `ROOT_COMMAND_GROUPS` in `bin/dploy.ts` so they appear under the right section in `dploy --help`.
   - Avoid `-d` on subcommands (reserved globally for `--debug`; use `-D, --domain` for domains).

---

## Testing Strategy

`dploy-cli` uses Node's built-in test runner (`node --test`) via `scripts/run-tests.js`:

```bash
npm test   # Runs `npm run build && node scripts/run-tests.js`
```

- `scripts/run-tests.js` discovers `dist/tests/**/*.test.js` and runs them sequentially (`--test-concurrency=1`).
- **Unit & Mock SSH Tests**: Most feature/command tests mock SSH `Client` / `exec` and use temporary directories (`os.tmpdir()`).
- **CLI Integration Tests**: `tests/cli-flags.test.ts` and `tests/commands.test.ts` execute `node dist/bin/dploy.js` directly to verify `--help` output, flag parsing, and exit codes.

---

## CI/CD Workflows

- **[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)**: Runs on push and PR to `master`, `main`, and `develop` across `ubuntu-latest`, `windows-latest`, and `macos-latest` on Node `20.x` and `22.x` (`npm ci`, `npm run build`, `npm test`).
- **[`.github/workflows/release.yml`](../../.github/workflows/release.yml)**: Handles automated release publishing.
