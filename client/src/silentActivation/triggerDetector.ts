/**
/**
 * TriggerDetector and Gesture Sub-Detectors (Task 9).
 *
 * Implements:
 *   - TriggerDetector: Orchestrates gesture detection mutual exclusion.
 *   - PowerButtonSubDetector: Custom sequence verification algorithm for Android TWA.
 *   - EarbudSubDetector: MediaSession API and native bridge (Capacitor WebView).
 *   - ShakeSubDetector: Accelerometer-based shake detection via Android Foreground Service.
 *
 * Requirements: design.md §Architecture, tasks.md Task 9
 */
import type { CountdownManager } from "./countdownManager.js";

// ---------------------------------------------------------------------------
// TriggerDetector
// ---------------------------------------------------------------------------

export type TriggerType = "power_button" | "earbud" | "shake" | "duress_phrase" | "duress_pin";

export class TriggerDetector {
  public countdownActive = false;
  private countdownManager: CountdownManager;

  constructor(countdownManager: CountdownManager) {
    this.countdownManager = countdownManager;
  }

  /**
   * Called when any sub-detector fires.
   * If a countdown is already in progress, the trigger is dropped (P19).
   */
  onTriggerFired(type: TriggerType, firedAt: Date): void {
    if (this.countdownActive) {
      return;
    }

    this.countdownActive = true;
    this.countdownManager.start(type, firedAt, () => {
      this.countdownActive = false;
    });
  }
}

// ---------------------------------------------------------------------------
// PowerButtonSubDetector
// ---------------------------------------------------------------------------

export interface PowerButtonSubDetectorOpts {
  triggerDetector: TriggerDetector;
  configuredTapCount: number;
}

export class PowerButtonSubDetector {
  private triggerDetector: TriggerDetector;
  private configuredTapCount: number;
  private taps: number[] = [];

  constructor(opts: PowerButtonSubDetectorOpts) {
    this.triggerDetector = opts.triggerDetector;
    this.configuredTapCount = opts.configuredTapCount;

    this.registerListener();
  }

  private registerListener(): void {
    if (
      typeof window !== "undefined" &&
      (window as any).RakshaBridge &&
      typeof (window as any).RakshaBridge === "object"
    ) {
      (window as any).RakshaBridge.onPowerEvent = () => {
        this.handlePowerEvent();
      };
    }
  }

  public handlePowerEvent(): void {
    const now = Date.now();

    // Evict taps older than 2000ms
    this.taps = this.taps.filter((t) => now - t <= 2000);
    this.taps.push(now);

    const n = this.taps.length;

    // Check bounds
    if (n < this.configuredTapCount) {
      return;
    }
    if (n > 8) {
      // Anti-pocket guard (Req 9.2 / Task 9.2)
      return;
    }

    // Check max gap between consecutive taps
    let gapExceeded = false;
    for (let i = 1; i < n; i++) {
      if (this.taps[i] - this.taps[i - 1] > 1000) {
        gapExceeded = true;
        break;
      }
    }

    if (gapExceeded) {
      return;
    }

    // Valid sequence — fire trigger
    this.triggerDetector.onTriggerFired("power_button", new Date(now));
    this.taps = [];
  }

