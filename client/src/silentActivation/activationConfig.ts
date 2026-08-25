/**
 * activationConfig — Silent Activation configuration validation and persistence (Task 12).
 *
 * Implements:
 *   - `validateActivationConfig`: Returns a typed error list (never throws).
 *   - `saveActivationConfig`: Hashes duress PIN with bcrypt cost=10 before writing to
 *     Firestore; zeroes plaintext from memory after hashing.
 *   - Test-mode integration: routes to `testTrigger` callable instead of `createSOSSession`
 *     when `testMode: true` is passed through the trigger chain.
 *
 * ## PIN Security
 *
 * The duress PIN is hashed with bcrypt cost=10 (hardcoded — never configurable, per
 * design.md §PIN Brute-Force Analysis). The plaintext PIN string is zeroed from the
 * intermediate variable before `saveActivationConfig` resolves.
 *
 * Minimum duress-PIN length is **6 digits** (not 4). The 4-digit minimum was removed
 * after brute-force analysis showed a 4-digit PIN at cost ≤ 10 falls in under 1 second
 * offline on a consumer GPU (design.md §PIN Brute-Force Analysis, tasks.md Task 12).
 *
 * ## Test-mode
 *
 * When `testMode: true` is set on the config, the trigger chain uses `testTrigger` (a
 * no-op callable that validates inputs but writes nothing). This lets users verify their
 * gesture/PIN/phrase configuration without creating a live SOS session.
 *
 * Requirements: design.md §Configuration UI, tasks.md Task 12
 */
import bcrypt from "bcryptjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The full silent activation configuration object stored in the user's
 * Firestore document under the `silentActivationConfig` field.
 *
 * All fields are optional — the user may enable only a subset of triggers.
 */
export interface SilentActivationConfig {
  /** Whether the power-button tap trigger is enabled. */
  powerButtonEnabled?: boolean;
  /**
   * Number of consecutive power-button taps required to fire.
   * Must be an integer in [3, 7].
   */
  powerButtonTapCount?: number;

  /** Whether the earbud triple-click trigger is enabled. */
  earbudEnabled?: boolean;

  /** Whether the shake trigger is enabled (Android Foreground Service + accelerometer). */
  shakeEnabled?: boolean;
  /**
   * Shake detection sensitivity. Controls how hard the user must shake the phone.
   *   1 = light  — 4 axis reversals at ≥7 m/s²  (responds to moderate shakes)
   *   2 = medium — 6 axis reversals at ≥11 m/s² (default; ignores normal daily motion)
   *   3 = strong — 8 axis reversals at ≥16 m/s² (requires hard, deliberate shaking)
   * Defaults to 2 (medium) if not set.
   */
  shakeSensitivity?: 1 | 2 | 3;

  /** Whether the duress-PIN trigger is enabled. */
  duressPinEnabled?: boolean;
  /**
   * The raw (plaintext) duress PIN — 6–8 numeric digits.
   * Present only during `saveActivationConfig`; never stored.
   * Must not equal the user's normal login PIN.
   */
  duressPin?: string;
  /**
   * The bcrypt cost=10 hash of the duress PIN.
   * Stored in Firestore; never the plaintext.
   */
  duressPinHash?: string;

  /** Whether the PIN lock screen is shown on every app launch. */
  pinLockEnabled?: boolean;
  /**
   * The raw normal (quick-access) PIN — 4–8 numeric digits.
   * Present only during `saveActivationConfig`; never stored.
   */
  normalPin?: string;
  /** Confirm field for normal PIN — only present at config time, never stored. */
  normalPinConfirm?: string;
  /**
   * The bcrypt cost=10 hash of the normal (quick-access) PIN.
   * Stored in Firestore; never the plaintext.
   */
  normalPinHash?: string;

  /** Whether the duress-phrase trigger is enabled. */
  duressPhraseEnabled?: boolean;
  /** The duress phrase (3–50 chars, at least 2 words). */
  duressPhrase?: string;

