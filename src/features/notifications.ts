import { log } from "../core/logger.js";

export type NotificationChannel = "slack" | "discord" | "telegram" | "webhook";
export type NotificationEvent = "start" | "success" | "failure" | "rollback";

export interface NotificationTarget {
    channel?: NotificationChannel;
    url?: string;
    webhookUrl?: string; // fallback alias for url
    token?: string;      // for telegram bot token
    chatId?: string;     // for telegram chat id
    on?: NotificationEvent[];
    headers?: Record<string, string>;
}

export interface NotificationPayload {
    event: NotificationEvent;
    environment: string;
    version: string;
    host?: string;
    gitCommit?: string | null;
    commitMessage?: string | null;
    deployer?: string;
    durationMs?: number;
    error?: string;
}

/**
 * Format message for Slack Incoming Webhook
 */
export function formatSlackMessage(payload: NotificationPayload) {
    const statusColor = {
        start: "#3498db",
        success: "#2ecc71",
        failure: "#e74c3c",
        rollback: "#e67e22",
    }[payload.event] || "#3498db";

    const titlePrefix = {
        start: "🚀 Deployment Started",
        success: "✅ Deployment Successful",
        failure: "❌ Deployment Failed",
        rollback: "⚠️ Deployment Rolled Back",
    }[payload.event];

    const fields = [
        { title: "Environment", value: payload.environment, short: true },
        { title: "Version", value: payload.version, short: true },
    ];

    if (payload.host) {
        fields.push({ title: "Host", value: payload.host, short: true });
    }
    if (payload.deployer) {
        fields.push({ title: "Deployer", value: payload.deployer, short: true });
    }
    if (payload.gitCommit) {
        fields.push({ title: "Commit", value: payload.gitCommit.substring(0, 7), short: true });
    }
    if (payload.durationMs !== undefined) {
        fields.push({ title: "Duration", value: `${(payload.durationMs / 1000).toFixed(1)}s`, short: true });
    }
    if (payload.error) {
        fields.push({ title: "Error", value: payload.error, short: false });
    }

    return {
        attachments: [
            {
                color: statusColor,
                title: `${titlePrefix}: ${payload.environment} (v${payload.version})`,
                fields,
                footer: "dploy-cli",
                ts: Math.floor(Date.now() / 1000),
            },
        ],
    };
}

/**
 * Format message for Discord Webhook
 */
export function formatDiscordMessage(payload: NotificationPayload) {
    const statusColor = {
        start: 0x3498db,
        success: 0x2ecc71,
        failure: 0xe74c3c,
        rollback: 0xe67e22,
    }[payload.event] || 0x3498db;

    const titlePrefix = {
        start: "🚀 Deployment Started",
        success: "✅ Deployment Successful",
        failure: "❌ Deployment Failed",
        rollback: "⚠️ Deployment Rolled Back",
    }[payload.event];

    const fields = [
        { name: "Environment", value: payload.environment, inline: true },
        { name: "Version", value: payload.version, inline: true },
    ];

    if (payload.host) {
        fields.push({ name: "Host", value: payload.host, inline: true });
    }
    if (payload.deployer) {
        fields.push({ name: "Deployer", value: payload.deployer, inline: true });
    }
    if (payload.gitCommit) {
        fields.push({ name: "Commit", value: payload.gitCommit.substring(0, 7), inline: true });
    }
    if (payload.durationMs !== undefined) {
        fields.push({ name: "Duration", value: `${(payload.durationMs / 1000).toFixed(1)}s`, inline: true });
    }
    if (payload.error) {
        fields.push({ name: "Error", value: payload.error, inline: false });
    }

    return {
        embeds: [
            {
                title: `${titlePrefix} [${payload.environment}]`,
                color: statusColor,
                fields,
                timestamp: new Date().toISOString(),
                footer: { text: "dploy-cli" },
            },
        ],
    };
}

