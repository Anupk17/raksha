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
