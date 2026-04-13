import path from "node:path";
import { exec, type SSHBundle } from "../core/ssh.js";

export const RELEASE_METADATA_FILE = "deploy-metadata.json";

export type ReleaseMetadata = {
    version: string;
    deployedAt: string;
    gitCommit: string | null;
    environment: string;
    artifactName?: string | null;
};

export type ReleaseInfo = {
    name: string;
    mtime: Date;
    metadata: ReleaseMetadata | null;
};

export function createReleaseMetadata(input: {
    version: string;
    environment: string;
    gitCommit?: string | null;
    deployedAt?: Date;
    artifactName?: string | null;
}): ReleaseMetadata {
    return {
        version: input.version,
        deployedAt: (input.deployedAt ?? new Date()).toISOString(),
        gitCommit: input.gitCommit ?? null,
        environment: input.environment,
        artifactName: input.artifactName ?? null,
    };
}

export function parseReleaseMetadata(raw: string): ReleaseMetadata | null {
    const text = raw.trim();
    if (!text) return null;

    const data = JSON.parse(text) as Partial<ReleaseMetadata>;
    if (!data.version || !data.deployedAt || !data.environment) {
        return null;
    }

    return {
        version: data.version,
        deployedAt: data.deployedAt,
        gitCommit: data.gitCommit ?? null,
        environment: data.environment,
        artifactName: data.artifactName ?? null,
    };
}

export function formatReleaseMetadata(meta: ReleaseMetadata | null): string {
    if (!meta) return "no metadata";

    const bits = [
        `version ${meta.version}`,
        `env ${meta.environment}`,
        `deployed ${formatDateTime(new Date(meta.deployedAt))}`,
    ];

    if (meta.gitCommit) {
        bits.push(`commit ${meta.gitCommit.slice(0, 12)}`);
    }
    if (meta.artifactName) {
        bits.push(`artifact ${meta.artifactName}`);
    }

    return bits.join(", ");
}

export function formatReleaseLabel(release: ReleaseInfo, currentRelease?: string | null): string {
    const marker = release.name === currentRelease ? " [current]" : "";
    const meta = release.metadata ? ` (${formatReleaseMetadata(release.metadata)})` : ` (${formatDateTime(release.mtime)})`;
    return `${release.name}${marker}${meta}`;
}

export async function readRemoteReleaseMetadata(bundle: SSHBundle, releaseDir: string): Promise<ReleaseMetadata | null> {
    const filePath = path.posix.join(releaseDir, RELEASE_METADATA_FILE);
    const { stdout } = await exec(bundle.ssh, `cat "${filePath}" 2>/dev/null || true`);
    try {
        return parseReleaseMetadata(stdout);
    } catch {
        return null;
    }
}

function formatDateTime(value: Date): string {
    return value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}
