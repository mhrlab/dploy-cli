import chalk from "chalk";
import ora, { Ora } from "ora";

// Global state for debug/verbose/quiet flags
let globalDebug = false;
let globalVerbose = false;
let globalQuiet = false;

export const setLogLevel = (debug: boolean, verbose: boolean, quiet = false) => {
    globalDebug = debug;
    globalVerbose = verbose;
    globalQuiet = quiet;
};

export const getLogLevel = () => ({
    debug: globalDebug,
    verbose: globalVerbose,
    quiet: globalQuiet,
});

function formatTime(): string {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
}

/**
 * Redact sensitive credentials (passwords, passphrases, tokens, private keys) from log messages.
 */
export function redactSecrets(msg: string): string {
    return msg
        .replace(/("(?:password|adminPassword|dbRootPassword|rootPassword|passphrase|cfKey|token|secret|apiKey)":\s*")([^"]*)(")/gi, "$1***$3")
        .replace(/((?:MYSQL_PWD|PGPASSWORD)=)(?:'[^']*'|"[^"]*"|\S+)/g, "$1***")
        .replace(/(\s-p)(?:'[^']*'|"[^"]*")/g, "$1'***'")
        .replace(/(--(?:admin-password|db-root-password|password|passphrase)\s+)(?:'[^']*'|"[^"]*"|\S+)/gi, "$1***");
}

const noopSpinner = {
    text: "",
    start() { return this; },
    stop() { return this; },
    succeed() { return this; },
    fail() { return this; },
    warn() { return this; },
    info() { return this; },
} as unknown as Ora;

export const log = {
    info: (msg: string) => {
        if (!globalQuiet) console.log(chalk.blue("i"), redactSecrets(msg));
    },
    ok: (msg: string) => {
        if (!globalQuiet) console.log(chalk.green("✓"), redactSecrets(msg));
    },
    warn: (msg: string) => {
        console.warn(chalk.yellow("!"), redactSecrets(msg));
    },
    err: (msg: string) => {
        console.error(chalk.red("✗"), redactSecrets(msg));
    },
    spinner: (text: string): Ora => {
        if (globalQuiet) return noopSpinner;
        return ora(redactSecrets(text)).start();
    },
    debug: (msg: string) => {
        if (globalDebug && !globalQuiet) {
            console.log(chalk.magenta(`[${formatTime()}] [DEBUG]`), redactSecrets(msg));
        }
    },
    verbose: (msg: string) => {
        if ((globalVerbose || globalDebug) && !globalQuiet) {
            console.log(chalk.gray(`[${formatTime()}] [VERBOSE]`), redactSecrets(msg));
        }
    },
};