/**
 * Format message for Telegram Bot
 */
export function formatTelegramMessage(payload: NotificationPayload): string {
    const icon = {
        start: "🚀",
        success: "✅",
        failure: "❌",
        rollback: "⚠️",
    }[payload.event];

    let msg = `*${icon} Deployment ${payload.event.toUpperCase()}*\n`;
    msg += `• *Environment:* \`${payload.environment}\`\n`;
    msg += `• *Version:* \`${payload.version}\`\n`;
    if (payload.host) msg += `• *Host:* \`${payload.host}\`\n`;
    if (payload.deployer) msg += `• *Deployer:* ${payload.deployer}\n`;
    if (payload.gitCommit) msg += `• *Commit:* \`${payload.gitCommit.substring(0, 7)}\`\n`;
    if (payload.durationMs !== undefined) msg += `• *Duration:* ${(payload.durationMs / 1000).toFixed(1)}s\n`;
    if (payload.error) msg += `• *Error:* ${payload.error}\n`;

    return msg;
}

/**
 * Dispatch a notification target without throwing errors that would interrupt deployment.
 */
export async function sendNotification(target: NotificationTarget, payload: NotificationPayload): Promise<void> {
    const targetUrl = target.url || target.webhookUrl;
    const events = target.on || ["success", "failure", "rollback"];

    if (!events.includes(payload.event)) {
        return;
    }

    const channel = target.channel || "webhook";

    try {
        if (channel === "telegram") {
            const token = target.token || process.env.TELEGRAM_BOT_TOKEN;
            const chatId = target.chatId || process.env.TELEGRAM_CHAT_ID;
            if (!token || !chatId) {
                log.warn(`[notifications] Telegram notification skipped: missing bot token or chatId`);
                return;
            }
            const text = formatTelegramMessage(payload);
            const tgUrl = `https://api.telegram.org/bot${token}/sendMessage`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            try {
                const res = await fetch(tgUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text,
                        parse_mode: "Markdown",
                    }),
                    signal: controller.signal,
                });
                if (!res.ok) {
                    const errBody = await res.text().catch(() => "");
                    log.warn(`[notifications] Telegram API returned HTTP ${res.status}: ${errBody}`);
                } else {
                    log.verbose(`[notifications] Successfully delivered ${payload.event} notification to Telegram`);
                }
            } finally {
                clearTimeout(timeoutId);
            }
            return;
        }

        if (!targetUrl) {
            log.warn(`[notifications] Skipping notification: no target URL configured`);
            return;
        }

        let body: any;
        if (channel === "slack") {
            body = formatSlackMessage(payload);
        } else if (channel === "discord") {
            body = formatDiscordMessage(payload);
        } else {
            // Generic webhook
            body = payload;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        try {
            const res = await fetch(targetUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(target.headers || {}),
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!res.ok) {
                const errBody = await res.text().catch(() => "");
                log.warn(`[notifications] ${channel.toUpperCase()} webhook returned HTTP ${res.status}: ${errBody}`);
            } else {
                log.verbose(`[notifications] Successfully delivered ${payload.event} notification to ${channel}`);
            }
        } finally {
            clearTimeout(timeoutId);
        }
    } catch (err: any) {
        // Notifications are non-blocking; do not throw
        log.warn(`[notifications] Failed to send ${channel} notification: ${err?.message || err}`);
    }
}

/**
 * Dispatch notifications to all configured targets in non-blocking parallel execution.
 */
export async function dispatchNotifications(
    targets: NotificationTarget[] | undefined,
    payload: NotificationPayload
): Promise<void> {
    if (!targets || !Array.isArray(targets) || targets.length === 0) {
        return;
    }

    try {
        await Promise.allSettled(targets.map((t) => sendNotification(t, payload)));
    } catch (err: any) {
        log.warn(`[notifications] Error during dispatch: ${err?.message || err}`);
    }
}
