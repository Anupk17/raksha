/**
 * Tests for getRetentionPeriodDays and computeRetentionExpiresAt.
 *
 * Requirements: 8.1, 8.7
 * Properties tested:
 *   P13: retentionExpiresAt = createdAt + R × 86_400_000ms exactly
 *   P15 (partial): boundary values 1 and 3650 are accepted; 0 and 3651 throw
 *
 * Feature: evidence-trail, Task 1.7: getRetentionPeriodDays
 */
import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import {
  getRetentionPeriodDays,
  computeRetentionExpiresAt,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from "./retentionConfig.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withEnv(value: string | undefined, fn: () => void): void {
  const original = process.env["EVIDENCE_RETENTION_DAYS"];
  if (value === undefined) {
    delete process.env["EVIDENCE_RETENTION_DAYS"];
  } else {
    process.env["EVIDENCE_RETENTION_DAYS"] = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env["EVIDENCE_RETENTION_DAYS"];
    } else {
      process.env["EVIDENCE_RETENTION_DAYS"] = original;
    }
  }
}

afterEach(() => {
  delete process.env["EVIDENCE_RETENTION_DAYS"];
});

// ---------------------------------------------------------------------------
// getRetentionPeriodDays
// ---------------------------------------------------------------------------

describe("getRetentionPeriodDays — defaults", () => {
  it("returns 90 when EVIDENCE_RETENTION_DAYS is not set", () => {
    withEnv(undefined, () => {
      expect(getRetentionPeriodDays()).toBe(90);
    });
  });

  it("returns 90 when EVIDENCE_RETENTION_DAYS is empty string", () => {
    withEnv("", () => {
      expect(getRetentionPeriodDays()).toBe(90);
    });
  });
});

describe("getRetentionPeriodDays — valid values", () => {
  it("accepts the minimum boundary value (1)", () => {
    withEnv("1", () => {
      expect(getRetentionPeriodDays()).toBe(1);
    });
  });

  it("accepts the maximum boundary value (3650)", () => {
    withEnv("3650", () => {
      expect(getRetentionPeriodDays()).toBe(3650);
    });
  });

  it("accepts a mid-range value (365)", () => {
    withEnv("365", () => {
      expect(getRetentionPeriodDays()).toBe(365);
    });
  });

  it(
    "property P13-setup: accepts any whole number in [1, 3650]",
    () => {
      // Feature: evidence-trail, Property 13: Retention Expiry Arithmetic (boundary)
      fc.assert(
        fc.property(
          fc.integer({ min: MIN_RETENTION_DAYS, max: MAX_RETENTION_DAYS }),
          (days) => {
            withEnv(String(days), () => {
              expect(getRetentionPeriodDays()).toBe(days);
            });
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

describe("getRetentionPeriodDays — invalid values (Req 8.7)", () => {
  it("throws RangeError for 0", () => {
    withEnv("0", () => {
      expect(() => getRetentionPeriodDays()).toThrow(RangeError);
    });
  });

  it("throws RangeError for 3651", () => {
    withEnv("3651", () => {
      expect(() => getRetentionPeriodDays()).toThrow(RangeError);
    });
  });

  it("throws RangeError for negative values", () => {
    withEnv("-1", () => {
      expect(() => getRetentionPeriodDays()).toThrow(RangeError);
    });
  });

  it("throws RangeError for a float", () => {
    withEnv("30.5", () => {
      expect(() => getRetentionPeriodDays()).toThrow(RangeError);
      expect(() => getRetentionPeriodDays()).toThrow(/whole number/);
    });
  });

  it("throws RangeError for a non-numeric string", () => {
    withEnv("thirty", () => {
      expect(() => getRetentionPeriodDays()).toThrow(RangeError);
    });
  });

  it(
    "property: any integer outside [1, 3650] throws RangeError",
    () => {
      const outOfRange = fc.oneof(
        fc.integer({ min: -10_000, max: 0 }),
        fc.integer({ min: 3651, max: 10_000 })
      );
      fc.assert(
        fc.property(outOfRange, (days) => {
          withEnv(String(days), () => {
            expect(() => getRetentionPeriodDays()).toThrow(RangeError);
          });
        }),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// computeRetentionExpiresAt
// ---------------------------------------------------------------------------

describe("computeRetentionExpiresAt — Property P13: Retention Expiry Arithmetic", () => {
  it("adds exactly retentionDays × 86_400_000 ms to the base date", () => {
    const base = new Date("2024-01-01T00:00:00.000Z");
    const result = computeRetentionExpiresAt(base, 90);
    expect(result.getTime()).toBe(base.getTime() + 90 * 86_400_000);
  });

  it("works correctly for the minimum retention period (1 day)", () => {
    const base = new Date("2024-06-15T12:00:00.000Z");
    const result = computeRetentionExpiresAt(base, 1);
    expect(result.getTime()).toBe(base.getTime() + 86_400_000);
  });

  it("works correctly for the maximum retention period (3650 days)", () => {
    const base = new Date("2024-01-01T00:00:00.000Z");
    const result = computeRetentionExpiresAt(base, 3650);
    expect(result.getTime()).toBe(base.getTime() + 3650 * 86_400_000);
  });

  it(
    "P13: for any valid R and base date, retentionExpiresAt = base + R × 86_400_000ms exactly",
    () => {
      // Feature: evidence-trail, Property 13: Retention Expiry Arithmetic
      fc.assert(
        fc.property(
          fc.date({ min: new Date("2020-01-01"), max: new Date("2099-12-31") }),
          fc.integer({ min: MIN_RETENTION_DAYS, max: MAX_RETENTION_DAYS }),
          (base, days) => {
            const result = computeRetentionExpiresAt(base, days);
            // Must be exactly base + days * 86_400_000 — no rounding
            expect(result.getTime()).toBe(base.getTime() + days * 86_400_000);
            // Result must be a valid Date
            expect(result).toBeInstanceOf(Date);
            expect(isNaN(result.getTime())).toBe(false);
            // Result must be strictly after base
            expect(result.getTime()).toBeGreaterThan(base.getTime());
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});
