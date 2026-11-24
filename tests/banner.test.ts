import { test } from "node:test";
import assert from "node:assert/strict";
import {
    shouldDisplayBanner,
    printFullBanner,
    printCompactBanner,
} from "../src/core/banner.js";

test("banner - shouldDisplayBanner respects DPLOY_NO_BANNER and CI", () => {
    const origNoBanner = process.env.DPLOY_NO_BANNER;
    const origCI = process.env.CI;

    try {
        process.env.DPLOY_NO_BANNER = "true";
        assert.equal(shouldDisplayBanner(), false);

        delete process.env.DPLOY_NO_BANNER;
        process.env.CI = "true";
        assert.equal(shouldDisplayBanner(), false);
    } finally {
        if (origNoBanner !== undefined) process.env.DPLOY_NO_BANNER = origNoBanner;
        else delete process.env.DPLOY_NO_BANNER;

        if (origCI !== undefined) process.env.CI = origCI;
        else delete process.env.CI;
    }
});

test("banner - printFullBanner and printCompactBanner execute without errors", () => {
    // Both functions should execute cleanly
    assert.doesNotThrow(() => printFullBanner());
    assert.doesNotThrow(() => printCompactBanner("deploy"));
});
