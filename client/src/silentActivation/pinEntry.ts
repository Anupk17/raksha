/**
 * PinEntry — constant-time duress PIN evaluation and decoy screen routing (Task 10).
 *
 * Implements:
 *   - Constant-time evaluation to prevent timing side-channel attacks on PINs.
 *   - Startup calibration of bcrypt cost=10 time (P22 timing parity).
 *   - Route to decoy screen on duress PIN match.
 *   - Navigation suppression on decoy screen.
 *
 * Requirements: design.md §DuressPIN Sub-Detector, tasks.md Task 10
 */
import bcrypt from "bcryptjs";

// ---------------------------------------------------------------------------
// Constants & State
// ---------------------------------------------------------------------------

/**
 * Valid cost=10 bcrypt dummy hash matching ^\$2[abx]\$10\$[./A-Za-z0-9]{53}$
 * Used as padding when no duress PIN is set.
 */
export const STATIC_DUMMY_HASH = "$2a$10$abcdefghijklmnopqrstuvwABCDEFGHIJKLMNOPQRSTUVXYZ123456";

let measuredP95BcryptCost10Ms = 250; // Fallback before calibration

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Runs 5 timed samples of bcrypt.compare against a dummy hash to calibrate
 * the P95 execution duration of cost=10 on this specific device/runtime.
 */
export async function calibrateBcrypt(): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await bcrypt.compare("dummy_pin", STATIC_DUMMY_HASH);
    samples.push(Date.now() - t0);
  }
  samples.sort((a, b) => a - b);
  measuredP95BcryptCost10Ms = samples[samples.length - 1]; // P95/max of 5 samples
  return measuredP95BcryptCost10Ms;
}

export function getCachedP95(): number {
  return measuredP95BcryptCost10Ms;
}

/** Set the cached P95 manually (primarily for testing timing bounds). */
export function setCachedP95(ms: number): void {
  measuredP95BcryptCost10Ms = ms;
}

// ---------------------------------------------------------------------------
// Decoy Screen & Navigation Suppression
// ---------------------------------------------------------------------------

let popstateListenerRegistered = false;

function onPopState(): void {
  if (typeof window !== "undefined") {
    // Push state again to overwrite back navigation
    window.history.pushState(null, "", window.location.href);
  }
}

/**
 * Suppresses back-button and swipe navigation for the duration of the decoy
 * session by hijacking history popstate events.
 */
export function suppressNavigation(): void {
  if (typeof window === "undefined") return;

  // Add dummy history entry
  window.history.pushState(null, "", window.location.href);

  if (!popstateListenerRegistered) {
    window.addEventListener("popstate", onPopState);
    popstateListenerRegistered = true;
  }
}

export function releaseNavigation(): void {
  if (typeof window === "undefined") return;
  if (popstateListenerRegistered) {
    window.removeEventListener("popstate", onPopState);
    popstateListenerRegistered = false;
  }
}

// ---------------------------------------------------------------------------
// PIN Entry Handler
// ---------------------------------------------------------------------------

export interface PinEntryEvaluatorOpts {
  triggerDetector: { onTriggerFired: (type: any, firedAt: Date) => void };
  duressHash: string | null;
  verifyNormalPinViaServer: (pin: string) => Promise<boolean>;
  renderDecoyScreen: () => void;
  renderWrongPinError: () => void;
  navigateToHome: () => void;
}

/**
 * Evaluates candidate PIN in constant time (timing parity).
 * Checks duress PIN first; wrong-PIN and duress-PIN paths are padded
 * to ensure timing parity. Normal-PIN success path is not padded.
 */
export async function handlePinSubmission(
  candidatePin: string,
  opts: PinEntryEvaluatorOpts
): Promise<void> {
  const firedAt = new Date(); // first line of handler (Task 10.1)

  const hashToCompare = opts.duressHash ?? STATIC_DUMMY_HASH;

  // Run duress check AND normal-PIN check in parallel so both complete by the
  // deadline. This ensures renderWrongPinError fires at the same wall-clock
  // time as renderDecoyScreen — verifyNormalPinViaServer does NOT add latency
  // after the deadline, which was the P33 failure mode.
  const [duressMatch, isNormalMatch] = await Promise.all([
    bcrypt.compare(candidatePin, hashToCompare),
    opts.verifyNormalPinViaServer(candidatePin),
  ]);

  // Timing parity deadline: firedAt + P95 + 20ms margin.
  // Both bcrypt.compare (duress) and verifyNormalPinViaServer (normal) have
  // already completed above — the deadline pad only needs to cover the slower
  // of the two, which is the duress bcrypt.compare at cost=10.
  const deadline = firedAt.getTime() + measuredP95BcryptCost10Ms + 20;
  const delay = deadline - Date.now();
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  if (duressMatch) {
    opts.renderDecoyScreen();
    opts.triggerDetector.onTriggerFired("duress_pin", firedAt);
  } else if (isNormalMatch) {
    opts.navigateToHome();
  } else {
    opts.renderWrongPinError();
  }
}
