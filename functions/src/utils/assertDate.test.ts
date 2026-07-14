/**
 * Tests for assertDate, assertDateOrNull, and parseISODate.
 *
 * Core guarantee (Req 10.3, 10.4, Design §Timestamp Handling Rules):
 *   - Valid Date passes through unchanged
 *   - null / undefined / string / number / Firestore-Timestamp-shaped object
 *     all throw TimestampDeserializationError
 *   - Invalid Date (NaN) throws
 *   - assertDateOrNull accepts null/undefined, delegates the rest to assertDate
 *
 * parseISODate guarantee (design.md §createSOSSession, tasks.md Task 2.2–2.3):
 *   - Strict ISO 8601 validation before new Date() — rejects lenient strings
 *     that bare new Date() silently accepts ("June 1 2025", "2025-6-1", etc.)
 *   - Throws PayloadTimestampError with field name, rejected value, and reason
 *   - assertDate belt-and-suspenders on the output (catches calendar-impossible
 *     dates the regex admits: e.g. 2025-02-30)
 *
 * Feature: evidence-trail, Task 1.2: assertDate — fail-loud timestamp guard
 * Feature: silent-activation, payload deserialization boundary
 * Property 17: Timestamp Type Invariant
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  assertDate,
  assertDateOrNull,
  parseISODate,
  TimestampDeserializationError,
  PayloadTimestampError,
} from "./assertDate.js";


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mimics the shape of a Firestore Timestamp (not instanceof Date). */
const firestoreTimestampLike = {
  seconds: 1_700_000_000,
  nanoseconds: 0,
  toDate: () => new Date(1_700_000_000_000),
};

// ---------------------------------------------------------------------------
// assertDate
// ---------------------------------------------------------------------------