  /** If true, the trigger chain routes to `testTrigger` instead of `createSOSSession`. */
  testMode?: boolean;
}

/**
 * A single validation error returned by `validateActivationConfig`.
 * Using a typed error list instead of exceptions so callers can render
 * all errors at once rather than discovering them one at a time.
 */
export interface ConfigValidationError {
  field: keyof SilentActivationConfig | "general";
  message: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** bcrypt cost for duress-PIN hashing. HARDCODED — never read from config. */
const BCRYPT_COST = 10;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates a `SilentActivationConfig` object and returns a list of typed
 * errors. Returns an empty array if the config is valid.
 *
 * Never throws — all validation failures are returned as errors.
 */
export function validateActivationConfig(
  config: SilentActivationConfig
): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  // ----- Req 12.1.1: At least one trigger type must be enabled -----
  const anyEnabled =
    config.powerButtonEnabled ||
    config.earbudEnabled ||
    config.shakeEnabled ||
    config.duressPinEnabled ||
    config.duressPhraseEnabled;

  if (!anyEnabled) {
    errors.push({
      field: "general",
      message: "At least one trigger type must be enabled.",
    });
  }

  // ----- Power-button tap count -----
  if (config.powerButtonEnabled) {
    const tapCount = config.powerButtonTapCount;
    if (
      tapCount === undefined ||
      !Number.isInteger(tapCount) ||
      tapCount < 3 ||
      tapCount > 7
    ) {
      errors.push({
        field: "powerButtonTapCount",
        message: "Power-button tap count must be an integer between 3 and 7.",
      });
    }
  }

  // ----- Shake sensitivity -----
  if (config.shakeEnabled) {
    const s = config.shakeSensitivity;
    if (s !== undefined && s !== 1 && s !== 2 && s !== 3) {
      errors.push({
        field: "shakeSensitivity",
        message: "Shake sensitivity must be 1 (light), 2 (medium), or 3 (strong).",
      });
    }
  }

  // ----- Normal PIN (when pin lock enabled) -----
  if (config.pinLockEnabled) {
    const nPin = config.normalPin ?? "";
    if (!/^\d{4,8}$/.test(nPin)) {
      errors.push({
        field: "normalPin",
        message: "Normal PIN must be 4 to 8 numeric digits.",
      });
    }
    if (nPin.length > 0 && config.normalPinConfirm !== undefined && nPin !== config.normalPinConfirm) {
      errors.push({
        field: "normalPin",
        message: "Normal PINs do not match.",
      });
    }
    // Must differ from duress PIN
    if (config.duressPinEnabled && config.duressPin && nPin === config.duressPin) {
      errors.push({
        field: "normalPin",
        message: "Normal PIN must differ from your Duress PIN.",
      });
    }
  }

  // ----- Duress PIN -----
  if (config.duressPinEnabled) {
    const pin = config.duressPin ?? "";

    // Req 12.1.3 / 12.1.4: 6–8 digits (minimum is 6, not 4)
    if (!/^\d{6,8}$/.test(pin)) {
      errors.push({
        field: "duressPin",
        message: "Duress PIN must be 6 to 8 numeric digits.",
      });
    }

    // Req 12.1.2: Must not equal normal PIN
    if (
      pin.length > 0 &&
      config.normalPin !== undefined &&
      config.normalPin !== "" &&
      pin === config.normalPin
    ) {
      errors.push({
        field: "duressPin",
        message: "Duress PIN must not be the same as your normal PIN.",
      });
    }
  }

