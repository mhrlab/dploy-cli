# dploy-cli

`dploy-cli` is a command-line deployment tool that packages a project locally, uploads the artifact to a remote server over SSH/SFTP, extracts it into a versioned release directory, and switches a `current` symlink to activate the new release.

---

## Table of Contents

* [Installation](#installation)
* [Features](#features)
* [Usage](#usage)
* [Configuration](#configuration)
* [Hooks](#hooks)
* [Logging](#logging)
* [Template Setup](#template-setup)
* [Development Setup](#development-setup)
* [Contributing](#contributing)
* [License](#license)

---

## Installation

To install `dploy-cli` globally, use `npm`:

```bash
npm install -g dploy-cli
```

Alternatively, you can use `npx` to run it without installation:

```bash
npx dploy-cli
```

---

## Features

* **Environment-specific deploys**: Supports multiple environments such as `production` and `staging`.
* **Packaging strategies**: Supports `include`, `exclude`, `copy`, and `hybrid` file selection.
* **Shared paths**: Keeps files like `.env` or `storage` persistent across deployments.
* **Rollback support**: Switch back to an older release from the remote server, or use `--latest` / `--to <version>` for non-interactive rollbacks.
* **Health checks**: Can call a configured health endpoint after deployment.
* **Hooks**: Runs local `preBuild` / `postBuild` hooks and remote `preDeploy` / `postDeploy` hooks.
* **Verbose logging**: Supports `--verbose` and `--debug` output for troubleshooting.
* **Template initialization**: Generates starter config files for Node.js, Laravel, and FastAPI projects.
* **Dry-run mode**: Shows planned build, deploy, and clean actions without changing anything.
* **CLI version flag**: Use `--app-version` to print the tool version.
* **Deploy without build**: Reuse an existing local archive with `--skip-build`.
* **Custom archive upload**: Upload a manually created archive with `--artifact` or `--archive`.
* **Checksum verification**: Verifies SHA256 after upload to catch corrupted transfers.
* **Release metadata**: Writes `deploy-metadata.json` into each release so `list` and `status` can show version, timestamp, commit, and environment.

---

## Usage

After installation, you can run `dploy` commands from the command line.

### Common Commands

* **Initialize the project** (creates `deploy.config.yaml` or `deploy.config.json` from a template):

  ```bash
  dploy init [template]
  ```

  Example:

  ```bash
  dploy init node
  ```

* **Build the project** (prepares files for deployment):

  ```bash
  dploy build -V 1.2.3 --dry-run
  ```

* **Deploy the project** (upload files to the server):

  ```bash
  dploy deploy -e <environment> -V 1.2.3 --dry-run
  dploy deploy -e <environment> --skip-build
  dploy deploy -e <environment> --artifact ./my-release.tar.gz
  dploy deploy -e <environment> --archive ./my-release.tar.gz
  ```

* **Rollback to previous release**:

  ```bash
  dploy rollback
  dploy rollback --latest
  dploy rollback --to v0.1.24-62ef2ff
  dploy rollback --dry-run
  ```

* **List releases on a remote server**:

  ```bash
  dploy list -e production
  ```

  Each release line includes metadata when a `deploy-metadata.json` file is present.

* **Clean old releases**:

  ```bash
  dploy clean -e production --dry-run
  ```

* **Show deployment status**:

  ```bash
  dploy status -e production
  ```

  The status view includes the active release metadata when available.

* **Run a health check**:

  ```bash
  dploy health -e production
  ```

---

## Configuration

The deployment behavior is controlled by one of these config files in the project root:

* `deploy.config.yml`
* `deploy.config.yaml`
* `deploy.config.json`

The loader also reads `.env` from the project root and substitutes `${VAR}` or `${VAR:-fallback}` placeholders anywhere in the config.

### Example `deploy.config.yml`

```yaml
name: Node.js + PM2

build:
  strategy: include
  buildDir: build
  include:
    - dist/**
    - package.json
    - package-lock.json
  exclude:
    - node_modules/**
    - tests/**
  shared:
    - .env
  sharedDefaults:
    .env: .env.example
  copy:
    - from: ecosystem.config.js
      to: build/ecosystem.config.js
  cleanAfterDeploy: true

hooks:
  preBuild:
    - npm ci
  postBuild:
    - npm run build
  preDeploy:
    - echo "Preparing release"
  postDeploy:
    - pm2 restart ecosystem.config.js

environments:
  production:
    host: ${DPLOY_HOST}
    username: ${DPLOY_USER}
    deployTo: /var/www/myapp
    keepVersions: 5
    healthCheckPath: /health
```

### Key Configuration Fields:

* **build.strategy**: Deployment strategy (`include`, `exclude`, `copy`, `hybrid`).
* **build.buildDir**: Output directory used for the staging folder and final tarball.
* **build.include**: Glob patterns to include when using the `include` strategy.
* **build.exclude**: Glob patterns to ignore when using `include` or `exclude`.
* **build.copy**: Copy-specific source and destination entries.
* **build.shared**: Files or directories that are symlinked from the remote `shared` directory.
* **build.sharedDefaults**: Default sources used to seed shared files on first deploy.
* **build.cleanAfterDeploy**: Removes the temporary remote upload directory after deployment.
* **hooks.preBuild / hooks.postBuild**: Run locally before and after packaging.
* **hooks.preDeploy / hooks.postDeploy**: Run remotely after extraction and after activation.
* **environments.*.extends**: Environment inheritance for shared settings.
* **environments.*.ssh_key_path**: Optional path to an SSH private key on disk.

### Environment Variables

You can store sensitive information like hostnames, SSH keys, and user details in `.env`.

Example `.env`:

```env
DPLOY_HOST=myserver.com
DPLOY_USER=deploy
DPLOY_PRIVATE_KEY=~/.ssh/id_rsa
DPLOY_BASE_URL=https://myserver.com
```

These environment variables are used by the config loader to substitute values at runtime.

---

## Hooks

Hooks let you run commands at different points in the deployment lifecycle.

### Available Hooks:

* **preBuild**: Runs locally before packaging starts.
* **postBuild**: Runs locally after the artifact is created.
* **preDeploy**: Runs on the remote server after the release is extracted.
* **postDeploy**: Runs on the remote server after `current` is switched to the new release.

### Example:

In the deployment config:

```json
{
  "hooks": {
    "preBuild": ["npm run clean"],
    "postBuild": ["npm install --production"],
    "preDeploy": ["echo 'Preparing for deployment'"],
    "postDeploy": ["pm2 restart myapp"]
  }
}
```

---

## Logging

The CLI supports two levels of detailed logging to help with debugging and monitoring:

### Verbose Logging (`-v, --verbose`)
Shows step-by-step process information including:
- File operations and transfers
- Directory creation
- Hook execution
- Configuration loading
- SSH connection details
- Command execution progress

### Debug Logging (`-d, --debug`)
Shows technical details including:
- Variable values and configurations
- Command execution details
- File paths and resolutions
- Error details and stack traces
- SSH command output
- Internal state information

### Usage Examples

```bash
# Normal deployment
dploy deploy

# Verbose logging - shows process steps
dploy deploy -v

# Debug logging - shows technical details
dploy deploy -d

# Both verbose and debug (debug includes verbose)
dploy deploy -v -d
```

### Log Output Examples

**Verbose output:**
```
 >: Working directory: /path/to/project
 >: Using environment: production
```

**Debug output:**
```
?: Deploy command started with options: {"env":"production"}
?: SSH connection config: {"host":"server.com","port":22,"username":"deploy","hasPassword":false,"hasPrivateKey":true}
```

### Log Levels

- **Info** (`log.info`): Important user-facing information
- **OK** (`log.ok`): Successful operations
- **Warn** (`log.warn`): Warning messages
- **Error** (`log.err`): Error messages
- **Verbose** (`log.verbose`): Detailed process information (requires `-v` flag)
- **Debug** (`log.debug`): Technical details (requires `-d` flag)

---

## Template Setup

When you run `dploy init <template>`, the CLI copies a starter config from `templates/`.

### Available Templates:

* `node.yaml`
* `node.json`
* `laravel.yaml`
* `laravel.json`
* `fastapi.yaml`

Notes:

* YAML templates can use either `.yml` or `.yaml` as the config filename.
* JSON templates also copy `.env.dploy.example` into the project root.

---

## Development Setup

### Prerequisites:

* Node.js (v18.x or higher)
* npm or yarn
* TypeScript (for development)

### Installation for development:

1. Clone the repository:

   ```bash
   git clone https://github.com/mhrlab/dploy-cli.git
   cd dploy-cli
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the TypeScript files:

   ```bash
   npm run build
   ```

4. Run the tests:

   ```bash
   npm test
   ```

5. Link the package locally for testing:

   ```bash
   npm link
   ```

Now you can run `dploy` from anywhere on your system!

---

## Contributing

We welcome contributions to `dploy-cli`! To get started:

1. Fork the repository
2. Clone your fork:

   ```bash
   git clone https://github.com/mhrlab/dploy-cli.git
   cd dploy-cli
   ```
3. Install dependencies:

   ```bash
   npm install
   ```
4. Make your changes and test them.
5. Submit a pull request with a detailed description of your changes.

---

## License

`dploy-cli` is licensed under the [MIT License](LICENSE).

---
Last updated: 30-08-2025
