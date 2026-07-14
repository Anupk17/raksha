/**
 * Timestamp deserialization guard.
 *
 * All timestamp fields on evidence documents and chain-of-custody entries
 * MUST be JavaScript native Date objects. Firestore's SDK may deserialize
 * them as Firestore Timestamp objects in some configurations, causing
 * runtime failures in later comparisons.
 *
 * This module provides fail-loud deserialization: if a timestamp field is
 * not instanceof Date, the operation MUST abort — never silently substitute
 * null, undefined, or an incorrect type.
 *
 * Usage in every Cloud Function that reads Firestore evidence data:
 *
 *   const data = doc.data();
 *   const createdAt    = assertDate(data.createdAt,    'createdAt');
 *   const updatedAt    = assertDate(data.updatedAt,    'updatedAt');
 *   const capturedAt   = assertDate(data.metadata?.capturedAt, 'metadata.capturedAt');
 *
 * If Firestore returns a Timestamp object, call .toDate() at the boundary
 * and then pass through assertDate:
 *
 *   const raw = data.createdAt;
 *   const createdAt = assertDate(
 *     raw instanceof Timestamp ? raw.toDate() : raw,
 *     'createdAt'
 *   );
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4
 * Design: §Timestamp Handling Rules
 */

/**
 * Thrown when a Firestore timestamp field deserializes as something other
 * than a native Date.
 */
export class TimestampDeserializationError extends Error {
  constructor(
    public readonly fieldName: string,
    public readonly actualType: string,
    public readonly actualValue: unknown
  ) {
    super(
      `assertDate: field '${fieldName}' deserialized as ${actualType} (expected Date). ` +
        `Aborting operation to prevent data corruption. ` +
        `Check Firestore SDK settings — timestamps should be returned as Date objects.`
    );
    this.name = "TimestampDeserializationError";
  }
}

/**
 * Asserts that a value is a JavaScript native Date.
 *
 * @param value     - The value read from a Firestore document field.
 * @param fieldName - Human-readable field path for the error message.
 * @returns The value cast to Date.
 * @throws TimestampDeserializationError if value is not instanceof Date.
 */
export function assertDate(value: unknown, fieldName: string): Date {
  if (!(value instanceof Date)) {
    throw new TimestampDeserializationError(
      fieldName,
      value === null ? "null" : value === undefined ? "undefined" : typeof value,
      value
    );
  }
  // Guard against Invalid Date (e.g. new Date("garbage"))
  if (isNaN(value.getTime())) {
    throw new TimestampDeserializationError(
      fieldName,
      "Date(Invalid)",
      value
    );
  }
  return value;
}

/**
 * Deserializes a Firestore timestamp field that may arrive as either a native
 * Date or a Firestore Timestamp (Admin SDK returns Timestamp on read).
 */
export function deserializeFirestoreDate(
  value: unknown,
  fieldName: string
): Date {
  if (value && typeof (value as { toDate?: unknown }).toDate === "function") {
    return assertDate((value as { toDate: () => Date }).toDate(), fieldName);
  }
  return assertDate(value, fieldName);
}

/**
 * Like assertDate, but accepts null (for nullable timestamp fields such as
 * retentionExpiresAt and revokedAt).
 *
 * @returns The value as Date, or null.
 * @throws TimestampDeserializationError if value is non-null and not a valid Date.
 */
export function assertDateOrNull(
  value: unknown,
  fieldName: string
): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return deserializeFirestoreDate(value, fieldName);
}

// ---------------------------------------------------------------------------
// ISO 8601 string → Date  (callable payload boundary)
// ---------------------------------------------------------------------------

