import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMaintenancePayload } from "../src/features/maintenance.js";

test("formatMaintenancePayload creates valid JSON with custom message and retryAfter", () => {
    const raw = formatMaintenancePayload({
        message: "Upgrading database schema",
        retryAfter: 600,
    });

    const parsed = JSON.parse(raw);
    assert.equal(parsed.message, "Upgrading database schema");
    assert.equal(parsed.retryAfter, 600);
    assert.ok(typeof parsed.enabledAt === "string");
});

test("formatMaintenancePayload provides default message and retryAfter when omitted", () => {
    const raw = formatMaintenancePayload({});
    const parsed = JSON.parse(raw);

    assert.equal(parsed.message, "Site undergoing scheduled maintenance.");
    assert.equal(parsed.retryAfter, 300);
});
