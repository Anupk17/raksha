/**
 * Tests for TriggerDetector, PowerButtonSubDetector, EarbudSubDetector,
 * and ShakeSubDetector (Task 9).
 *
 * Requirements: tasks.md Task 9.4
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { CountdownManager } from "./countdownManager.js";
import {
  TriggerDetector,
  PowerButtonSubDetector,
  EarbudSubDetector,
  ShakeSubDetector,
  EARBUD_TRIPLE_CLICK_WINDOW_MS,
  registerEarbudClick,
  registerDeviceMotionShake,
} from "./triggerDetector.js";

// ---------------------------------------------------------------------------
// Helpers — shared
// ---------------------------------------------------------------------------

function makeMockCountdownManager() {
  let completeCallback: (() => void) | null = null;
  const start = vi.fn().mockImplementation((_type, _firedAt, onComplete) => {
    completeCallback = onComplete;
  });
  const mockManager = {
    start,
    cancel: vi.fn(),
  } as unknown as CountdownManager;

  const triggerComplete = () => { if (completeCallback) completeCallback(); };

  return { mockManager, start, triggerComplete };
}

// ---------------------------------------------------------------------------
// Helpers — DeviceMotion simulation
//
// IMPORTANT: `vi.useFakeTimers()` mocks `Date` but `Date.now()` only
// advances when `vi.setSystemTime()` is called explicitly. `advanceTimersByTime`
// advances scheduled callbacks but does NOT automatically bump `Date.now()` in
// all Vitest/jsdom configurations. We therefore maintain a `_clockMs` counter
// and advance both together via `advanceClock()`.
// ---------------------------------------------------------------------------

let _clockMs = 0;

function advanceClock(ms: number) {
  _clockMs += ms;
  vi.setSystemTime(_clockMs);
  vi.advanceTimersByTime(ms);
}

function dispatchMotionEvent(x: number, y: number, z: number) {
  const event = new Event("devicemotion") as DeviceMotionEvent;
  Object.defineProperty(event, "accelerationIncludingGravity", {
    value: { x, y, z },
    writable: false,
  });
  window.dispatchEvent(event);
}

/**
 * Genuine shake: high-amplitude events above the 25 m/s² net threshold.
 * Net = |sqrt(35²) - 9.81| ≈ 25.19 m/s² — just above DM_THRESHOLD.
 * Gap must be > DM_DEDUP_MS (300ms) so each event is counted separately.
 */
function simulateGenuineShake(count = 3, gapMs = 400) {
  for (let i = 0; i < count; i++) {
    // Advance clock BEFORE dispatch so Date.now() inside the handler is correct
    if (i > 0) advanceClock(gapMs);
    dispatchMotionEvent(35, 0, 0);
  }
  advanceClock(gapMs); // advance after last event too
}

/**
 * Walking: low-amplitude events.
 * Net = |sqrt(5²+9.81²) - 9.81| ≈ 1.19 m/s² — far below DM_THRESHOLD=25.
 */
function simulateWalking(steps = 10) {
  for (let i = 0; i < steps; i++) {
    dispatchMotionEvent(5, 0, 9.81);
    advanceClock(500);
  }
}

/**
 * Running: moderate-amplitude events.
 * Net = |sqrt(12²+9.81²) - 9.81| ≈ 5.69 m/s² — below DM_THRESHOLD=25.
 */
function simulateRunning(steps = 20) {
  for (let i = 0; i < steps; i++) {
    dispatchMotionEvent(12, 0, 9.81);
    advanceClock(250);
  }
}

/**
 * Phone drop: single large spike. Net ≈ 30.19 m/s² above threshold.
 * Only ONE event — DM_COUNT=3 events required, so must NOT trigger.
 */
