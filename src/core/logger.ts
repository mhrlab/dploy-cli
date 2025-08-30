import chalk from "chalk";
import ora from "ora";


export const log = {
    info: (msg: string) => console.log(chalk.cyan(`ℹ️ INFO:`), chalk.white(msg)),
    ok: (msg: string) => console.log(chalk.green(`✅  OK:`), chalk.white(msg)),
    warn: (msg: string) => console.log(chalk.yellow(`⚠️ WARN:`), chalk.white(msg)),
    err: (msg: string) => console.error(chalk.red(`❌ ERROR:`), chalk.white(msg)),
    debug: (msg: string) => console.log(chalk.magenta(`🐛 DEBUG:`), chalk.gray(msg)),
    spinner: (text: string) => ora({text, color: "cyan"}).start(),
};

export const log_old = {
    info: (msg: string) => console.log(chalk.cyan("i"), msg),
    ok: (msg: string) => console.log(chalk.green("✔"), msg),
    warn: (msg: string) => console.log(chalk.yellow("!"), msg),
    err: (msg: string) => console.error(chalk.red("✖"), msg),
    spinner: (text: string) => ora(text).start(),
};
