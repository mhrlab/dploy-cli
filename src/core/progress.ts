import chalk from "chalk";
import { log } from "./logger.js";

/**
 * Format bytes into human-readable unit (B, KB, MB, GB).
 */
export function formatBytes(bytes: number, decimals: number = 1): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const safeI = Math.min(i, sizes.length - 1);
    return `${parseFloat((bytes / Math.pow(k, safeI)).toFixed(dm))} ${sizes[safeI]}`;
}

/**
 * Format transfer speed (e.g. 2.4 MB/s).
 */
export function formatSpeed(bytesPerSec: number): string {
    return `${formatBytes(bytesPerSec, 1)}/s`;
}

/**
 * Format seconds into human duration (e.g. 45s, 1m 15s).
 */
export function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
}

/**
 * Progress bar for byte transfer (SFTP upload/download).
 */
export class TransferProgressBar {
    private totalBytes: number;
    private label: string;
    private width: number;
    private startTime: number;
    private lastRenderTime: number = 0;
    private lastLoggedPercent: number = -1;
    private completed: boolean = false;
    private isTTY: boolean;

    constructor(options: {
        totalBytes: number;
        label?: string;
        width?: number;
    }) {
        this.totalBytes = Math.max(0, options.totalBytes);
        this.label = options.label || "Uploading";
        this.width = options.width || 20;
        this.startTime = Date.now();
        this.isTTY = Boolean(process.stdout.isTTY && !process.env.CI);
    }

    public update(transferredBytes: number): void {
        if (this.completed) return;

        const now = Date.now();
        const transferred = Math.min(this.totalBytes, Math.max(0, transferredBytes));
        const percent = this.totalBytes > 0
            ? Math.min(100, Math.floor((transferred / this.totalBytes) * 100))
            : 100;

        const elapsedSeconds = (now - this.startTime) / 1000;
        const speed = elapsedSeconds > 0 ? transferred / elapsedSeconds : 0;
        const remainingBytes = Math.max(0, this.totalBytes - transferred);
        const etaSeconds = speed > 0 ? Math.ceil(remainingBytes / speed) : 0;

        if (this.isTTY) {
            // Throttle rendering to max once per 60ms to prevent terminal flicker
            if (now - this.lastRenderTime < 60 && percent < 100) {
                return;
            }
            this.lastRenderTime = now;

            const filledLength = Math.round((this.width * percent) / 100);
            const emptyLength = Math.max(0, this.width - filledLength);
            const bar = chalk.green("█".repeat(filledLength)) + chalk.gray("░".repeat(emptyLength));

            const transferredStr = formatBytes(transferred);
            const totalStr = formatBytes(this.totalBytes);
            const speedStr = formatSpeed(speed);
            const etaStr = etaSeconds > 0 ? `ETA: ${formatDuration(etaSeconds)}` : "ETA: 0s";

            const output = `\r${chalk.blue("i")} ${this.label} [${bar}] ${chalk.bold(`${percent}%`)} | ${transferredStr} / ${totalStr} | ${chalk.yellow(speedStr)} | ${chalk.gray(etaStr)}`;

            process.stdout.write(output);
        } else {
            // In non-TTY / CI environments, log milestones at 25%, 50%, 75%, 100%
            if (percent >= this.lastLoggedPercent + 25 || percent === 100) {
                this.lastLoggedPercent = Math.floor(percent / 25) * 25;
                log.info(
                    `${this.label}: ${percent}% (${formatBytes(transferred)}/${formatBytes(this.totalBytes)}) at ${formatSpeed(speed)}`
                );
            }
        }
    }

    public finish(successMsg?: string): void {
        if (this.completed) return;
        this.completed = true;

        const elapsedSeconds = Math.max(0.1, (Date.now() - this.startTime) / 1000);
        const avgSpeed = this.totalBytes / elapsedSeconds;

        if (this.isTTY) {
            // Clear current progress line
            process.stdout.write("\r\x1b[K");
        }

        if (successMsg) {
            log.ok(successMsg);
        } else {
            log.ok(
                `${this.label} completed: ${formatBytes(this.totalBytes)} transferred in ${elapsedSeconds.toFixed(1)}s (${formatSpeed(avgSpeed)})`
            );
        }
    }
}

/**
 * Progress bar for item-based tasks (e.g. staging files).
 */
export class ItemProgressBar {
    private total: number;
    private current: number = 0;
    private label: string;
    private width: number;
    private lastRenderTime: number = 0;
    private completed: boolean = false;
    private isTTY: boolean;

    constructor(options: {
        total: number;
        label?: string;
        width?: number;
    }) {
        this.total = Math.max(0, options.total);
        this.label = options.label || "Processing";
        this.width = options.width || 20;
        this.isTTY = Boolean(process.stdout.isTTY && !process.env.CI);
    }

    public tick(count: number = 1, detail?: string): void {
        if (this.completed) return;
        this.current = Math.min(this.total, this.current + count);
        this.render(detail);
    }

    public setProgress(current: number, detail?: string): void {
        if (this.completed) return;
        this.current = Math.min(this.total, Math.max(0, current));
        this.render(detail);
    }

    private render(detail?: string): void {
        const now = Date.now();
        const percent = this.total > 0
            ? Math.min(100, Math.floor((this.current / this.total) * 100))
            : 100;

        if (this.isTTY) {
            if (now - this.lastRenderTime < 50 && percent < 100) return;
            this.lastRenderTime = now;

            const filledLength = Math.round((this.width * percent) / 100);
            const emptyLength = Math.max(0, this.width - filledLength);
            const bar = chalk.cyan("█".repeat(filledLength)) + chalk.gray("░".repeat(emptyLength));

            const detailStr = detail ? chalk.gray(` - ${detail.slice(0, 30)}`) : "";
            const output = `\r${chalk.blue("i")} ${this.label} [${bar}] ${chalk.bold(`${percent}%`)} (${this.current}/${this.total})${detailStr}`;

            process.stdout.write(output);
        }
    }

    public finish(successMsg?: string): void {
        if (this.completed) return;
        this.completed = true;

        if (this.isTTY) {
            process.stdout.write("\r\x1b[K");
        }

        if (successMsg) {
            log.ok(successMsg);
        }
    }
}
