/**
 * Tests for CountdownManager (Task 8).
 *
 * Requirements: tasks.md Task 8.4
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CountdownManager } from "./countdownManager.js";
import type { OfflineQueue, CreateSOSSessionPayload } from "./offlineQueue.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockQueue() {
  const enqueueAndFlush = vi.fn().mockResolvedValue({
    sessionId: "mock-sess-123",
    status: "countdown",
    alreadyExists: false,
  });
  const mockQueue = {
    enqueueAndFlush,
  } as unknown as OfflineQueue;
  return { mockQueue, enqueueAndFlush };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CountdownManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 8.4.1 — start followed by timer expiry calls escalate
  // -------------------------------------------------------------------------
  it("start followed by timer expiry calls escalate (P21)", async () => {
    const { mockQueue, enqueueAndFlush } = makeMockQueue();
    const manager = new CountdownManager({
      offlineQueue: mockQueue,
      deviceInfo: "test-device",
    });

    const onComplete = vi.fn();
    const firedAt = new Date("2026-07-14T10:00:00Z");

    manager.start("earbud", firedAt, onComplete);
    expect(manager._isActive()).toBe(true);

    // Advance 10 seconds
    await vi.advanceTimersByTimeAsync(10_000);

    expect(manager._isActive()).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(enqueueAndFlush).toHaveBeenCalledTimes(1);

    const payload = enqueueAndFlush.mock.calls[0][0] as CreateSOSSessionPayload;
    expect(payload.triggerType).toBe("earbud");
    expect(payload.triggeredAt).toBe(firedAt.toISOString());
    expect(payload.deviceInfo).toBe("test-device");
  });

  // -------------------------------------------------------------------------
  // 8.4.2 — start followed by cancel before expiry (P20/P27)
  // -------------------------------------------------------------------------
  it("start followed by cancel before expiry: enqueueAndFlush NOT called (P20/P27)", async () => {
    const { mockQueue, enqueueAndFlush } = makeMockQueue();
    const manager = new CountdownManager({
      offlineQueue: mockQueue,
      deviceInfo: "test-device",
    });

    const onComplete = vi.fn();
    manager.start("earbud", new Date(), onComplete);

    // Cancel at T=3s
    await vi.advanceTimersByTimeAsync(3_000);
    manager.cancel();

    expect(manager._isActive()).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);

    // Advance past the remaining 10s window to confirm it never fires
    await vi.advanceTimersByTimeAsync(8_000);
    expect(enqueueAndFlush).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8.4.3 — cancel after expiry is a no-op (no double-escalation)
  // -------------------------------------------------------------------------
  it("cancel after expiry is a no-op / no double-escalation", async () => {
    const { mockQueue, enqueueAndFlush } = makeMockQueue();
    const manager = new CountdownManager({
      offlineQueue: mockQueue,
      deviceInfo: "test-device",
    });

    const onComplete = vi.fn();
    manager.start("earbud", new Date(), onComplete);

    // Advance past 10s to escalate
    await vi.advanceTimersByTimeAsync(10_000);
    expect(enqueueAndFlush).toHaveBeenCalledTimes(1);

    // Cancel now
    manager.cancel();
    expect(onComplete).toHaveBeenCalledTimes(1); // was already called by escalate, not incremented by cancel
    expect(enqueueAndFlush).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 8.4.4 — triggeredAt matches firedAt, not escalate call time
  // -------------------------------------------------------------------------
  it("escalate payload has triggeredAt = firedAt.toISOString() not escalation time", async () => {
    const { mockQueue, enqueueAndFlush } = makeMockQueue();
    const manager = new CountdownManager({
      offlineQueue: mockQueue,
      deviceInfo: "test-device",
    });

    const firedAt = new Date("2026-07-14T10:00:00.000Z");
    vi.setSystemTime(firedAt);
    manager.start("earbud", firedAt, () => {});

    await vi.advanceTimersByTimeAsync(10_000);

    const payload = enqueueAndFlush.mock.calls[0][0] as CreateSOSSessionPayload;
    expect(payload.triggeredAt).toBe("2026-07-14T10:00:00.000Z");
    expect(payload.syncedAt).toBe("2026-07-14T10:00:10.000Z");
  });

  // -------------------------------------------------------------------------
  // 8.4.5 — syncedAt is never before triggeredAt
  // -------------------------------------------------------------------------
  it("escalate payload has syncedAt >= triggeredAt", async () => {
    const { mockQueue, enqueueAndFlush } = makeMockQueue();
    const manager = new CountdownManager({
      offlineQueue: mockQueue,
      deviceInfo: "test-device",
    });

    const firedAt = new Date("2026-07-14T10:00:00Z");
    // Ensure system time matches firedAt initially
    vi.setSystemTime(firedAt);
    manager.start("earbud", firedAt, () => {});

    // System time moves forward
    await vi.advanceTimersByTimeAsync(10_000);

    const payload = enqueueAndFlush.mock.calls[0][0] as CreateSOSSessionPayload;
    const triggeredTime = new Date(payload.triggeredAt).getTime();
    const syncedTime = new Date(payload.syncedAt).getTime();
    expect(syncedTime).toBeGreaterThanOrEqual(triggeredTime);
  });

  // -------------------------------------------------------------------------
  // 8.4.6 — onComplete called by cancel() synchronously
  // -------------------------------------------------------------------------
  it("onComplete is called by cancel() synchronously", () => {
    const { mockQueue } = makeMockQueue();
    const manager = new CountdownManager({
      offlineQueue: mockQueue,
      deviceInfo: "test-device",
    });

    let completeCalledSynchronously = false;
    manager.start("earbud", new Date(), () => {
      completeCalledSynchronously = true;
    });

    manager.cancel();
    expect(completeCalledSynchronously).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8.4.7 — onComplete called by escalate() before awaiting network
  // -------------------------------------------------------------------------
  it("onComplete is called by escalate() before awaiting the network call", async () => {
    let networkAwaited = false;
    const enqueueAndFlush = vi.fn().mockImplementation(async () => {
      // Simulate network latency
      await new Promise((r) => setTimeout(r, 50));
      networkAwaited = true;
      return SUCCESS_RESPONSE;
    });
    const mockQueue = { enqueueAndFlush } as unknown as OfflineQueue;

    const manager = new CountdownManager({
      offlineQueue: mockQueue,
      deviceInfo: "test-device",
    });

    const SUCCESS_RESPONSE = {
      sessionId: "s",
      status: "countdown",
      alreadyExists: false,
    };

    let completeCalledBeforeNetwork = false;
    manager.start("earbud", new Date(), () => {
      completeCalledBeforeNetwork = !networkAwaited;
    });

    await vi.advanceTimersByTimeAsync(10_000);
    // Flush microtasks
    await vi.runAllTicks();

    expect(completeCalledBeforeNetwork).toBe(true);
    // Let network call finish
    await vi.advanceTimersByTimeAsync(100);
    expect(networkAwaited).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8.4.8 — Timer is cleared on cancel()
  // -------------------------------------------------------------------------
  it("timer is cleared on cancel() — no late-fire", async () => {
    const { mockQueue, enqueueAndFlush } = makeMockQueue();
    const manager = new CountdownManager({
      offlineQueue: mockQueue,
      deviceInfo: "test-device",
    });

    manager.start("earbud", new Date(), () => {});
    manager.cancel();

    // Advance 20 seconds, well past the 10s timer
    await vi.advanceTimersByTimeAsync(20_000);
    expect(enqueueAndFlush).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8.4.9 — Haptics guard checks
  // -------------------------------------------------------------------------
  it("haptic call is not made when navigator.vibrate is absent", () => {
    const originalNavigator = globalThis.navigator;
    // Temporarily delete navigator/vibrate
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      writable: true,
      configurable: true,
    });

    const { mockQueue } = makeMockQueue();
    const vibrateSpy = vi.fn();
    const manager = new CountdownManager({
      offlineQueue: mockQueue,
      deviceInfo: "test-device",
      vibrate: vibrateSpy, // custom vibrate wrapper
    });

    manager.start("earbud", new Date(), () => {});
    expect(vibrateSpy).toHaveBeenCalledWith([500, 200, 500]);

    // Restore original navigator
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });
});