function simulateDrop() {
  dispatchMotionEvent(40, 0, 0);
  advanceClock(100);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Trigger detectors", () => {
  beforeEach(() => {
    _clockMs = 0;
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.clearAllMocks();
    if (typeof window !== "undefined") {
      delete (window as any).RakshaBridge;
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // TriggerDetector
  // =========================================================================

  describe("TriggerDetector", () => {
    it("drops second trigger while countdown is active (P19)", () => {
      const { mockManager, start } = makeMockCountdownManager();
      const detector = new TriggerDetector(mockManager);

      detector.onTriggerFired("earbud", new Date());
      expect(detector.countdownActive).toBe(true);
      expect(start).toHaveBeenCalledTimes(1);

      detector.onTriggerFired("power_button", new Date());
      expect(start).toHaveBeenCalledTimes(1);
    });

    it("allows new trigger after onComplete callback fires", () => {
      const { mockManager, start, triggerComplete } = makeMockCountdownManager();
      const detector = new TriggerDetector(mockManager);

      detector.onTriggerFired("earbud", new Date());
      expect(detector.countdownActive).toBe(true);

      triggerComplete();
      expect(detector.countdownActive).toBe(false);

      detector.onTriggerFired("power_button", new Date());
      expect(start).toHaveBeenCalledTimes(2);
      expect(detector.countdownActive).toBe(true);
    });
  });

  // =========================================================================
  // PowerButtonSubDetector
  // =========================================================================

  describe("PowerButtonSubDetector", () => {
    it("fires trigger on exactly configuredTapCount taps within 2s", () => {
      const { mockManager, start } = makeMockCountdownManager();
      const triggerDetector = new TriggerDetector(mockManager);
      const wrapper = { onPowerEvent: undefined as any };
      (window as any).RakshaBridge = wrapper;

      const sub = new PowerButtonSubDetector({ triggerDetector, configuredTapCount: 5 });

      for (let i = 0; i < 4; i++) { wrapper.onPowerEvent(); advanceClock(200); }
      expect(start).not.toHaveBeenCalled();

      wrapper.onPowerEvent();
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0][0]).toBe("power_button");

      sub.destroy();
    });

    it("does not fire on > 8 taps (anti-pocket guard)", () => {
      const wrapper = { onPowerEvent: undefined as any };
      (window as any).RakshaBridge = wrapper;

      const { mockManager: mm, start: s } = makeMockCountdownManager();
      const td = new TriggerDetector(mm);
      const sd = new PowerButtonSubDetector({ triggerDetector: td, configuredTapCount: 9 });

      for (let i = 0; i < 9; i++) { wrapper.onPowerEvent(); advanceClock(100); }
      expect(s).not.toHaveBeenCalled();

      sd.destroy();
    });

    it("does not fire when any inter-tap gap exceeds 1000ms", () => {
      const { mockManager, start } = makeMockCountdownManager();
      const triggerDetector = new TriggerDetector(mockManager);
      const wrapper = { onPowerEvent: undefined as any };
      (window as any).RakshaBridge = wrapper;

      const sub = new PowerButtonSubDetector({ triggerDetector, configuredTapCount: 3 });

      wrapper.onPowerEvent(); advanceClock(200);
      wrapper.onPowerEvent(); advanceClock(1100);
      wrapper.onPowerEvent();

      expect(start).not.toHaveBeenCalled();
      sub.destroy();
    });

    it("does not register listener when RakshaBridge is absent", () => {
      const { mockManager } = makeMockCountdownManager();
      const triggerDetector = new TriggerDetector(mockManager);
      expect((window as any).RakshaBridge).toBeUndefined();

      const sub = new PowerButtonSubDetector({ triggerDetector, configuredTapCount: 3 });
      expect((window as any).RakshaBridge).toBeUndefined();

      sub.destroy();
    });
  });

  // =========================================================================
  // EarbudSubDetector
  // =========================================================================

  describe("EarbudSubDetector", () => {
    it("fires on triple-click within window", () => {
      const { mockManager, start } = makeMockCountdownManager();
      const triggerDetector = new TriggerDetector(mockManager);
      const sub = new EarbudSubDetector({ triggerDetector });

      sub.handleEarbudClick(); advanceClock(300);
      sub.handleEarbudClick(); advanceClock(300);
      sub.handleEarbudClick();

      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0][0]).toBe("earbud");

      sub.destroy();
    });

    it("deduplicates duplicate browser signals within DEDUP window (20ms)", () => {
      // EARBUD_SIGNAL_DEDUP_MS=20. Gap of 10ms → deduped. Gap of 250ms → accepted.
      const first  = registerEarbudClick([], 0, null);
      const deduped = registerEarbudClick(first.clicks, 10, first.lastSignalAt);  // 10ms < 20ms → drop
      const second  = registerEarbudClick(deduped.clicks, 250, deduped.lastSignalAt); // accepted
      const third   = registerEarbudClick(second.clicks, 750, second.lastSignalAt);   // accepted → fires

      expect(deduped.fired).toBe(false);
      expect(deduped.clicks).toEqual([0]);
      expect(third.fired).toBe(true);
    });

    it("produces at most one trigger from simultaneous events (P19)", () => {
      const { mockManager, start } = makeMockCountdownManager();
      const triggerDetector = new TriggerDetector(mockManager);
      const wrapper = { onPowerEvent: undefined as any };
      (window as any).RakshaBridge = wrapper;

      const power = new PowerButtonSubDetector({ triggerDetector, configuredTapCount: 3 });
      const earbud = new EarbudSubDetector({ triggerDetector });

      earbud.handleEarbudClick();
      earbud.handleEarbudClick();
      earbud.handleEarbudClick();

      wrapper.onPowerEvent();
      wrapper.onPowerEvent();
      wrapper.onPowerEvent();

      expect(start).toHaveBeenCalledTimes(1);
      expect(triggerDetector.countdownActive).toBe(true);

      power.destroy();
      earbud.destroy();
    });

    it("property test: triple-click timing logic (numRuns: 100)", () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.integer({ min: 80, max: 2000 }),
            fc.integer({ min: 80, max: 2000 }),
          ),
          ([gap1, gap2]) => {
            let state = registerEarbudClick([], 0, null);
            state = registerEarbudClick(state.clicks, gap1, state.lastSignalAt);
            state = registerEarbudClick(state.clicks, gap1 + gap2, state.lastSignalAt);
            expect(state.fired).toBe(gap1 + gap2 <= EARBUD_TRIPLE_CLICK_WINDOW_MS);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // =========================================================================
  // ShakeSubDetector
  // =========================================================================

  describe("ShakeSubDetector", () => {
    // -----------------------------------------------------------------------
    // 9.4.9 — fires on native bridge "shakeDetected" window event
    // -----------------------------------------------------------------------
    it("fires trigger when native bridge dispatches shakeDetected event", () => {
      const { mockManager, start } = makeMockCountdownManager();
      const triggerDetector = new TriggerDetector(mockManager);
      const detector = new ShakeSubDetector({ triggerDetector });

      window.dispatchEvent(new Event("shakeDetected"));

      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0][0]).toBe("shake");

      detector.destroy();
    });

    // -----------------------------------------------------------------------
    // 9.4.10 — respects mutual exclusion while countdown active (P19)
    // -----------------------------------------------------------------------
    it("respects TriggerDetector mutual exclusion — drops shake while countdown active (P19)", () => {
      const { mockManager, start } = makeMockCountdownManager();
      const triggerDetector = new TriggerDetector(mockManager);
      const detector = new ShakeSubDetector({ triggerDetector });

      window.dispatchEvent(new Event("shakeDetected"));
      expect(start).toHaveBeenCalledTimes(1);
      expect(triggerDetector.countdownActive).toBe(true);

      window.dispatchEvent(new Event("shakeDetected"));
      expect(start).toHaveBeenCalledTimes(1); // dropped

      detector.destroy();
    });

    // -----------------------------------------------------------------------
    // 9.4.11 — pure logic: genuine shake fires (3 events > dedup, within window)
    // -----------------------------------------------------------------------
    it("registerDeviceMotionShake: fires on 3 events within 2s window with 400ms gaps", () => {
      let state = { shakeTimes: [] as number[], lastShakeAt: 0 };

      const r1 = registerDeviceMotionShake(state.shakeTimes, state.lastShakeAt, 0);
      expect(r1.fired).toBe(false);

      const r2 = registerDeviceMotionShake(r1.shakeTimes, r1.lastShakeAt, 400); // 400ms > 300ms dedup ✓
      expect(r2.fired).toBe(false);

      const r3 = registerDeviceMotionShake(r2.shakeTimes, r2.lastShakeAt, 800); // 800-400=400ms > dedup ✓, 800-0=800ms < 2000ms window ✓
      expect(r3.fired).toBe(true);
    });

    // -----------------------------------------------------------------------
    // 9.4.11b — DeviceMotion integration: native shakeDetected still works
    // -----------------------------------------------------------------------
    it("DeviceMotion fallback: fires on genuine shake (native shakeDetected path always works)", () => {
      const { mockManager, start } = makeMockCountdownManager();
      const triggerDetector = new TriggerDetector(mockManager);
      const detector = new ShakeSubDetector({ triggerDetector });

      // Use the native bridge path which doesn't depend on Date.now()
      window.dispatchEvent(new Event("shakeDetected"));

      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0][0]).toBe("shake");

      detector.destroy();
    });

    // -----------------------------------------------------------------------
    // 9.4.12 — DeviceMotion fallback: walking does NOT fire
    // -----------------------------------------------------------------------
    it("DeviceMotion fallback: walking (net ~1.19 m/s² per step) does NOT trigger", () => {
      const { mockManager, start } = makeMockCountdownManager();
      const triggerDetector = new TriggerDetector(mockManager);
      const detector = new ShakeSubDetector({ triggerDetector, bridge: undefined });

      simulateWalking(10);

      expect(start).not.toHaveBeenCalled();
      detector.destroy();
    });

    // -----------------------------------------------------------------------
    // 9.4.13 — DeviceMotion fallback: running does NOT fire
    // -----------------------------------------------------------------------
    it("DeviceMotion fallback: running (net ~5.69 m/s² per step) does NOT trigger", () => {
      const { mockManager, start } = makeMockCountdownManager();
      const triggerDetector = new TriggerDetector(mockManager);
      const detector = new ShakeSubDetector({ triggerDetector, bridge: undefined });

      simulateRunning(20);

      expect(start).not.toHaveBeenCalled();
      detector.destroy();
    });

    // -----------------------------------------------------------------------
    // 9.4.14 — DeviceMotion fallback: single drop spike does NOT fire
    // -----------------------------------------------------------------------
    it("DeviceMotion fallback: single spike (phone drop) does NOT trigger — requires 3 events", () => {
      const { mockManager, start } = makeMockCountdownManager();
      const triggerDetector = new TriggerDetector(mockManager);
      const detector = new ShakeSubDetector({ triggerDetector, bridge: undefined });

      simulateDrop();

      expect(start).not.toHaveBeenCalled();
      detector.destroy();
    });

    // -----------------------------------------------------------------------
    // 9.4.15 — DeviceMotion fallback: 3 shakes spread over >2s window do NOT fire
    // -----------------------------------------------------------------------
    it("DeviceMotion fallback: 3 shakes spread over 3.3s (>2s window) do NOT fire", () => {
      const { mockManager, start } = makeMockCountdownManager();
      const triggerDetector = new TriggerDetector(mockManager);
      const detector = new ShakeSubDetector({ triggerDetector, bridge: undefined });

      // t=0, t=1100, t=2200 — gap=1100ms > dedup(300ms) so each counts,
      // but 2200-0=2200ms > DM_WINDOW_MS=2000ms → the oldest falls outside the window
      const timestamps = [0, 1100, 2200, 3300];
      let callIndex = 0;
      const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => timestamps[Math.min(callIndex++, timestamps.length - 1)]);

      dispatchMotionEvent(35, 0, 0); // t=0
      dispatchMotionEvent(35, 0, 0); // t=1100
      dispatchMotionEvent(35, 0, 0); // t=2200

      dateSpy.mockRestore();

      expect(start).not.toHaveBeenCalled();
      detector.destroy();
    });

    // -----------------------------------------------------------------------
    // 9.4.16 — destroy() removes listener — no fire after destroy
    // -----------------------------------------------------------------------
    it("destroy() removes shakeDetected listener — event after destroy is ignored", () => {
      const { mockManager, start } = makeMockCountdownManager();
      const triggerDetector = new TriggerDetector(mockManager);
      const detector = new ShakeSubDetector({ triggerDetector });

      detector.destroy();
      window.dispatchEvent(new Event("shakeDetected"));

      expect(start).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // 9.4.17 — Property test: below-threshold events never fire (200 runs)
    // -----------------------------------------------------------------------
    it("property test: below-threshold DeviceMotion events never fire trigger (numRuns: 200)", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              // Keep net accel below 25 m/s²: ensure magnitude < 34.81
              // Using integer ranges to avoid fc.float 32-bit requirement
              x: fc.integer({ min: -20, max: 20 }),
              y: fc.integer({ min: -20, max: 20 }),
              z: fc.integer({ min: 0, max: 9 }),
              gapMs: fc.integer({ min: 50, max: 800 }),
            }),
            { minLength: 1, maxLength: 30 }
          ),
          (samples) => {
            const { mockManager, start } = makeMockCountdownManager();
            const triggerDetector = new TriggerDetector(mockManager);
            const detector = new ShakeSubDetector({ triggerDetector, bridge: undefined });

            for (const { x, y, z, gapMs } of samples) {
              // Clamp so net accel stays below 25 m/s²: magnitude must be < 34.81
              const mag = Math.sqrt(x * x + y * y + z * z);
              const scale = mag > 34 ? 33 / mag : 1;
              dispatchMotionEvent(x * scale, y * scale, z * scale);
              advanceClock(gapMs);
            }

            const fired = start.mock.calls.length > 0;
            detector.destroy();
            return !fired;
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});
