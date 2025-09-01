// features/cleaner.ts
import { listDirs, removePath, SSHBundle } from "../core/ssh.js";
import { posixJoin } from "../core/utils.js";
import { log } from "../core/logger.js";

export async function cleanupReleases(bundle: SSHBundle, releasesDir: string, keep: number, strict = false) {
    try {
        log.verbose(`Listing releases for cleanup in: ${releasesDir}`);
        const dirs = await listDirs(bundle.sftp, releasesDir);
        // sort oldest → newest
        const sortedReleases = [...dirs].sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
        const toDelete = sortedReleases.slice(0, Math.max(0, sortedReleases.length - keep));

        if (!toDelete.length) {
            log.ok("Nothing to clean - all releases are within the keep limit");
            return;
        }

        log.info(`Cleaning ${toDelete.length} old release(s) to keep ${keep} latest`);

        for (const r of toDelete) {
            try {
                log.verbose(`Removing release: ${r.name}`);
                await removePath(bundle.ssh, posixJoin(releasesDir, r.name));
                log.info(`Release: [${r.name}] removed successfully`);
            } catch (err: any) {
                log.warn(`Failed to remove release [${r.name}]: ${err.message}`);
            }
        }
        log.ok(`Cleanup finished (removed ${toDelete.length} release(s))`);
    } catch (err: any) {
        if (strict) throw err;
        log.warn(`Cleanup skipped: ${err.message}`);
    }
}
