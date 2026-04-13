import path from "node:path";
import { posixJoin } from "../core/utils.js";
import { exec, listDirs, SSHBundle } from "../core/ssh.js";

export type RemoteRelease = {
    name: string;
    mtime: Date;
};

export type RemoteStatus = {
    envName: string;
    host?: string;
    username?: string;
    deployTo: string;
    currentTarget: string | null;
    currentRelease: string | null;
    releases: RemoteRelease[];
    lastDeployAt: Date | null;
};

function formatDateTime(value: Date): string {
    return value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export async function collectRemoteStatus(
    bundle: SSHBundle,
    envName: string,
    deployTo: string
): Promise<RemoteStatus> {
    const releasesDir = posixJoin(deployTo, "releases");
    const currentLink = posixJoin(deployTo, "current");

    const releases = (await listDirs(bundle.sftp, releasesDir)).sort(
        (a, b) => b.mtime.getTime() - a.mtime.getTime()
    );

    const { stdout } = await exec(bundle.ssh, `readlink -f "${currentLink}" || true`);
    const currentTarget = stdout.trim() || null;
    const currentRelease = currentTarget ? path.posix.basename(currentTarget) : null;
    const lastDeployAt = releases[0]?.mtime ?? null;

    return {
        envName,
        deployTo,
        currentTarget,
        currentRelease,
        releases,
        lastDeployAt,
    };
}

export function formatRemoteStatus(status: RemoteStatus): string[] {
    const lines: string[] = [];
    const releaseLabel = status.currentRelease ?? "none";
    const lastDeployLabel = status.lastDeployAt ? formatDateTime(status.lastDeployAt) : "unknown";

    lines.push(`Active environment: ${status.envName}`);
    if (status.username || status.host) {
        lines.push(`Server: ${[status.username, status.host].filter(Boolean).join("@")}`);
    }
    lines.push(`Deploy path: ${status.deployTo}`);
    lines.push(`Current release: ${releaseLabel}`);
    lines.push(`Last deploy: ${lastDeployLabel}`);
    lines.push(`Available releases (${status.releases.length}):`);

    if (!status.releases.length) {
        lines.push("  - none");
        return lines;
    }

    for (const release of status.releases) {
        const marker = release.name === status.currentRelease ? " [current]" : "";
        lines.push(`  - ${release.name}${marker} (${formatDateTime(release.mtime)})`);
    }

    return lines;
}
