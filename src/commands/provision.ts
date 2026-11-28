import { loadConfig, getEnvName, EnvironmentConfig } from "../core/config.js";
import { connect, close } from "../core/ssh.js";
import { log } from "../core/logger.js";
import { expandTilde } from "../core/utils.js";
import { printElevatedWarning } from "../core/banner.js";
import {
    executeProvisioning,
    planProvisioningOffline,
    ProvisionOptions,
    ProvisionReport,
} from "../features/provisioner.js";

export async function provision(opts: ProvisionOptions = {}): Promise<ProvisionReport> {
    printElevatedWarning("dploy provision", "Installs runtime packages, creates system directories, and assigns ownership.");
    log.debug(`Provision command started with options: ${JSON.stringify(opts)}`);

    const cfg = await loadConfig();
    const envName = getEnvName(opts.env);
    log.verbose(`Using environment: ${envName}`);

    const env = cfg.environments?.[envName];
    if (!env) {
        throw new Error(`Environment '${envName}' not found in config`);
    }

    if (!env.deployTo || typeof env.deployTo !== "string" || !env.deployTo.trim()) {
        throw new Error(`Environment '${envName}' is missing required 'deployTo' path`);
    }

    if (env.deployTo === "/") {
        throw new Error(`Refusing to provision root directory ('/') for environment '${envName}'`);
    }

    // Merge root-level provision/shared defaults with environment
    const mergedEnv: EnvironmentConfig = {
        ...env,
        shared: env.shared ?? cfg.shared ?? cfg.build?.shared ?? [],
        sharedDefaults: env.sharedDefaults ?? cfg.sharedDefaults ?? cfg.build?.sharedDefaults ?? {},
        provision: {
            ...(cfg.provision ?? {}),
            ...(env.provision ?? {}),
        },
    };

    // Resolve admin SSH connection if -A / --as-admin / --admin-* was requested
    const isAdminRequested = Boolean(opts.asAdmin || opts.asSudo || opts.adminUser || opts.adminKey || opts.adminPassword);
    let connEnv: EnvironmentConfig = mergedEnv;
    if (isAdminRequested) {
        const adminUser = opts.adminUser || process.env.DPLOY_ADMIN_USER || env.admin?.username;
        if ((opts.asAdmin || opts.asSudo) && !adminUser) {
            throw new Error(`Admin credentials not found in 'admin' block of deploy.config.yml for '${envName}'. Configure 'admin:' or pass --admin-user.`);
        }
        const adminKey = opts.adminKey || process.env.DPLOY_ADMIN_KEY || env.admin?.ssh_key_path;
        const adminPassword = opts.adminPassword || process.env.DPLOY_ADMIN_PASSWORD || env.admin?.password;
        connEnv = {
            ...mergedEnv,
            username: adminUser || mergedEnv.username,
            ssh_key_path: adminKey ? expandTilde(adminKey) : mergedEnv.ssh_key_path,
            password: adminPassword || mergedEnv.password,
            passphrase: env.admin?.passphrase || mergedEnv.passphrase,
        };
    }

    let report: ProvisionReport;

    // Handle offline dry-run if host is missing or dry-run requested without network
    if (opts.dryRun && (!connEnv.host || !connEnv.username)) {
        report = planProvisioningOffline(mergedEnv, opts);
        renderReport(report, opts);
        return report;
    }

    log.info(`Connecting to ${connEnv.username}@${connEnv.host} to provision server`);
    const spin = log.spinner("Connecting");

    let bundle;
    try {
        bundle = await connect(connEnv);
        spin.succeed("Connected");
    } catch (err: any) {
        spin.fail("SSH connect failed");
        if (opts.dryRun) {
            log.warn(`SSH connection failed (${err.message}). Falling back to offline dry-run planning.`);
            report = planProvisioningOffline(mergedEnv, opts);
            renderReport(report, opts);
            return report;
        }
        log.err(`Could not connect to ${mergedEnv.host}: ${err.message}`);
        process.exitCode = 1;
        throw err;
    }

    try {
        report = await executeProvisioning(bundle, mergedEnv, opts);
        renderReport(report, opts);
        return report;
    } finally {
        log.verbose("Closing SSH connection");
        await close(bundle);
    }
}

function renderReport(report: ProvisionReport, opts: ProvisionOptions): void {
    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    const mode = report.dryRun ? "[dry-run] " : "";
    log.info(`${mode}Provisioning summary for environment '${report.environment}' (${report.deployTo}):`);

    for (const step of report.steps) {
        const icon =
            step.status === "ok"
                ? "✓"
                : step.status === "planned"
                ? "i"
                : step.status === "skipped"
                ? "-"
                : "✗";

        console.log(`  ${icon} [${step.step.toUpperCase()}] ${step.message}`);

        if (step.details && step.details.length) {
            for (const d of step.details) {
                console.log(`      ${d}`);
            }
        }
    }

    if (report.success) {
        log.ok(`${mode}Server provisioning completed successfully.`);
    } else {
        log.err(`${mode}Server provisioning encountered warnings or missing prerequisites.`);
        process.exitCode = 1;
    }
}
