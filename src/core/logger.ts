import chalk from "chalk";
import ora from "ora";


export const log = {
    info: (msg: string) => console.log(chalk.cyan("i"), msg),
    ok: (msg: string) => console.log(chalk.green("✔"), msg),
    warn: (msg: string) => console.log(chalk.yellow("!"), msg),
    err: (msg: string) => console.error(chalk.red("✖"), msg),
    spinner: (text: string) => ora(text).start(),
};
