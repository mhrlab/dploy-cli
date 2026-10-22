import chalk from "chalk";
import ora from "ora";

// Global state for debug/verbose flags
let globalDebug = false;
let globalVerbose = false;

export const setLogLevel = (debug: boolean, verbose: boolean) => {
    globalDebug = debug;
    globalVerbose = verbose;
};

export const log = {
    info: (msg: string) => console.log(chalk.blue("i"), msg),
    ok: (msg: string) => console.log(chalk.green("✓"), msg),
    warn: (msg: string) => console.log(chalk.yellow("!"), msg),
    err: (msg: string) => console.error(chalk.red("✗"), msg),
    spinner: (text: string) => ora(text).start(),
    debug: (msg: string) => { if (globalDebug) console.log(chalk.magenta(" ?:"), msg); },
    verbose: (msg: string) => { if (globalVerbose || globalDebug) console.log(chalk.gray(" >:"), msg); }
};