/**
 * Strictly parses an ISO 8601 string from a callable payload into a native
 * Date, throwing loudly on any malformed input.
 *
 * WHY THIS EXISTS — the problem with bare new Date(isoString):
 *
 *   JavaScript's Date constructor is extremely lenient.  It silently accepts:
 *     - "2025-6-1"         (non-padded month/day)
 *     - "June 1 2025"      (locale string)
 *     - "1717257600000"    (numeric string — parses as NaN in some engines,
 *                           as a large year in others)
 *     - ""                 (epoch in some engines, Invalid Date in others)
 *
 *   All of these either produce a wrong-but-valid Date or an Invalid Date.
 *   assertDate() only validates the Date *output* — it cannot distinguish a
 *   correctly-parsed ISO date from a Date built from a garbage input that
 *   happened to not be NaN.
 *
 *   The attack surface is the callable payload: a client (or attacker) may
 *   send triggeredAt / syncedAt values that are not ISO 8601.  A bare
 *   new Date(payload.triggeredAt) will silently accept them and produce a
 *   Date that passes assertDate but carries the wrong value.
 *
 * WHAT THIS FUNCTION DOES:
 *   1. Rejects non-string inputs immediately.
 *   2. Validates the string against a strict ISO 8601 regex (both date-only
 *      and datetime-with-offset forms) before calling new Date().
 *   3. Runs assertDate() on the result — belt-and-suspenders against any
 *      edge case the regex admits but Date rejects.
 *   4. Throws PayloadTimestampError (a subclass of TimestampDeserializationError)
 *      with the field name, rejected value, and reason.
 *
 * USAGE in createSOSSession and any other callable that receives timestamps:
 *
 *   const triggeredAt = parseISODate(data.triggeredAt, 'triggeredAt');
 *   const syncedAt    = parseISODate(data.syncedAt,    'syncedAt');
 *
 * These are the ONLY safe entry points.  Do NOT use new Date() on payload
 * strings anywhere in the silent-activation code path.
 *
 * Design: RAKSHA Technical Design — Discreet Silent Activation §createSOSSession
 * Requirements: tasks.md Task 2.2, Task 2.3
 */

/**
 * Thrown when a callable payload timestamp string fails ISO 8601 validation.
 * Distinct from TimestampDeserializationError (which covers Firestore reads)
 * so callers can catch the two failure modes separately if needed.
 */
export class PayloadTimestampError extends Error {
  constructor(
    public readonly fieldName: string,
    public readonly rejectedValue: unknown,
    public readonly reason: string
  ) {
    super(
      `parseISODate: field '${fieldName}' is not a valid ISO 8601 timestamp. ` +
        `Reason: ${reason}. ` +
        `Received: ${JSON.stringify(rejectedValue)}`
    );
    this.name = "PayloadTimestampError";
  }
}

/**
 * Strict ISO 8601 regex.
 *
 * Accepts:
 *   - Full datetime with UTC offset: 2025-06-01T12:00:00Z
 *   - Full datetime with numeric offset: 2025-06-01T12:00:00+05:30
 *   - Full datetime with milliseconds: 2025-06-01T12:00:00.123Z
 *   - Date-only: 2025-06-01  (parsed as midnight UTC)
 *
 * Rejects:
 *   - Locale strings ("June 1 2025")
 *   - Non-padded month/day ("2025-6-1")
 *   - Numeric strings ("1717257600000")
 *   - Empty strings
 *   - Partial times without seconds ("2025-06-01T12:00")
 *
 * Note: this regex validates structure, not calendar correctness
 * (e.g. month=13 passes the regex but produces Invalid Date — assertDate
 * catches that via the isNaN check).
 */
const ISO_8601_RE =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

/**
 * Parses a strict ISO 8601 string from a callable payload into a native Date.
 *
 * @param value     - The raw value from the callable payload field.
 * @param fieldName - Human-readable field path for error messages.
 * @returns A validated native Date.
 * @throws PayloadTimestampError if the input is not a string or fails the ISO regex.
 * @throws TimestampDeserializationError if the parsed Date is Invalid (belt-and-suspenders).
 */
export function parseISODate(value: unknown, fieldName: string): Date {
  if (typeof value !== "string") {
    throw new PayloadTimestampError(
      fieldName,
      value,
      `expected a string, got ${value === null ? "null" : typeof value}`
    );
  }
  if (!ISO_8601_RE.test(value)) {
    throw new PayloadTimestampError(
      fieldName,
      value,
      "does not match strict ISO 8601 format (YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DD)"
    );
  }
  
  // Extract date components directly via slices (safe because regex guaranteed the format)
  const year = parseInt(value.slice(0, 4), 10);
  const month = parseInt(value.slice(5, 7), 10) - 1; // 0-based month
  const day = parseInt(value.slice(8, 10), 10);
  
  // Verify calendar validity by checking if Date.UTC rolls over the values
  const temp = new Date(Date.UTC(year, month, day));
  if (
    temp.getUTCFullYear() !== year ||
    temp.getUTCMonth() !== month ||
    temp.getUTCDate() !== day
  ) {
    throw new PayloadTimestampError(
      fieldName,
      value,
      "calendar-impossible date (e.g. February 30)"
    );
  }

  const d = new Date(value);
  return assertDate(d, fieldName);
}