describe("assertDate — happy path", () => {
  it("returns a valid Date unchanged", () => {
    const d = new Date("2024-01-15T12:00:00Z");
    expect(assertDate(d, "createdAt")).toBe(d);
  });

  it(
    "property P17: for any valid Date, assertDate returns the same Date",
    () => {
      // Feature: evidence-trail, Property 17: Timestamp Type Invariant
      fc.assert(
        fc.property(
          fc.date({ min: new Date("2000-01-01"), max: new Date("2099-12-31") }),
          (d) => {
            expect(assertDate(d, "testField")).toBe(d);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

describe("assertDate — error paths", () => {
  it("throws TimestampDeserializationError for null", () => {
    expect(() => assertDate(null, "updatedAt")).toThrow(
      TimestampDeserializationError
    );
    expect(() => assertDate(null, "updatedAt")).toThrow(/null/);
  });

  it("throws for undefined", () => {
    expect(() => assertDate(undefined, "capturedAt")).toThrow(
      TimestampDeserializationError
    );
    expect(() => assertDate(undefined, "capturedAt")).toThrow(/undefined/);
  });

  it("throws for a numeric Unix timestamp", () => {
    expect(() => assertDate(1_700_000_000_000, "createdAt")).toThrow(
      TimestampDeserializationError
    );
  });

  it("throws for an ISO string", () => {
    expect(() => assertDate("2024-01-15T12:00:00Z", "createdAt")).toThrow(
      TimestampDeserializationError
    );
  });

  it("throws for a Firestore Timestamp-shaped object (not instanceof Date)", () => {
    expect(() => assertDate(firestoreTimestampLike, "timestamp")).toThrow(
      TimestampDeserializationError
    );
  });

  it("throws for an Invalid Date", () => {
    expect(() => assertDate(new Date("not-a-date"), "capturedAt")).toThrow(
      TimestampDeserializationError
    );
    expect(() => assertDate(new Date(NaN), "capturedAt")).toThrow(
      TimestampDeserializationError
    );
  });

  it("includes the field name in the error message", () => {
    try {
      assertDate(null, "metadata.capturedAt");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TimestampDeserializationError);
      const e = err as TimestampDeserializationError;
      expect(e.fieldName).toBe("metadata.capturedAt");
      expect(e.message).toContain("metadata.capturedAt");
    }
  });

  it(
    "property: any non-Date value throws TimestampDeserializationError",
    () => {
      // Feature: evidence-trail, Property 17: Timestamp Type Invariant (violation case)
      const nonDateArb = fc.oneof(
        fc.constant(null),
        fc.constant(undefined),
        fc.integer(),
        fc.float(),
        fc.string(),
        fc.boolean(),
        // Plain object — looks like Firestore Timestamp
        fc.record({ seconds: fc.integer(), nanoseconds: fc.integer() })
      );
      fc.assert(
        fc.property(nonDateArb, (value) => {
          expect(() => assertDate(value, "field")).toThrow(
            TimestampDeserializationError
          );
        }),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// assertDateOrNull
// ---------------------------------------------------------------------------

describe("assertDateOrNull", () => {
  it("returns null for null", () => {
    expect(assertDateOrNull(null, "retentionExpiresAt")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(assertDateOrNull(undefined, "retentionExpiresAt")).toBeNull();
  });

  it("returns the Date for a valid Date value", () => {
    const d = new Date("2025-06-01T00:00:00Z");
    expect(assertDateOrNull(d, "revokedAt")).toBe(d);
  });

  it("throws for a non-null, non-Date value", () => {
    expect(() =>
      assertDateOrNull("2025-06-01T00:00:00Z", "retentionExpiresAt")
    ).toThrow(TimestampDeserializationError);
  });

  it("converts a Firestore Timestamp-shaped object via toDate()", () => {
    const result = assertDateOrNull(firestoreTimestampLike, "retentionExpiresAt");
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBe(1_700_000_000_000);
  });

  it(
    "property: null/undefined always returns null; valid Date passes through",
    () => {
      fc.assert(
        fc.property(
          fc.date({ min: new Date("2000-01-01"), max: new Date("2099-12-31") }),
          (d) => {
            expect(assertDateOrNull(d, "f")).toBe(d);
            expect(assertDateOrNull(null, "f")).toBeNull();
            expect(assertDateOrNull(undefined, "f")).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// parseISODate
// ---------------------------------------------------------------------------

describe("parseISODate", () => {
  it("accepts valid ISO 8601 UTC strings", () => {
    const iso = "2025-06-01T12:00:00Z";
    const result = parseISODate(iso, "triggeredAt");
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe("2025-06-01T12:00:00.000Z");
  });

  it("accepts valid ISO 8601 timezone offset strings", () => {
    const iso = "2025-06-01T12:00:00+05:30";
    const result = parseISODate(iso, "triggeredAt");
    expect(result).toBeInstanceOf(Date);
    // 12:00:00+05:30 is 06:30:00 UTC
    expect(result.toISOString()).toBe("2025-06-01T06:30:00.000Z");
  });

  it("accepts valid ISO 8601 millisecond strings", () => {
    const iso = "2025-06-01T12:00:00.123Z";
    const result = parseISODate(iso, "triggeredAt");
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe(iso);
  });

  it("accepts valid date-only strings", () => {
    const iso = "2025-06-01";
    const result = parseISODate(iso, "triggeredAt");
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe("2025-06-01T00:00:00.000Z");
  });

  it("rejects non-string inputs", () => {
    expect(() => parseISODate(null, "t")).toThrow(PayloadTimestampError);
    expect(() => parseISODate(undefined, "t")).toThrow(PayloadTimestampError);
    expect(() => parseISODate(1234567890, "t")).toThrow(PayloadTimestampError);
    expect(() => parseISODate(new Date(), "t")).toThrow(PayloadTimestampError);
  });

  it("rejects lenient strings that bare new Date() accepts", () => {
    // JS new Date() accepts all of these but we strictly reject them
    const lenientStrings = [
      "June 1 2025",
      "2025-6-1", // non-padded month/day
      "1717257600000", // numeric string
      "2025-06-01T12:00", // missing seconds
      "",
    ];

    for (const str of lenientStrings) {
      expect(() => parseISODate(str, "t")).toThrow(PayloadTimestampError);
    }
  });

  it("rejects calendar-impossible dates that pass the structure regex", () => {
    // passes YYYY-MM-DD but is invalid calendar date (Feb 30)
    expect(() => parseISODate("2025-02-30", "t")).toThrow(PayloadTimestampError);
  });

  it("property: any date generated by toISOString() parses correctly", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2000-01-01"), max: new Date("2099-12-31") }),
        (d) => {
          // Normalize to milliseconds precision
          const iso = d.toISOString();
          const parsed = parseISODate(iso, "triggeredAt");
          expect(parsed.getTime()).toBe(d.getTime());
        }
      ),
      { numRuns: 100 }
    );
  });
});
