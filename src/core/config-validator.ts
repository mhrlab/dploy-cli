import { DeployConfig, EnvironmentConfig } from "./config.js";

export interface ValidationError {
    path: string;
    message: string;
}

export function validateDeployConfig(cfg: any): { valid: boolean; errors: ValidationError[] } {
    const errors: ValidationError[] = [];

    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return {
            valid: false,
            errors: [{ path: "root", message: "Configuration must be an object" }],
        };
    }

    // Environments validation
    if (cfg.environments !== undefined) {
        if (typeof cfg.environments !== "object" || cfg.environments === null || Array.isArray(cfg.environments)) {
            errors.push({ path: "environments", message: "'environments' must be a map of environment configurations" });
        } else {
            for (const [envName, envVal] of Object.entries(cfg.environments)) {
                if (!envVal || typeof envVal !== "object" || Array.isArray(envVal)) {
                    errors.push({ path: `environments.${envName}`, message: `Environment '${envName}' configuration must be an object` });
                    continue;
                }
                const env = envVal as EnvironmentConfig;

                if (env.hosts !== undefined) {
                    if (!Array.isArray(env.hosts) || env.hosts.some((h: any) => typeof h !== "string" || !h.trim())) {
                        errors.push({ path: `environments.${envName}.hosts`, message: "'hosts' must be an array of non-empty strings" });
                    }
                }

                if (env.strategy !== undefined) {
                    const validClusterStrategies = ["parallel", "rolling"];
                    if (!validClusterStrategies.includes(env.strategy)) {
                        errors.push({
                            path: `environments.${envName}.strategy`,
                            message: `Invalid cluster strategy '${env.strategy}'. Must be one of: ${validClusterStrategies.join(", ")}`,
                        });
                    }
                }

                if (env.port !== undefined) {
                    const portNum = typeof env.port === "string" ? Number(env.port) : env.port;
                    if (typeof portNum !== "number" || isNaN(portNum) || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
                        errors.push({ path: `environments.${envName}.port`, message: "Port must be an integer between 1 and 65535" });
                    }
                }

                if (env.deployTo !== undefined) {
                    if (typeof env.deployTo !== "string" || !env.deployTo.trim()) {
                        errors.push({ path: `environments.${envName}.deployTo`, message: `missing required 'deployTo' path` });
                    } else if (env.deployTo.trim() === "/") {
                        errors.push({
                            path: `environments.${envName}.deployTo`,
                            message: `cannot deploy directly to root '/' or cannot clean directly from root '/' (Refusing to provision root directory)`,
                        });
                    }
                }

                if (env.keepVersions !== undefined) {
                    const keepNum = typeof env.keepVersions === "string" ? Number(env.keepVersions) : env.keepVersions;
                    if (typeof keepNum !== "number" || isNaN(keepNum) || !Number.isInteger(keepNum) || keepNum < 1) {
                        errors.push({ path: `environments.${envName}.keepVersions`, message: "keepVersions must be a positive integer" });
                    }
                }
            }
        }
    }

    // Build configuration validation
    if (cfg.build !== undefined) {
        if (typeof cfg.build !== "object" || cfg.build === null || Array.isArray(cfg.build)) {
            errors.push({ path: "build", message: "'build' must be an object" });
        } else {
            const validStrategies = ["copy", "include", "exclude", "hybrid"];
            if (cfg.build.strategy !== undefined && !validStrategies.includes(cfg.build.strategy)) {
                errors.push({
                    path: "build.strategy",
                    message: `Invalid strategy '${cfg.build.strategy}'. Must be one of: ${validStrategies.join(", ")}`,
                });
            }
            if (cfg.build.copy !== undefined && !Array.isArray(cfg.build.copy)) {
                errors.push({ path: "build.copy", message: "'copy' must be an array of { from, to, optional? } entries" });
            }
            if (cfg.build.include !== undefined && !Array.isArray(cfg.build.include)) {
                errors.push({ path: "build.include", message: "'include' must be an array of glob strings" });
            }
            if (cfg.build.exclude !== undefined && !Array.isArray(cfg.build.exclude)) {
                errors.push({ path: "build.exclude", message: "'exclude' must be an array of glob strings" });
            }
        }
    }

    // Database configuration validation
    if (cfg.database !== undefined) {
        if (typeof cfg.database !== "object" || cfg.database === null || Array.isArray(cfg.database)) {
            errors.push({ path: "database", message: "'database' must be an object" });
        } else {
            const validTypes = ["mysql", "postgres", "sqlite"];
            if (cfg.database.type !== undefined && !validTypes.includes(cfg.database.type)) {
                errors.push({
                    path: "database.type",
                    message: `Invalid database type '${cfg.database.type}'. Must be one of: ${validTypes.join(", ")}`,
                });
            }
        }
    }

    // Notifications configuration validation
    const validateNotifications = (notifs: any, pathPrefix: string) => {
        if (!Array.isArray(notifs)) {
            errors.push({ path: pathPrefix, message: `'${pathPrefix}' must be an array of notification targets` });
            return;
        }
        const validChannels = ["slack", "discord", "telegram", "webhook"];
        const validEvents = ["start", "success", "failure", "rollback"];
        for (let i = 0; i < notifs.length; i++) {
            const n = notifs[i];
            if (!n || typeof n !== "object") {
                errors.push({ path: `${pathPrefix}[${i}]`, message: "Notification target must be an object" });
                continue;
            }
            if (n.channel !== undefined && !validChannels.includes(n.channel)) {
                errors.push({
                    path: `${pathPrefix}[${i}].channel`,
                    message: `Invalid notification channel '${n.channel}'. Must be one of: ${validChannels.join(", ")}`,
                });
            }
            if (n.on !== undefined) {
                if (!Array.isArray(n.on) || n.on.some((ev: any) => !validEvents.includes(ev))) {
                    errors.push({
                        path: `${pathPrefix}[${i}].on`,
                        message: `Invalid notification events. Must be a subset of: ${validEvents.join(", ")}`,
                    });
                }
            }
        }
    };

    if (cfg.notifications !== undefined) {
        validateNotifications(cfg.notifications, "notifications");
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

export function assertValidDeployConfig(cfg: any): void {
    const { valid, errors } = validateDeployConfig(cfg);
    if (!valid) {
        const details = errors.map((e) => `  - [${e.path}] ${e.message}`).join("\n");
        throw new Error(`Configuration schema validation failed:\n${details}`);
    }
}
