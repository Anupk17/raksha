/**
 * P22 — Decoy Screen Timing Parity (Device Integration Test)
 *
 * This Playwright spec implements the full P22 timing-parity verification
 * described in design.md §Testability (lines 586–615).
 *
 * ## Prerequisites
 *
 *   1. Build the PWA:
 *        cd client && npm run build
 *
 *   2. Serve the build:
 *        npx serve dist/ -l 3000
 *
 *   3. Connect a representative device:
 *        - Physical: Pixel 6a (or class-equivalent Android) via ADB
 *        - Emulator: Android Emulator with Pixel 6a AVD profile
 *        - Do NOT run on server-grade x86-64 hardware — bcrypt cost=10
 *          timing on server CPUs is not representative (~50–100ms vs ~250ms
 *          on mobile). A false pass is possible.
 *
 *   4. Configure playwright.config.ts to target the device browser.
 *
 *   5. Run:
 *        RAKSHA_DEVICE_TEST=true npx playwright test --grep "P22"
 *
 * ## What is measured
 *
 *   - 50 wrong-PIN submissions: t0=performance.now() before submit,
 *     t1=performance.now() inside first requestAnimationFrame after
 *     renderWrongPinError() fires.
 *   - 50 duress-PIN submissions: same measurement after renderDecoyScreen().
 *   - max(|wrong_latency[i] - duress_latency[i]|) across all 50 pairs.
 *   - This max delta must be ≤ 30ms (design.md §Testability, Req 4.6).
 *
 * ## Why this cannot run in CI
 *
 *   See the full explanation in silentActivation.integration.test.ts (test 13.9).
 *   Short version: bcrypt cost=10 on CI hardware completes in ~50–150ms,
 *   not the ~250ms on a Pixel 6a. requestAnimationFrame is unavailable in
 *   Node/jsdom. Timer jitter on CI VMs can exceed 30ms independently of
 *   the code under test.
 *
 * ## Artifact output
 *
 *   The test emits raw sample data to:
 *     client/test-results/p22-timing-parity-samples.json
 *
 *   Format:
 *     {
 *       "wrongPinLatenciesMs": [248.3, 251.1, ...],  // 50 values
 *       "duressPinLatenciesMs": [249.8, 250.4, ...], // 50 values
 *       "maxDeltaMs": 4.2,
 *       "passed": true,
 *       "device": "Pixel 6a",
 *       "bcryptCost": 10,
 *       "measuredP95Ms": 261,
 *       "timestamp": "2026-07-14T12:00:00.000Z"
 *     }
 *
 * Requirements: design.md §Testability, tasks.md Task 13.9, Req 4.6
 */

import { test, expect, Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

// Skip entire spec unless RAKSHA_DEVICE_TEST=true
const isDeviceTest = process.env["RAKSHA_DEVICE_TEST"] === "true";
test.skip(!isDeviceTest, "P22 device-only test: set RAKSHA_DEVICE_TEST=true to run");

const APP_URL = process.env["RAKSHA_APP_URL"] ?? "http://localhost:3000";
const SAMPLE_COUNT = 50;
const MAX_DELTA_MS = 30;

/**
 * Measures the latency from PIN submission to first rendered frame.
 * Uses performance.now() for sub-millisecond resolution and
 * requestAnimationFrame as the render-complete signal, matching
 * the design.md §Testability specification exactly.
 */
async function measurePinLatency(
  page: Page,
  pin: string
): Promise<number> {
  return page.evaluate(async (candidatePin: string) => {
    return new Promise<number>((resolve) => {
      const t0 = performance.now();

      // Trigger pin submission via the test harness exposed by the PWA
      const harness = (window as any).__testHarness;
      if (!harness || typeof harness.submitPin !== "function") {
        throw new Error(
          "window.__testHarness.submitPin is not available. " +
          "Build the PWA with test harness enabled: VITE_TEST_HARNESS=true npm run build"
        );
      }

      harness.submitPin(candidatePin);

      // Wait for the first rAF after the render call fires
      const originalNotify = harness.notifyRendered;
      harness.notifyRendered = () => {
        requestAnimationFrame(() => {
          const t1 = performance.now();
          harness.notifyRendered = originalNotify;
          resolve(t1 - t0);
        });
      };
    });
  }, pin);
}

test(
  "P22: wrong-PIN and duress-PIN render latency differ by ≤30ms across 50 samples each [DEVICE ONLY]",
  async ({ page }) => {
    await page.goto(APP_URL);

    // Navigate to the PIN entry screen
    await page.waitForSelector("[data-testid='pin-entry-screen']", {
      timeout: 10_000,
    });

    // Retrieve device info and calibrated P95 for the artifact
    const deviceInfo = await page.evaluate(() => {
      return {
        userAgent: navigator.userAgent,
        measuredP95Ms: (window as any).__testHarness?.getCachedP95?.() ?? null,
      };
    });

    // Collect wrong-PIN latency samples
    const wrongPinLatencies: number[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const latency = await measurePinLatency(page, "000000"); // wrong PIN
      wrongPinLatencies.push(latency);
    }

    // Collect duress-PIN latency samples
    const testDuressPin = process.env["RAKSHA_TEST_DURESS_PIN"] ?? "111111";
    const duressPinLatencies: number[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const latency = await measurePinLatency(page, testDuressPin);
      duressPinLatencies.push(latency);
    }

    // Compute max absolute delta across all 50 pairs (design.md §Testability)
    let maxDeltaMs = 0;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const delta = Math.abs(wrongPinLatencies[i]! - duressPinLatencies[i]!);
      if (delta > maxDeltaMs) maxDeltaMs = delta;
    }

    // Emit auditable artifact
    const artifact = {
      wrongPinLatenciesMs: wrongPinLatencies,
      duressPinLatenciesMs: duressPinLatencies,
      maxDeltaMs,
      passed: maxDeltaMs <= MAX_DELTA_MS,
      device: deviceInfo.userAgent,
      bcryptCost: 10,
      measuredP95Ms: deviceInfo.measuredP95Ms,
      timestamp: new Date().toISOString(),
    };

    const artifactDir = path.resolve("test-results");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(artifactDir, "p22-timing-parity-samples.json"),
      JSON.stringify(artifact, null, 2)
    );

    // The actual assertion: max delta across 50 pairs must be ≤ 30ms (design.md Req 4.6)
    expect(maxDeltaMs).toBeLessThanOrEqual(MAX_DELTA_MS);
  },
  { timeout: 120_000 }
);