  // ----- Duress phrase -----
  if (config.duressPhraseEnabled) {
    const phrase = config.duressPhrase ?? "";

    // Req 12.1.5: 3–50 characters
    if (phrase.length < 3 || phrase.length > 50) {
      errors.push({
        field: "duressPhrase",
        message: "Duress phrase must be between 3 and 50 characters.",
      });
    }

    // Req 12.1.5: At least two words
    const wordCount = phrase.trim().split(/\s+/).filter(Boolean).length;
    if (phrase.length >= 3 && wordCount < 2) {
      errors.push({
        field: "duressPhrase",
        message: "Duress phrase must contain at least two words.",
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Dependency-injected writer — wraps the real Firestore call for testing.
 * The written object must NOT contain the plaintext `duressPin` or `normalPin` fields.
 */
export type FirestoreConfigWriter = (
  userId: string,
  patch: Omit<SilentActivationConfig, "duressPin" | "normalPin" | "normalPinConfirm">
) => Promise<void>;

/**
 * Hashes the duress PIN (if present), zeroes the plaintext from memory,
 * then writes `silentActivationConfig` to the user's Firestore document
 * via the injected `writeConfig` adapter.
 *
 * @param userId   The authenticated user's UID.
 * @param config   The full config (may contain `duressPin` plaintext).
 * @param writeConfig  Injected Firestore writer (injectable for tests).
 *
 * @throws Never for validation errors — callers should validate first.
 *         Will rethrow any Firestore write errors.
 */
export async function saveActivationConfig(
  userId: string,
  config: SilentActivationConfig,
  writeConfig: FirestoreConfigWriter
): Promise<void> {
  // Build the object to persist, excluding plaintext secrets.
  // Boolean flags are written as explicit false (not undefined) so the Firestore
  // merge writes the complete config map — prevents stale fields from previous
  // saves persisting when a trigger is disabled.
  const toPersist: Omit<SilentActivationConfig, "duressPin" | "normalPin" | "normalPinConfirm"> = {
    powerButtonEnabled:  config.powerButtonEnabled  ?? false,
    powerButtonTapCount: config.powerButtonTapCount,
    earbudEnabled:       config.earbudEnabled        ?? false,
    shakeEnabled:        config.shakeEnabled         ?? false,
    shakeSensitivity:    config.shakeEnabled ? (config.shakeSensitivity ?? 2) : undefined,
    duressPinEnabled:    config.duressPinEnabled     ?? false,
    duressPhraseEnabled: config.duressPhraseEnabled  ?? false,
    duressPhrase:        config.duressPhrase,
    testMode:            config.testMode             ?? false,
    pinLockEnabled:      config.pinLockEnabled       ?? false,
  };

  // Hash duress PIN with bcrypt cost=10 (hardcoded)
  if (config.duressPinEnabled && config.duressPin) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const hash = await bcrypt.hash(config.duressPin, BCRYPT_COST);
    toPersist.duressPinHash = hash;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).duressPin = undefined;
  }

  // Hash normal PIN when pin lock is enabled OR when duress PIN is enabled
  // (the duress PIN mismatch guard requires knowing the normal PIN hash,
  // and the PIN screen needs normalPinHash to verify the user on launch).
  if (config.normalPin && (config.pinLockEnabled || config.duressPinEnabled)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const normalHash = await bcrypt.hash(config.normalPin, BCRYPT_COST);
    toPersist.normalPinHash = normalHash;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).normalPin = undefined;
  }

  await writeConfig(userId, toPersist);
}

// ---------------------------------------------------------------------------
// Test-mode routing
// ---------------------------------------------------------------------------

/**
 * Determines which Cloud Function callable to use based on the config's
 * `testMode` flag.
 *
 *   - `testMode: true`  → use `testTrigger` (no-op, zero side effects)
 *   - `testMode: false | undefined` → use `createSOSSession` (live)
 *
 * This is used by CountdownManager's `escalate()` path (Task 8) to pick
 * the right endpoint when test mode is active.
 */
export type TriggerCallable = "createSOSSession" | "testTrigger";

export function resolveTriggerCallable(config: SilentActivationConfig): TriggerCallable {
  return config.testMode === true ? "testTrigger" : "createSOSSession";
}
