# dploy-cli

`dploy-cli` is a simple, flexible, and powerful deployment tool designed to handle deployments for various types of projects, including Node.js, PHP, Python, Go, and more. It is **language-agnostic**, meaning it can be adapted to any stack by configuring the right build and deploy strategies.

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

* **Language-Agnostic**: Supports deployments for Node.js, PHP, Python, static websites, and more.
* **Environment-Specific Deployments**: Allows for multiple environment configurations (local, production, staging).
* **File Exclusion and Inclusion**: Flexibly include/exclude files during deployment with glob patterns.
* **Symlink Management**: Keeps your shared files (like `.env`, `storage/`) persistent across deployments.
* **Rollback Support**: Roll back to a previous release with a single command.
* **Health Check**: Optionally set a health check URL for verifying the deployment status.
* **Hooks**: Supports pre/post hooks to run custom commands before and after the build or deploy process.
* **Comprehensive Logging**: Verbose and debug logging for better visibility and troubleshooting.

---

## Usage

After installation, you can run `dploy` commands from the command line.

### Common Commands

* **Initialize the project** (creates `dploy.config.json` and `.env.dploy.example`):

  ```bash
  dploy init <template>
  ```

  Example:

  ```bash
  dploy init node  # Creates a dploy.config.json template
  ```

* **Build the project** (prepares files for deployment):

  ```bash
  dploy build
  ```

* **Deploy the project** (upload files to the server):

  ```bash
  dploy deploy -e <environment>
  ```

* **Rollback to previous release**:

  ```bash
  dploy rollback
  ```

---

## Configuration

The deployment behavior of `dploy-cli` is controlled by a configuration file called `dploy.config.json`. This file defines environments, shared files, deployment directories, and more.

### Example `dploy.config.json`

```json
{
  "buildDir": "build",
  "strategy": "hybrid",
  "include": ["dist/**", "package.json", "package-lock.json"],
  "shared": [".env", "storage"],
  "sharedDefaults": {
    ".env": ".env.example"
  },
  "hooks": {
    "preBuild": ["npm run clean"],
    "postBuild": ["npm install --production"],
    "preDeploy": ["echo 'Preparing for deployment'"],
    "postDeploy": ["pm2 restart myapp"]
  },
  "environments": {
    "production": {
      "host": "${DPLOY_HOST}",
      "username": "${DPLOY_USER}",
      "deployTo": "/var/www/myapp",
      "keepVersions": 5,
      "healthCheckPath": "/health"
    },
    "staging": {
      "host": "${DPLOY_STAGING_HOST}",
      "username": "${DPLOY_STAGING_USER}",
      "deployTo": "/var/www/myapp-staging",
      "keepVersions": 3,
      "healthCheckPath": "/health"
    }
  }
}
```

### Key Configuration Fields:

* **buildDir**: The directory to store built files (e.g., `build` or `dist`).
* **strategy**: Deployment strategy (`include`, `exclude`, `copy`, `hybrid`).
* **include**: List of files/patterns to include in the deployment.
* **exclude**: List of files/patterns to exclude from the deployment.
* **shared**: List of files or directories to be symlinked across releases (e.g., `.env`, `storage`).
* **sharedDefaults**: Default files to copy into the shared directories when they don’t exist.
* **hooks**: Pre/Post hooks for commands to run during different phases (build, deploy).

### Environment Variables

You can store sensitive information like hostnames, SSH keys, and user details in the `.env.dploy` file.

Example `.env.dploy`:

```env
DPLOY_HOST=myserver.com
DPLOY_USER=deploy
DPLOY_PRIVATE_KEY=~/.ssh/id_rsa
DPLOY_BASE_URL=https://myserver.com
```

These environment variables are used by the `dploy.config.json` to substitute values at runtime.

---

## Hooks

Hooks allow you to run commands **before** or **after** the build and deploy processes.

### Available Hooks:

* **preBuild**: Run commands before building the project.
* **postBuild**: Run commands after building the project.
* **preDeploy**: Run commands before deployment. But after tar file extracted.
* **postDeploy**: Run commands after deployment.

### Example:

In the `dploy.config.json`:

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

When you run `dploy init <template>`, `dploy-cli` will automatically create a `dploy.config.json` and a `.env.dploy.example` file based on the selected template (e.g., Node.js, PHP, Django).

### Available Templates:

* **node**
* **laravel**
* **python**
* **static**

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

4. Link the package locally for testing:

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
