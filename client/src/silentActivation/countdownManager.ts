/**
 * CountdownManager — manages the 10-second countdown before SOS escalation (Task 8).
 *
 * Handles:
 *   - Start/Cancellation/Expiry of the 10s countdown timer.
 *   - Haptic vibration feedback on start (P21).
 *   - Sync and trigger timestamp capturing.
 *   - OfflineQueue integration on escalation.
 *
 * Requirements: design.md §Architecture, tasks.md Task 8
 */
import type { OfflineQueue, CreateSOSSessionPayload } from "./offlineQueue.js";

export interface CountdownManagerOpts {
  offlineQueue: OfflineQueue;
  deviceInfo: string;
  locationProvider?: () => { latHash: string; lngHash: string } | null;
  /** Injectable vibration function for testing. */
  vibrate?: (pattern: number | number[]) => boolean;
}

export class CountdownManager {
  private offlineQueue: OfflineQueue;
  private deviceInfo: string;
  private locationProvider?: () => { latHash: string; lngHash: string } | null;
  private customVibrate?: (pattern: number | number[]) => boolean;

  private timerId: ReturnType<typeof setTimeout> | null = null;
  private activeTriggerType: string | null = null;
  private activeFiredAt: Date | null = null;
  private activeOnComplete: (() => void) | null = null;
  private hasEscalated = false;

  constructor(opts: CountdownManagerOpts) {
    this.offlineQueue = opts.offlineQueue;
    this.deviceInfo = opts.deviceInfo;
    this.locationProvider = opts.locationProvider;
    this.customVibrate = opts.vibrate;
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  /**
   * Starts a 10,000ms countdown timer.
   * If a countdown is already running, this is a no-op (the TriggerDetector
   * should guard this, but we enforce it here as well).
   */
  start(type: string, firedAt: Date, onComplete: () => void): void {
    if (this.timerId !== null || this.hasEscalated) {
      return;
    }

    this.activeTriggerType = type;
    this.activeFiredAt = firedAt;
    this.activeOnComplete = onComplete;
    this.hasEscalated = false;

    // Trigger haptic feedback (optional/best-effort)
    this.triggerHaptics();

    // Start 10s countdown
    this.timerId = setTimeout(() => {
      void this.escalate();
    }, 10_000);
  }

  // -------------------------------------------------------------------------
  // cancel
  // -------------------------------------------------------------------------

  /**
   * Cancels the active countdown.
   * Clears the timer and invokes `onComplete` immediately, producing zero
   * network requests or Firestore writes.
   */
  cancel(): void {
    if (this.timerId === null) {
      return; // No active countdown or already escalated
    }

    // Clear timer immediately to prevent escalation
    clearTimeout(this.timerId);
    this.timerId = null;

    const onComplete = this.activeOnComplete;
    this.resetState();

    // Call onComplete synchronously
    if (onComplete) {
      onComplete();
    }
  }

  // -------------------------------------------------------------------------
  // escalate
  // -------------------------------------------------------------------------

  /**
   * Escalates the trigger to the backend/offline queue.
   * Calls `onComplete` synchronously before awaiting the network call,
   * so the detector is released immediately.
   */
  private async escalate(): Promise<void> {
    if (this.hasEscalated || this.activeFiredAt === null || this.activeTriggerType === null) {
      return;
    }

    this.hasEscalated = true;
    this.timerId = null;

    const firedAt = this.activeFiredAt;
    const triggerType = this.activeTriggerType;
    const onComplete = this.activeOnComplete;

    this.resetState();

    // Call onComplete synchronously before any async work (Req 8.3)
    if (onComplete) {
      onComplete();
    }

    // Build payload
    const payload: CreateSOSSessionPayload = {
      triggerType,
      triggeredAt: firedAt.toISOString(),
      syncedAt: new Date().toISOString(),
      location: this.locationProvider ? this.locationProvider() : null,
      deviceInfo: this.deviceInfo,
    };

    // Send to offline queue
    await this.offlineQueue.enqueueAndFlush(payload);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private resetState(): void {
    this.activeTriggerType = null;
    this.activeFiredAt = null;
    this.activeOnComplete = null;
  }

  private triggerHaptics(): void {
    const pattern = [500, 200, 500]; // 500ms vibration, 200ms pause, 500ms vibration
    if (this.customVibrate) {
      this.customVibrate(pattern);
      return;
    }

    if (
      typeof navigator !== "undefined" &&
      typeof navigator.vibrate === "function"
    ) {
      navigator.vibrate(pattern);
    }
  }

  /** Exposed for testing — returns true if a countdown is currently active. */
  _isActive(): boolean {
    return this.timerId !== null;
  }
}
