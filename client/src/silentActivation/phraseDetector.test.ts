/**
 * Tests for PhraseDetector (Task 11.4).
 *
 * Requirements: tasks.md Task 11.4
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PhraseDetector } from "./phraseDetector.js";
import { TriggerDetector } from "./triggerDetector.js";
import { CountdownManager } from "./countdownManager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockWorker() {
  const terminate = vi.fn();
  const postMessage = vi.fn();
  const worker = {
    terminate,
    postMessage,
    onmessage: null as any,
  } as unknown as Worker;

  return { worker, terminate, postMessage };
}

function makeMockTriggerDetector() {
  const onTriggerFired = vi.fn();
  const triggerDetector = {
    onTriggerFired,
    countdownActive: false,
  } as unknown as TriggerDetector;

  return { triggerDetector, onTriggerFired };
}

function makeMockAudioContext() {
  const close = vi.fn().mockResolvedValue(undefined);
  const destination = {};
  const createMediaStreamSource = vi.fn().mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  const createScriptProcessor = vi.fn().mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null as any,
  });

  const ctx = {
    close,
    destination,
    createMediaStreamSource,
    createScriptProcessor,
  } as unknown as AudioContext;

  return { ctx, close };
}

function makeMockMediaStream() {
  const stop = vi.fn();
  const track = { stop };
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream;

  return { stream, stop };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PhraseDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 11.4.3 — does not trigger on a single detection
  // -------------------------------------------------------------------------
  it("does not trigger on a single detection (voice isolation guard)", () => {
    const { triggerDetector, onTriggerFired } = makeMockTriggerDetector();
    const detector = new PhraseDetector({ triggerDetector });

    detector.registerDetection();

    expect(detector._getDetections()).toHaveLength(1);
    expect(onTriggerFired).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 11.4.4 — triggers on 3rd detection within 30s
  // -------------------------------------------------------------------------
  it("triggers on 3rd detection within 30s", () => {
    const { triggerDetector, onTriggerFired } = makeMockTriggerDetector();
    const detector = new PhraseDetector({ triggerDetector });

    // Detection 1
    detector.registerDetection();
    vi.advanceTimersByTime(10_000);

    // Detection 2
    detector.registerDetection();
    vi.advanceTimersByTime(10_000);

    // Detection 3 (at T=20s, all three are within 30s window)
    detector.registerDetection();

    expect(onTriggerFired).toHaveBeenCalledTimes(1);
    expect(onTriggerFired.mock.calls[0][0]).toBe("duress_phrase");
    expect(detector._getDetections()).toHaveLength(0); // reset on trigger
  });

  // -------------------------------------------------------------------------
  // 11.4.5 — resets sliding window when detections are older than 30s
  // -------------------------------------------------------------------------
  it("resets detection buffer when the 30s window expires without 3 detections", () => {
    const { triggerDetector, onTriggerFired } = makeMockTriggerDetector();
    const detector = new PhraseDetector({ triggerDetector });

    // Detection 1
    detector.registerDetection();
    vi.advanceTimersByTime(31_000); // 31 seconds later

    // Detection 2
    detector.registerDetection();
    
    // First detection must be evicted since it's > 30s old
    expect(detector._getDetections()).toHaveLength(1); 
    expect(onTriggerFired).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 11.4.6 — calls stop() immediately when call-end event fires
  // -------------------------------------------------------------------------
  it("calls stop() immediately when call-end event fires", async () => {
    const { triggerDetector } = makeMockTriggerDetector();
    const { worker, terminate } = makeMockWorker();
    const { ctx, close } = makeMockAudioContext();
    const { stream, stop } = makeMockMediaStream();

    const detector = new PhraseDetector({
      triggerDetector,
      worker,
      audioContext: ctx,
      mediaStream: stream,
    });

    await detector.start();
    expect(detector._isListening()).toBe(true);

    // Simulate call ended event
    window.dispatchEvent(new Event("raksha-call-ended"));

    expect(detector._isListening()).toBe(false);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 11.4.7 — in-progress countdown continues when stop() is called
  // -------------------------------------------------------------------------
  it("in-progress countdown continues when stop() is called after trigger", async () => {
    const startSpy = vi.fn();
    const mockCountdownManager = {
      start: startSpy,
      cancel: vi.fn(),
    } as unknown as CountdownManager;

    const triggerDetector = new TriggerDetector(mockCountdownManager);
    const { worker } = makeMockWorker();
    const { ctx } = makeMockAudioContext();
    const { stream } = makeMockMediaStream();

    const detector = new PhraseDetector({
      triggerDetector,
      worker,
      audioContext: ctx,
      mediaStream: stream,
    });

    await detector.start();

    // Trigger phrase SOS (3 detections)
    detector.registerDetection();
    detector.registerDetection();
    detector.registerDetection();

    expect(triggerDetector.countdownActive).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);

    // Call stop()
    detector.stop();

    // The countdownActive flag and the countdown session must remain active
    expect(triggerDetector.countdownActive).toBe(true);
    expect(detector._isListening()).toBe(false);
  });
});
