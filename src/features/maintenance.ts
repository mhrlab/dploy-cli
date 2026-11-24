import { Client } from "ssh2";
import { posixJoin, escapeShellArg } from "../core/utils.js";
import { exec } from "../core/ssh.js";

export interface MaintenancePayload {
    enabledAt: string;
    message?: string;
    retryAfter?: number;
}

export function formatMaintenancePayload(opts: { message?: string; retryAfter?: number }): string {
    const payload: MaintenancePayload = {
        enabledAt: new Date().toISOString(),
        message: opts.message || "Site undergoing scheduled maintenance.",
        retryAfter: opts.retryAfter || 300,
    };
    return JSON.stringify(payload, null, 2);
}

/**
 * Generates an aesthetic, responsive maintenance HTML page served directly by Nginx during 503.
 */
export function formatMaintenanceHtml(opts: { message?: string; retryAfter?: number }): string {
    const message = opts.message || "We are currently performing scheduled maintenance. Please check back shortly.";
    const retryAfter = opts.retryAfter || 300;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Under Maintenance</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(255, 255, 255, 0.04);
      --border: rgba(255, 255, 255, 0.1);
      --text: #f3f4f6;
      --muted: #9ca3af;
      --accent: #f59e0b;
      --accent-glow: rgba(245, 158, 11, 0.2);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 1rem;
      padding: 3rem 2.5rem;
      max-width: 540px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(12px);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.85rem;
      border-radius: 9999px;
      background: var(--accent-glow);
      color: var(--accent);
      font-size: 0.85rem;
      font-weight: 600;
      letter-spacing: 0.025em;
      margin-bottom: 1.5rem;
    }
    .badge-dot {
      width: 8px;
      height: 8px;
      background: var(--accent);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--accent);
    }
    h1 {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.025em;
      margin-bottom: 1rem;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p {
      color: var(--muted);
      font-size: 1.05rem;
      line-height: 1.6;
      margin-bottom: 2rem;
    }
    .meta-box {
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 0.85rem 1.25rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.875rem;
      color: #cbd5e1;
      display: flex;
      justify-content: space-between;
      margin-bottom: 2rem;
    }
    .footer {
      font-size: 0.85rem;
      color: #6b7280;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">
      <span class="badge-dot"></span>
      <span>Maintenance Mode</span>
    </div>
    <h1>Under Maintenance</h1>
    <p>${message}</p>
    <div class="meta-box">
      <span>Status: 503 Unavailable</span>
      <span>Estimated return: ${Math.round(retryAfter / 60)} min</span>
    </div>
    <div class="footer">
      Powered by <strong>dploy-cli</strong>
    </div>
  </div>
</body>
</html>`;
}

export async function enableMaintenance(
    ssh: Client,
    deployTo: string,
    opts: { message?: string; retryAfter?: number } = {}
): Promise<string> {
    const sharedDir = posixJoin(deployTo.trim(), "shared");
    const flagPath = posixJoin(sharedDir, "maintenance.json");
    const htmlPath = posixJoin(sharedDir, "maintenance.html");
    const content = formatMaintenancePayload(opts);
    const htmlContent = formatMaintenanceHtml(opts);

    await exec(ssh, `mkdir -p ${escapeShellArg(sharedDir)}`);

    // Write maintenance.json
    const cmd = `cat << 'EOF' > ${escapeShellArg(flagPath)}\n${content}\nEOF`;
    const res = await exec(ssh, cmd);
    if (res.code !== 0) {
        throw new Error(`Failed to create maintenance flag: ${res.stderr || `exit code ${res.code}`}`);
    }

    // Write maintenance.html for direct Nginx 503 response
    const htmlCmd = `cat << 'EOF' > ${escapeShellArg(htmlPath)}\n${htmlContent}\nEOF`;
    await exec(ssh, htmlCmd);

    // Also symlink into current if current exists so web servers or frameworks can inspect it
    const currentLink = posixJoin(deployTo.trim(), "current");
    const currentFlag = posixJoin(currentLink, "down");
    await exec(ssh, `if [ -d ${escapeShellArg(currentLink)} ]; then ln -sfn ${escapeShellArg(flagPath)} ${escapeShellArg(currentFlag)} 2>/dev/null || true; fi`);

    return flagPath;
}

export async function disableMaintenance(ssh: Client, deployTo: string): Promise<void> {
    const sharedFlag = posixJoin(deployTo.trim(), "shared", "maintenance.json");
    const sharedHtml = posixJoin(deployTo.trim(), "shared", "maintenance.html");
    const currentFlag = posixJoin(deployTo.trim(), "current", "down");

    await exec(ssh, `rm -f ${escapeShellArg(sharedFlag)} ${escapeShellArg(sharedHtml)} ${escapeShellArg(currentFlag)} 2>/dev/null || true`);
}

export async function checkMaintenance(ssh: Client, deployTo: string): Promise<MaintenancePayload | null> {
    const flagPath = posixJoin(deployTo.trim(), "shared", "maintenance.json");
    const { stdout, code } = await exec(ssh, `cat ${escapeShellArg(flagPath)} 2>/dev/null || true`);

    if (code !== 0 || !stdout.trim()) {
        return null;
    }

    try {
        return JSON.parse(stdout.trim()) as MaintenancePayload;
    } catch {
        return { enabledAt: "unknown", message: stdout.trim() };
    }
}
