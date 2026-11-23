import { test } from "node:test";
import assert from "node:assert/strict";
import {
    formatSlackMessage,
    formatDiscordMessage,
    formatTelegramMessage,
    sendNotification,
    dispatchNotifications,
    NotificationPayload,
} from "../src/features/notifications.js";

test("notifications - Slack payload formatting", () => {
    const payload: NotificationPayload = {
        event: "success",
        environment: "production",
        version: "1.2.3",
        host: "app-1.internal",
        deployer: "ci-bot",
        gitCommit: "abc1234567890",
        durationMs: 4500,
    };

    const slack = formatSlackMessage(payload);
    assert.ok(slack.attachments && slack.attachments.length === 1);
    const att = slack.attachments[0];
    assert.equal(att.color, "#2ecc71");
    assert.match(att.title, /Deployment Successful/);
    assert.match(att.title, /production \(v1.2.3\)/);
    
    const fieldTitles = att.fields.map((f: any) => f.title);
    assert.ok(fieldTitles.includes("Environment"));
    assert.ok(fieldTitles.includes("Version"));
    assert.ok(fieldTitles.includes("Host"));
    assert.ok(fieldTitles.includes("Duration"));
    assert.equal(att.fields.find((f: any) => f.title === "Duration")?.value, "4.5s");
});

test("notifications - Discord payload formatting", () => {
    const payload: NotificationPayload = {
        event: "failure",
        environment: "staging",
        version: "2.0.0",
        error: "Health check timed out",
        durationMs: 12000,
    };

    const discord = formatDiscordMessage(payload);
    assert.ok(discord.embeds && discord.embeds.length === 1);
    const embed = discord.embeds[0];
    assert.equal(embed.color, 0xe74c3c);
    assert.match(embed.title, /Deployment Failed/);
    const errorField = embed.fields.find((f: any) => f.name === "Error");
    assert.ok(errorField);
    assert.equal(errorField.value, "Health check timed out");
});

test("notifications - Telegram payload formatting", () => {
    const payload: NotificationPayload = {
        event: "rollback",
        environment: "production",
        version: "1.5.0",
        host: "prod-web-01",
    };

    const text = formatTelegramMessage(payload);
    assert.match(text, /Deployment ROLLBACK/);
    assert.match(text, /`production`/);
    assert.match(text, /`1.5.0`/);
    assert.match(text, /prod-web-01/);
});

test("notifications - non-blocking error handling", async () => {
    // Attempting to send to an unreachable port/host should not throw
    const payload: NotificationPayload = {
        event: "success",
        environment: "test",
        version: "1.0.0",
    };

    await assert.doesNotReject(async () => {
        await sendNotification(
            { channel: "webhook", url: "http://127.0.0.1:59999/unreachable" },
            payload
        );
    });

    await assert.doesNotReject(async () => {
        await dispatchNotifications(
            [
                { channel: "slack", url: "http://127.0.0.1:59999/slack" },
                { channel: "discord", url: "http://127.0.0.1:59999/discord" },
            ],
            payload
        );
    });
});
