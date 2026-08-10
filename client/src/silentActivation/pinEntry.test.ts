/**
 * Tests for PinEntry (Task 10).
 *
 * Requirements: tasks.md Task 10.4
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import {
  handlePinSubmission,
  calibrateBcrypt,
  getCachedP95,
  setCachedP95,
  suppressNavigation,
  releaseNavigation,
  STATIC_DUMMY_HASH,
} from "./pinEntry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockOpts(overrides: Partial<any> = {}) {
  const opts = {
    triggerDetector: { onTriggerFired: vi.fn() },
    duressHash: null as string | null,
    verifyNormalPinViaServer: vi.fn().mockResolvedValue(false),
    renderDecoyScreen: vi.fn(),
    renderWrongPinError: vi.fn(),
    navigateToHome: vi.fn(),
    ...overrides,
  };

  return {
    opts,
    onTriggerFired: opts.triggerDetector.onTriggerFired,
    verifyNormalPinViaServer: opts.verifyNormalPinViaServer,
    renderDecoyScreen: opts.renderDecoyScreen,
    renderWrongPinError: opts.renderWrongPinError,
    navigateToHome: opts.navigateToHome,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PinEntry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    releaseNavigation();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 10.4.1 — both paths call bcrypt.compare (timing parity)
  // -------------------------------------------------------------------------
  it("calls bcrypt.compare regardless of whether duressHash is set or null (timing parity)", async () => {
    const compareSpy = vi.spyOn(bcrypt, "compare");

    // Case 1: duressHash is null
    const { opts: optsNull } = makeMockOpts({ duressHash: null });
    const p1 = handlePinSubmission("123456", optsNull);
    await vi.runAllTicks(); // resolve compare
    await vi.advanceTimersByTimeAsync(300); // drain delay
    await p1;

    expect(compareSpy).toHaveBeenCalledWith("123456", STATIC_DUMMY_HASH);

    // Case 2: duressHash is set
    const { opts: optsSet } = makeMockOpts({ duressHash: "$2a$10$realhashgoeshere12345678901234567890123456789012" });
    const p2 = handlePinSubmission("654321", optsSet);
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(300);
    await p2;

    expect(compareSpy).toHaveBeenLastCalledWith("654321", optsSet.duressHash);

    compareSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 10.4.2 — firedAt timestamp passed to onTriggerFired
  // -------------------------------------------------------------------------
  it("firedAt passed to onTriggerFired matches the timestamp captured at start", async () => {
    const compareSpy = vi.spyOn(bcrypt, "compare").mockResolvedValue(true as never);
    const mockDate = new Date("2026-07-14T12:00:00.000Z");
    vi.setSystemTime(mockDate);

    const { opts, onTriggerFired } = makeMockOpts({
      duressHash: "$2a$10$realhashgoeshere12345678901234567890123456789012",
    });

    setCachedP95(250);
    const p = handlePinSubmission("123456", opts);

    // Set clock forward to verify it uses the cached firedAt, not current time at escalate
    vi.setSystemTime(new Date("2026-07-14T12:00:05.000Z"));
    await vi.advanceTimersByTimeAsync(300);
    await p;

    expect(onTriggerFired).toHaveBeenCalledTimes(1);
    expect(onTriggerFired.mock.calls[0][1].getTime()).toBe(mockDate.getTime());

    compareSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 10.4.3 — duress PIN path renders decoy screen (not home, not wrong-PIN)
  // -------------------------------------------------------------------------
  it("duress PIN path renders decoy screen and triggers SOS", async () => {
    const compareSpy = vi.spyOn(bcrypt, "compare").mockResolvedValue(true as never);
    const { opts, renderDecoyScreen, navigateToHome, renderWrongPinError, onTriggerFired } = makeMockOpts({
      duressHash: "$2a$10$realhashgoeshere12345678901234567890123456789012",
    });

    const p = handlePinSubmission("123456", opts);
    await vi.advanceTimersByTimeAsync(300);
    await p;

    expect(renderDecoyScreen).toHaveBeenCalledTimes(1);
    expect(onTriggerFired).toHaveBeenCalledTimes(1);
    expect(navigateToHome).not.toHaveBeenCalled();
    expect(renderWrongPinError).not.toHaveBeenCalled();

    compareSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 10.4.4 — wrong PIN path renders wrong PIN error
  // -------------------------------------------------------------------------
  it("wrong PIN path renders wrong-PIN error (not decoy, not home)", async () => {
    const compareSpy = vi.spyOn(bcrypt, "compare").mockResolvedValue(false as never);
    const { opts, renderDecoyScreen, navigateToHome, renderWrongPinError, verifyNormalPinViaServer } = makeMockOpts({
      duressHash: "$2a$10$realhashgoeshere12345678901234567890123456789012",
    });

    const p = handlePinSubmission("wrong", opts);
    await vi.advanceTimersByTimeAsync(300);
    await p;

    expect(verifyNormalPinViaServer).toHaveBeenCalledWith("wrong");
    expect(renderWrongPinError).toHaveBeenCalledTimes(1);
    expect(renderDecoyScreen).not.toHaveBeenCalled();
    expect(navigateToHome).not.toHaveBeenCalled();

    compareSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 10.4.5 — normal PIN path navigates to home
  // -------------------------------------------------------------------------
  it("normal PIN path navigates to home", async () => {
    const compareSpy = vi.spyOn(bcrypt, "compare").mockResolvedValue(false as never);
    const { opts, renderDecoyScreen, navigateToHome, renderWrongPinError, verifyNormalPinViaServer } = makeMockOpts({
      duressHash: "$2a$10$realhashgoeshere12345678901234567890123456789012",
      verifyNormalPinViaServer: vi.fn().mockResolvedValue(true),
    });

    const p = handlePinSubmission("normal", opts);
    await vi.advanceTimersByTimeAsync(300);
    await p;

    expect(verifyNormalPinViaServer).toHaveBeenCalledWith("normal");
    expect(navigateToHome).toHaveBeenCalledTimes(1);
    expect(renderDecoyScreen).not.toHaveBeenCalled();
    expect(renderWrongPinError).not.toHaveBeenCalled();

    compareSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 10.4.6 — back navigation suppression
  // -------------------------------------------------------------------------
  it("suppressNavigation registers popstate event listener and manipulates history", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState");
    const addListenerSpy = vi.spyOn(window, "addEventListener");

    suppressNavigation();

    // Must push a dummy state
    expect(pushStateSpy).toHaveBeenCalledTimes(1);
    // Must listen to popstate
    const popstateCalls = addListenerSpy.mock.calls.filter(([event]) => event === "popstate");
    expect(popstateCalls).toHaveLength(1);

    pushStateSpy.mockRestore();
    addListenerSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Calibration timing test
  // -------------------------------------------------------------------------
  it("calibrateBcrypt measures timing and stores cached P95", async () => {
    vi.useRealTimers();
    const t = await calibrateBcrypt();
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBe(getCachedP95());
  }, 15_000); // bcrypt.compare 5 times takes some CPU
});
