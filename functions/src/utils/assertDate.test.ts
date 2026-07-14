/**
 * Tests for assertDate and assertDateOrNull.
 *
 * Core guarantee (Req 10.3, 10.4, Design §Timestamp Handling Rules):
 *   - Valid Date passes through unchanged
 *   - null / undefined / string / number / Firestore-Timestamp-shaped object
 *     all throw TimestampDeserializationError
 *   - Invalid Date (NaN) throws
 *   - assertDateOrNull accepts null/undefined, delegates the rest to assertDate
 *
 * Feature: evidence-trail, Task 1.2: assertDate — fail-loud timestamp guard
 * Property 17: Timestamp Type Invariant
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  assertDate,
  assertDateOrNull,
  TimestampDeserializationError,
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
