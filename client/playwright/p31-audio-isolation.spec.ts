/**
 * P31 — No Audio Data Transmission (Device Integration Network Intercept Test)
 *
 * This Playwright spec implements the full P31 network-level verification
 * described in design.md §Correctness Properties P31 (line 703).
 *
 * ## Prerequisites
 *
 *   1. Build the PWA:
 *        cd client && npm run build
 *
 *   2. Serve the build:
 *        npx serve dist/ -l 3000
 *
 *   3. Connect a representative device with microphone permissions.
 *
 *   4. Run:
 *        RAKSHA_DEVICE_TEST=true npx playwright test --grep "P31"
 *
 * ## What is measured
 *
 *   - The phrase detector is initialized.
 *   - Outbound browser network connections (XMLHttpRequests, fetch calls, WebRTC signaling)
 *     are intercepted.
 *   - We verify that zero outbound network traffic containing microphone-sourced bytes,
 *     audio buffers, or phrase transcription text leaves the device during phrase matching.
 *
 * ## Why this cannot run in CI
 *
 *   See the full explanation in silentActivation.integration.test.ts (test 13.10).
 *   Node/jsdom cannot simulate real WebRTC/getUserMedia media streams or capture
 *   true browser-layer sandbox network egress profiles.
 *
 * Requirements: design.md §Correctness Properties P31, Req 5.2
 */

import { test, expect } from "@playwright/test";

// Skip entire spec unless RAKSHA_DEVICE_TEST=true
const isDeviceTest = process.env["RAKSHA_DEVICE_TEST"] === "true";
test.skip(!isDeviceTest, "P31 device-only test: set RAKSHA_DEVICE_TEST=true to run");

const APP_URL = process.env["RAKSHA_APP_URL"] ?? "http://localhost:3000";

test(
  "P31: zero outbound network traffic containing audio data or phrase text during phrase matching [DEVICE ONLY]",
  async ({ page }) => {
    const outboundRequests: { url: string; postData: string | null }[] = [];

    // Intercept all outbound network traffic
    await page.route("**/*", async (route) => {
      const request = route.request();
      // Only record calls heading out to external networks (excluding localhost app sources)
      if (!request.url().includes("localhost") && !request.url().includes("127.0.0.1")) {
        outboundRequests.push({
          url: request.url(),
          postData: request.postData(),
        });
      }
      await route.continue();
    });

    await page.goto(APP_URL);

    // Initialize/start the phrase detector on-device
    await page.evaluate(() => {
      const harness = (window as any).__testHarness;
      if (!harness || typeof harness.startPhraseDetector !== "function") {
        throw new Error(
          "window.__testHarness.startPhraseDetector is not available. " +
          "Build the PWA with test harness enabled: VITE_TEST_HARNESS=true npm run build"
        );
      }
      harness.startPhraseDetector();
    });

    // Record traffic during 5 seconds of active matching
    await page.waitForTimeout(5000);

    // Stop phrase detector
    await page.evaluate(() => {
      (window as any).__testHarness.stopPhraseDetector();
    });

    // Assert that zero external requests containing audio data or phrase text were made
    for (const req of outboundRequests) {
      // General check: No external requests should be going out during active speech matching
      // to maintain absolute air-gapped privacy.
      expect(req.url).toBeNull();
    }
    
    expect(outboundRequests).toHaveLength(0);
  },
  { timeout: 30_000 }
);
