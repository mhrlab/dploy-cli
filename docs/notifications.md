# Webhooks & Team Notifications

Receive real-time alerts on deployment events directly in Slack, Discord, Telegram, or any custom webhook endpoint.

---

## Supported Channels

| Channel | Identifier | Configuration Fields |
| :--- | :--- | :--- |
| **Slack** | `slack` | `url` (Incoming Webhook URL) |
| **Discord** | `discord` | `url` (Discord Webhook URL) |
| **Telegram** | `telegram` | `token` (Bot Token), `chatId` (Chat/Channel ID) |
| **Custom Webhook** | `webhook` | `url`, optional `headers` |

---

## Event Triggers

You can subscribe to any combination of events:
- `start`: Dispatched when the deployment build and host connection starts.
- `success`: Dispatched when code is extracted, activated, and health checks pass.
- `failure`: Dispatched if build, upload, database backup, or hook commands fail.
- `rollback`: Dispatched when an automated or manual rollback is executed.

---

## Configuration Example

```yaml
notifications:
  # Slack deployment channel
  - channel: slack
    url: https://hooks.slack.com/services/T00/B00/XXXXX
    on: [start, success, failure, rollback]

  # Discord incident alerts (failures only)
  - channel: discord
    url: https://discord.com/api/webhooks/123/XYZ
    on: [failure, rollback]

  # Telegram Bot alerts
  - channel: telegram
    token: ${TELEGRAM_BOT_TOKEN}
    chatId: "-100123456789"
    on: [success, failure]

  # Internal audit API
  - channel: webhook
    url: https://audit.internal.net/api/v1/deploy-events
    headers:
      Authorization: "Bearer ${AUDIT_API_KEY}"
    on: [success, rollback]
```

---

## Payload Data

All notifications include rich deployment metadata:
- **Environment**: Target environment name (e.g. `production`).
- **Version**: Release version tag or SHA.
- **Host(s)**: Targeted server IP(s) or hostnames.
- **Git Commit**: Commit hash and commit message.
- **Deployer**: User running the deployment.
- **Duration**: Total time taken in seconds.
- **Error Details**: Failure reason or rollback cause (on failures).

> **Non-Blocking Reliability**: Notification dispatch is completely non-blocking. If a webhook times out or returns a network error, `dploy-cli` logs a warning and proceeds without interrupting the deployment.
