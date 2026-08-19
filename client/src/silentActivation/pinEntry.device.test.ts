/**
 * P33 — Decoy vs wrong-PIN render parity (device-only timing test).
 *
 * Guards: RAKSHA_DEVICE_TEST=true  — same gate as P22/P31.
 *
 * What this tests (distinct from P22):
 *   P22 tests bcrypt cost=10 timing + deadline padding (backend).
 *   P33 tests the CLIENT-SIDE render path: that renderDecoyScreen() and
 *   renderWrongPinError() are called at the same wall-clock offset from
 *   handlePinSubmission() entry across 50 pairs.
 *
 * Both functions are called via the shared deadline path in handlePinSubmission.
 * The 30ms bound accounts for JS event loop jitter on Android WebView;
 * it is NOT tight enough to be caused by React VDOM diff size differences
 * (which would be sub-millisecond for a single-string swap).
 *
 * Correctness property: P33
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import {
  handlePinSubmission,
  calibrateBcrypt,
  setCachedP95,
} from "./pinEntry.js";

const DEVICE_TEST = process.env["RAKSHA_DEVICE_TEST"] === "true";
const itDevice = DEVICE_TEST ? it : it.skip;

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

describe("P33 — Decoy vs wrong-PIN render parity", () => {
  itDevice(
    "max |wrong_render_time - decoy_render_time| ≤ 30ms across 50 pairs",
    async () => {
      // Real calibration — must run on device
      const p95 = await calibrateBcrypt();
      console.log(`[P33] Calibrated P95 bcrypt cost=10: ${p95}ms`);

      const DURESS_PIN = "654321";
      const WRONG_PIN  = "999999";
      const duressHash = await bcrypt.hash(DURESS_PIN, 10);

      const wrongTimes:  number[] = [];
      const decoyTimes:  number[] = [];

      for (let i = 0; i < 50; i++) {
        // ── Wrong PIN measurement ─────────────────────────────────────────
        let wrongCallMs = 0;
        const t0 = performance.now();
        await handlePinSubmission(WRONG_PIN, {
          duressHash,
          triggerDetector:          { onTriggerFired: () => {} },
          verifyNormalPinViaServer: async () => false,
          renderDecoyScreen:        () => {},
          renderWrongPinError:      () => { wrongCallMs = performance.now() - t0 },
          navigateToHome:           () => {},
        });
        wrongTimes.push(wrongCallMs);

        // ── Duress PIN measurement ────────────────────────────────────────
        let decoyCallMs = 0;
        const t1 = performance.now();
        await handlePinSubmission(DURESS_PIN, {
          duressHash,
          triggerDetector:          { onTriggerFired: () => {} },
          verifyNormalPinViaServer: async () => false,
          renderDecoyScreen:        () => { decoyCallMs = performance.now() - t1 },
          renderWrongPinError:      () => {},
          navigateToHome:           () => {},
        });
        decoyTimes.push(decoyCallMs);
      }

      const diffs = wrongTimes.map((w, i) => Math.abs(w - decoyTimes[i]));
      const maxDiff   = Math.max(...diffs);
      const wrongP95  = percentile(wrongTimes,  95);
      const decoyP95  = percentile(decoyTimes,  95);
      const wrongP50  = percentile(wrongTimes,  50);
      const decoyP50  = percentile(decoyTimes,  50);

      console.log([
        `[P33] wrongP50=${wrongP50.toFixed(1)}ms  decoyP50=${decoyP50.toFixed(1)}ms`,
        `[P33] wrongP95=${wrongP95.toFixed(1)}ms  decoyP95=${decoyP95.toFixed(1)}ms`,
        `[P33] maxPairwiseDiff=${maxDiff.toFixed(1)}ms  (bound: ≤30ms)`,
      ].join("\n"));

      expect(maxDiff).toBeLessThanOrEqual(30);
    },
    120_000  // 50 × 2 bcrypt operations at ~250ms each = ~25s; 2× safety margin
  );
});
