import path from "node:path";
import type { RemoteRelease } from "./status.js";

export type RollbackOptions = {
    latest?: boolean;
    to?: string;
};

export function currentReleaseNameFromTarget(currentTarget: string | null | undefined): string | null {
    if (!currentTarget) return null;
    const normalized = currentTarget.replace(/\\/g, "/");
    const currentRelease = path.posix.basename(normalized);
    return currentRelease || null;
}

export function resolveRollbackTarget(
    releases: RemoteRelease[],
    currentRelease: string | null,
    opts: RollbackOptions = {}
): RemoteRelease | null {
    if (opts.latest && opts.to) {
        throw new Error("Use either --latest or --to <version>, not both");
    }

    if (opts.to) {
        const target = releases.find((release) => release.name === opts.to);
        if (!target) {
            throw new Error(`Release '${opts.to}' not found`);
        }
        return target;
    }

    if (opts.latest) {
        return releases.find((release) => release.name !== currentRelease) ?? null;
    }

    return null;
}
