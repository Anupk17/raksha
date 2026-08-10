/**
 * evidenceTimestamp — timestamp deserialization and display utilities.
 *
 * All evidence timestamps are stored as native Date objects. When read from
 * Firestore via the JS SDK they may arrive as Firestore Timestamp objects
 * (depending on SDK settings), native Date, or ISO strings. This module
 * normalises all three cases at the deserialization boundary so that React
 * state only ever holds native Date objects.
 *
 * Design: §Shared Utilities — evidenceTimestamp.ts
 * Requirements: 7.1, 7.2, 7.5
 */

/** Shape of a Firestore Timestamp as returned by the JS SDK. */
interface FirestoreTimestampLike {
  toDate(): Date;
}

function isFirestoreTimestamp(value: unknown): value is FirestoreTimestampLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as FirestoreTimestampLike).toDate === 'function'
  );
}

/**
 * Converts a value that may be a Firestore Timestamp, a native Date, or an
 * ISO 8601 string into a native Date. Returns null if the value is
 * null/undefined or cannot be converted.
 */
export function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (isFirestoreTimestamp(value)) return value.toDate();
  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Like toDate but throws if the value cannot be converted to a valid Date.
 * Use for required timestamp fields where null would indicate data corruption.
 */
export function requireDate(value: unknown, fieldName: string): Date {
  const d = toDate(value);
  if (!d) {
    throw new Error(
      `EvidenceUI: required timestamp field '${fieldName}' could not be ` +
      `deserialized (got ${value === null ? 'null' : typeof value})`
    );
  }
  return d;
}

/**
 * Formats a Date for display as "Jan 15, 2026, 3:42 PM".
 * Operates entirely on native Date — never accepts Firestore Timestamps.
 */
export function formatTimestamp(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year:   'numeric',
    month:  'short',
    day:    'numeric',
    hour:   'numeric',
    minute: '2-digit',
  });
}