  public destroy(): void {
    if (typeof window !== "undefined" && (window as any).RakshaBridge) {
      (window as any).RakshaBridge.onPowerEvent = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// EarbudSubDetector
// ---------------------------------------------------------------------------

/**
 * EarbudSubDetector uses Media Session API and key events to detect triple-clicks
 * on connected earbud hardware buttons.
 *
 * ## Background Behavior Limitations (Important):
 * - On many mobile browsers (Chrome for Android, Safari on iOS), Media Session
 *   API handlers will only fire if there is an active audio playback session
 *   (e.g., a silent audio track playing in the background).
 * - When the screen is locked, some browsers may suspend Media Session API
 *   entirely depending on OS background activity restrictions.
 * - For consistent background operation, consider a native wrapper (e.g., Capacitor
 *   with custom plugins for button events).
 */

export interface EarbudSubDetectorOpts {
  triggerDetector: TriggerDetector;
}

export const EARBUD_TRIPLE_CLICK_WINDOW_MS = 3000;
const EARBUD_SIGNAL_DEDUP_MS = 20;

export function registerEarbudClick(
  clicks: number[],
  signaledAt: number,
  lastSignalAt: number | null
): { clicks: number[]; fired: boolean; lastSignalAt: number } {
  // A single physical press can surface twice (e.g. Media Session + key event).
  if (lastSignalAt !== null && signaledAt - lastSignalAt < EARBUD_SIGNAL_DEDUP_MS) {
    return {
      clicks,
      fired: false,
      lastSignalAt,
    };
  }

  const nextClicks = clicks.filter((clickAt) => signaledAt - clickAt <= EARBUD_TRIPLE_CLICK_WINDOW_MS);
  nextClicks.push(signaledAt);

  return {
    clicks: nextClicks.length >= 3 ? [] : nextClicks,
    fired: nextClicks.length >= 3,
    lastSignalAt: signaledAt,
  };
}

export class EarbudSubDetector {
  private triggerDetector: TriggerDetector;
  private clicks: number[] = [];
  private lastSignalAt: number | null = null;

  constructor(opts: EarbudSubDetectorOpts) {
    this.triggerDetector = opts.triggerDetector;

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleEarbudClick = this.handleEarbudClick.bind(this);
    this.handleNativeBridgeEvent = this.handleNativeBridgeEvent.bind(this);

    this.registerListeners();
  }

  private registerListeners(): void {
    console.log("[EarbudSubDetector] registerListeners() called");

    if (typeof window !== "undefined") {
      // --- Primary path (Capacitor Android native) ---
      // MainActivity.java intercepts KEYCODE_HEADSETHOOK / KEYCODE_MEDIA_PREVIOUS /
      // KEYCODE_MEDIA_NEXT and fires this custom DOM event via getBridge().triggerJSEvent().
      window.addEventListener("earbudClick", this.handleNativeBridgeEvent);
      console.log("[EarbudSubDetector] ✅ Native bridge listener registered: earbudClick");

      // --- Fallback path (browser / desktop keyboard) ---
      window.addEventListener("keydown", this.handleKeyDown);
      console.log("[EarbudSubDetector] ✅ Keydown listener added (browser fallback)");
    }

    // --- Media Session (browser-only fallback; not available in Capacitor WebView) ---
    if (
      typeof navigator !== "undefined" &&
      navigator.mediaSession &&
      typeof navigator.mediaSession.setActionHandler === "function"
    ) {
      try {
        navigator.mediaSession.setActionHandler("previoustrack", this.handleEarbudClick);
        navigator.mediaSession.setActionHandler("nexttrack", this.handleEarbudClick);
        console.log("[EarbudSubDetector] ✅ MediaSession handlers registered (browser fallback)");
      } catch (e) {
        console.warn("[EarbudSubDetector] ⚠️ MediaSession handler registration failed", e);
      }
    } else {
      console.warn("[EarbudSubDetector] ℹ️ MediaSession API not available (expected in Capacitor WebView — native bridge is primary path)");
    }
  }

  /**
   * Called by the Capacitor native bridge (MainActivity.java → triggerJSEvent).
   * event.detail contains { keyCode: number }.
   */
  private handleNativeBridgeEvent(event: Event): void {
    const keyCode = (event as CustomEvent<{ keyCode: number }>).detail?.keyCode ?? 0;
    console.log("[EarbudSubDetector] 🎧 Native bridge earbudClick received, keyCode=", keyCode);
    this.handleEarbudClick();
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "MediaTrackPrevious" || event.key === "MediaTrackNext"
        || event.key === "MediaPlayPause") {
      console.log("[EarbudSubDetector] ⌨️ Keydown media key:", event.key);
      this.handleEarbudClick();
    }
  }

  public handleEarbudClick(): void {
    const now = Date.now();
    console.log("[EarbudSubDetector] 🎧 Click registered at", now);

    const result = registerEarbudClick(this.clicks, now, this.lastSignalAt);
    this.clicks = result.clicks;
    this.lastSignalAt = result.lastSignalAt;
    console.log("[EarbudSubDetector] Current clicks count:", this.clicks.length, "timestamps:", JSON.stringify(this.clicks), "Fired?", result.fired);

    if (result.fired) {
      console.log("[EarbudSubDetector] Triggering SOS at", now);
      this.triggerDetector.onTriggerFired("earbud", new Date(now));
    }
  }

  public destroy(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("earbudClick", this.handleNativeBridgeEvent);
      window.removeEventListener("keydown", this.handleKeyDown);
    }

    if (
      typeof navigator !== "undefined" &&
      navigator.mediaSession &&
      typeof navigator.mediaSession.setActionHandler === "function"
    ) {
      try {
        navigator.mediaSession.setActionHandler("previoustrack", null);
        navigator.mediaSession.setActionHandler("nexttrack", null);
      } catch (e) {
        // Ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ShakeSubDetector
// ---------------------------------------------------------------------------

/**
 * ShakeSubDetector wires the Android Foreground Service shake detection into
 * the TriggerDetector pipeline.
 *
 * On Android (Capacitor): calls the injected ShakeBridge to start/stop the
 * ShakeDetectorService, then listens for the "shakeDetected" custom DOM event
 * that the service fires via getBridge().triggerJSEvent().
 *
 * On web/browser: falls back to DeviceMotion API (best-effort).
 *
 * The ShakeBridge interface is injected by the caller (useSilentActivation hook)
 * so this module stays free of @capacitor/core imports and works in both the
 * pure TS test environment and the Capacitor app bundle.
 */

/**
 * Pure function: processes one above-threshold DeviceMotion event at timestamp `now`.
 * Returns updated state and whether the shake trigger should fire.
 * Exported for unit testing without requiring fake timers.
 *
 * Constants mirror ShakeSubDetector's private fields:
 *   DM_DEDUP_MS  = 300   — minimum ms between counted shake events
 *   DM_WINDOW_MS = 2000  — rolling window for DM_COUNT events
 *   DM_COUNT     = 3     — events needed to fire
 */
export function registerDeviceMotionShake(
  shakeTimes: number[],
  lastShakeAt: number,
  now: number,
): { shakeTimes: number[]; lastShakeAt: number; fired: boolean } {
  const DM_DEDUP_MS  = 300;
  const DM_WINDOW_MS = 2000;
  const DM_COUNT     = 3;

  if (lastShakeAt > 0 && now - lastShakeAt < DM_DEDUP_MS) {
    return { shakeTimes, lastShakeAt, fired: false };
  }

  const updated = shakeTimes.filter((t) => now - t <= DM_WINDOW_MS);
  updated.push(now);

  if (updated.length >= DM_COUNT) {
    return { shakeTimes: [], lastShakeAt: now, fired: true };
  }

  return { shakeTimes: updated, lastShakeAt: now, fired: false };
}

/** Minimum net acceleration (m/s²) required to count as a shake event in DeviceMotion fallback. */
const DM_THRESHOLD = 25;

export interface ShakeBridgeInterface {
  startShakeDetector(options?: { sensitivity?: number }): Promise<void>;
  stopShakeDetector(): Promise<void>;
}

export interface ShakeSubDetectorOpts {
  triggerDetector: TriggerDetector;
  /** Injected by the app layer — Capacitor ShakeBridge plugin instance */
  bridge?: ShakeBridgeInterface;
  /**
   * Shake sensitivity level passed to the Android service.
   * 1=light, 2=medium (default), 3=strong.
   */
  sensitivity?: 1 | 2 | 3;
}

export class ShakeSubDetector {
  private triggerDetector: TriggerDetector;
  private bridge?: ShakeBridgeInterface;
  private sensitivity: 1 | 2 | 3;
  private handleShakeEvent: (event: Event) => void;

  // DeviceMotion fallback state (browser only)
  private dmShakeTimes: number[] = [];
  private dmLastShakeAt = 0;

  constructor(opts: ShakeSubDetectorOpts) {
    this.triggerDetector = opts.triggerDetector;
    this.bridge = opts.bridge;
    this.sensitivity = opts.sensitivity ?? 2;
    this.handleShakeEvent = this.onShakeDetected.bind(this);
    this.register();
  }

  private register(): void {
    if (typeof window === "undefined") return;

    // Primary path: native Android bridge event
    window.addEventListener("shakeDetected", this.handleShakeEvent);
    console.log("[ShakeSubDetector] ✅ Native bridge listener registered: shakeDetected");

    if (this.bridge) {
      this.bridge.startShakeDetector({ sensitivity: this.sensitivity })
        .then(() => console.log("[ShakeSubDetector] ✅ ShakeDetectorService started (sensitivity=" + this.sensitivity + ")"))
        .catch((err: unknown) => {
          console.warn("[ShakeSubDetector] ShakeBridge.startShakeDetector() failed, falling back to DeviceMotion:", err);
          this.registerDeviceMotionFallback();
        });
    } else {
      // No bridge injected — must be running in browser, use DeviceMotion
      console.warn("[ShakeSubDetector] No ShakeBridge injected, using DeviceMotion fallback");
      this.registerDeviceMotionFallback();
    }
  }

  private onShakeDetected(): void {
    console.log("[ShakeSubDetector] 🤝 shakeDetected event received from native bridge");
    this.triggerDetector.onTriggerFired("shake", new Date());
  }

  // ── DeviceMotion fallback (browser / non-Capacitor) ─────────────────────

  private handleDeviceMotion = (event: DeviceMotionEvent): void => {
    const acc = event.accelerationIncludingGravity;
    if (!acc) return;
    const magnitude = Math.sqrt(
      (acc.x ?? 0) ** 2 + (acc.y ?? 0) ** 2 + (acc.z ?? 0) ** 2
    );
    const net = Math.abs(magnitude - 9.81);
    if (net < DM_THRESHOLD) return;

    const now = Date.now();
    const result = registerDeviceMotionShake(
      this.dmShakeTimes,
      this.dmLastShakeAt,
      now,
    );
    this.dmShakeTimes = result.shakeTimes;
    this.dmLastShakeAt = result.lastShakeAt;

    console.log("[ShakeSubDetector] DeviceMotion shake, count=", this.dmShakeTimes.length);

    if (result.fired) {
      console.log("[ShakeSubDetector] 🤝 DeviceMotion shake trigger fired");
      this.triggerDetector.onTriggerFired("shake", new Date());
    }
  };

  private registerDeviceMotionFallback(): void {
    if (typeof window !== "undefined" && "DeviceMotionEvent" in window) {
      window.addEventListener("devicemotion", this.handleDeviceMotion);
      console.log("[ShakeSubDetector] ✅ DeviceMotion fallback registered");
    } else {
      console.warn("[ShakeSubDetector] ⚠️ DeviceMotion not available");
    }
  }

  public destroy(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("shakeDetected", this.handleShakeEvent);
      window.removeEventListener("devicemotion", this.handleDeviceMotion);
    }
    this.bridge?.stopShakeDetector()
      .then(() => console.log("[ShakeSubDetector] ShakeDetectorService stopped"))
      .catch(() => { /* not on Android, ignore */ });
  }
}
