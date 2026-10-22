import path from "node:path";
import { posixJoin, escapeShellArg } from "../core/utils.js";
import { exec, SSHBundle } from "../core/ssh.js";
import { formatReleaseLabel, formatReleaseMetadata, fetchRemoteReleases, type ReleaseMetadata, type ReleaseInfo } from "./release-metadata.js";

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
    releases: ReleaseInfo[];
    lastDeployAt: Date | null;
    currentReleaseMetadata: ReleaseMetadata | null;
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

    const releaseInfos = await fetchRemoteReleases(bundle, releasesDir);

    const { stdout } = await exec(bundle.ssh, `readlink -f ${escapeShellArg(currentLink)} || true`);
    const currentTarget = stdout.trim() || null;
    const currentRelease = currentTarget ? path.posix.basename(currentTarget) : null;
    const currentReleaseMetadata = releaseInfos.find((release) => release.name === currentRelease)?.metadata ?? null;
    const latestRelease = releaseInfos[0] ?? null;
    const lastDeployAt = latestRelease?.metadata ? new Date(latestRelease.metadata.deployedAt) : latestRelease?.mtime ?? null;

    return {
        envName,
        deployTo,
        currentTarget,
        currentRelease,
        releases: releaseInfos,
        lastDeployAt,
        currentReleaseMetadata,
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
    if (status.currentReleaseMetadata) {
        lines.push(`Current metadata: ${formatReleaseMetadata(status.currentReleaseMetadata)}`);
    }
    lines.push(`Last deploy: ${lastDeployLabel}`);
    lines.push(`Available releases (${status.releases.length}):`);

    if (!status.releases.length) {
        lines.push("  - none");
        return lines;
    }

    for (const release of status.releases) {
        lines.push(`  - ${formatReleaseLabel(release, status.currentRelease)}`);
    }

    return lines;
}
