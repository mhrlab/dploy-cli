import chalk from "chalk";
import { getAppVersion } from "./utils.js";

/**
 * Check if banners should be printed (interactive TTY, not CI, not JSON mode)
 */
export function shouldDisplayBanner(): boolean {
    if (process.env.DPLOY_NO_BANNER || process.env.CI) return false;
    if (!process.stdout.isTTY) return false;
    if (process.argv.includes("--json")) return false;
    return true;
}

/**
 * Big Modern Bold Banner (Concept 1)
 * Used for landmark commands: `dploy` (root/help), `dploy init`, `dploy setup`
 */
export function printFullBanner(): void {
    if (!shouldDisplayBanner()) return;

    const version = getAppVersion();
    const cyan = chalk.cyanBright;
    const blue = chalk.blueBright;
    const dim = chalk.dim;

    const logo = [
        cyan("  ____  _____  _      ______     __"),
        cyan(" |  _ \\|  __ \\| |    / __ \\ \\   / /"),
        cyan(" | | | | |__) | |   | |  | \\ \\_/ / "),
        blue(" | |_| |  ___/| |___| |__| |  | |  "),
        blue(" |____/|_|    |______\\____/   |_|  ") + dim(` v${version}`),
        dim(" Zero-Downtime Deployment & Server Lifecycle Platform\n"),
    ].join("\n");

    console.log(logo);
}

/**
 * Compact / Minimalist Banner (Concept 3)
 * Used for frequent or operational commands: `deploy`, `rollback`, `provision`, `logs`, etc.
 */
export function printCompactBanner(actionName?: string): void {
    if (!shouldDisplayBanner()) return;

    const version = getAppVersion();
    const actionTag = actionName ? ` ${chalk.dim(`[${actionName}]`)}` : "";
    const banner = `${chalk.cyanBright("▲")} ${chalk.bold("dploy")}${actionTag} ${chalk.dim(`v${version}`)}`;
    console.log(banner);
}
