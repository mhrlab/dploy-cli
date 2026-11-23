# Cluster & Multi-Server Deployments

`dploy-cli` natively supports distributing deployments across multiple remote servers (e.g. web fleets, worker pools, microservice clusters).

---

## Configuration

Specify `hosts: string[]` under any environment block instead of a single `host`:

```yaml
environments:
  production:
    hosts:
      - 192.168.1.101
      - 192.168.1.102
      - 192.168.1.103
    username: deployer
    deployTo: /var/www/my-cluster-app
    strategy: rolling # or parallel
```

---

## Deployment Strategies

### 1. Parallel Deployment (`strategy: parallel`)
* **Default Mode**: Concurrently connects to all servers via independent SSH/SFTP sessions.
* **Speed**: All uploads, checksum verifications, extractions, hook executions, and symlink cutovers run simultaneously.
* **Best For**:
  - Homogeneous worker nodes.
  - Development / Staging environments.
  - Applications behind a load balancer that can handle brief cutover transitions.

```bash
dploy deploy -e production --strategy parallel
```

### 2. Rolling Deployment (`strategy: rolling`)
* **Zero-Downtime High Availability**: Deploys sequentially to one host at a time:
  1. Uploads and extracts release on `Host 1`.
  2. Runs preDeploy hooks and updates `current` symlink on `Host 1`.
  3. Verifies health endpoint on `Host 1`.
  4. Only upon success, proceeds to `Host 2`, ensuring a portion of the cluster is always available to serve user traffic.
* **Safety**: If a failure or health-check gate fails on any node, the rolling pipeline stops immediately and triggers automatic rollback on that host before touching remaining nodes.
* **Best For**:
  - Production clusters behind an active load balancer (Nginx, AWS ALB, Cloudflare).
  - High-traffic web APIs.

```bash
dploy deploy -e production --strategy rolling
```
