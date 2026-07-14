/**
 * Tests for appendCustodyEntry.
 *
 * Because appendCustodyEntry requires a live Firestore transaction, these
 * unit tests use a minimal in-memory mock of the Firestore Transaction API
 * rather than the Firebase Emulator (which belongs in integration tests, Phase 13).
 *
 * What's tested:
 *   - Read-spread-write: the written array equals current + new entry
 *   - updatedAt is updated to a fresh Date on every call
 *   - timestamp validation: non-Date and Invalid Date throw TypeError
 *   - Missing document throws Error
 *   - Property 9: after N appends, length increases by exactly N
 *   - Property 10: each appended entry has the correct fields and a native Date timestamp
 *
 * Feature: evidence-trail, Task 1.4: appendCustodyEntry
 * Requirements: 5.3, 5.4, 5.7
 * Properties 9 and 10
 */
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { appendCustodyEntry } from "./appendCustodyEntry.js";
import type { ChainOfCustodyEntry } from "../types/evidence.js";

// ---------------------------------------------------------------------------
// In-memory Firestore Transaction mock
// ---------------------------------------------------------------------------

interface MockDocData {
  chainOfCustody: ChainOfCustodyEntry[];
  updatedAt: Date;
  [key: string]: unknown;
}

function makeMockTransaction(
  initialData: MockDocData | null
): {
  tx: {
    get: (ref: { path: string }) => Promise<{ exists: boolean; data: () => MockDocData | undefined }>;
    update: (...args: unknown[]) => void;
  };
  capturedUpdates: { chainOfCustody?: ChainOfCustodyEntry[]; updatedAt?: Date }[];
} {
  const capturedUpdates: { chainOfCustody?: ChainOfCustodyEntry[]; updatedAt?: Date }[] = [];

  const tx = {
    get: vi.fn().mockResolvedValue({
      exists: initialData !== null,
      data: () => (initialData !== null ? { ...initialData } : undefined),
    }),
    update: vi.fn((_, updates) => {
      capturedUpdates.push(updates);
    }),
  };

  return { tx, capturedUpdates };
}

function makeMockRef(path = "evidence/ev-001"): { path: string } {
  return { path };
}

function makeEntry(overrides: Partial<ChainOfCustodyEntry> = {}): ChainOfCustodyEntry {
  return {
    action: "uploaded",
    performedBy: "cloud_function",
    timestamp: new Date(),
    evidenceId: "ev-001",
    metadata: null,
    integritySnapshot: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("appendCustodyEntry — read-spread-write pattern", () => {
  it("appends the entry to an initially empty chainOfCustody", async () => {
    const { tx, capturedUpdates } = makeMockTransaction({
      chainOfCustody: [],
      updatedAt: new Date("2024-01-01"),
    });
    const entry = makeEntry();
    await appendCustodyEntry(tx as never, makeMockRef() as never, entry);

    expect(capturedUpdates).toHaveLength(1);
    expect(capturedUpdates[0]!.chainOfCustody).toHaveLength(1);
    expect(capturedUpdates[0]!.chainOfCustody![0]).toBe(entry);
  });

  it("appends to an existing non-empty array", async () => {
    const existing = [makeEntry({ action: "viewed" }), makeEntry({ action: "shared" })];
    const { tx, capturedUpdates } = makeMockTransaction({
      chainOfCustody: existing,
      updatedAt: new Date(),
    });
    const newEntry = makeEntry({ action: "exported" });
    await appendCustodyEntry(tx as never, makeMockRef() as never, newEntry);

    const written = capturedUpdates[0]!.chainOfCustody!;
    expect(written).toHaveLength(3);
    expect(written[0]).toBe(existing[0]);
    expect(written[1]).toBe(existing[1]);
    expect(written[2]).toBe(newEntry);
  });

  it("does not mutate the existing array in Firestore (creates a new array)", async () => {
    const existing = [makeEntry()];
    const originalRef = existing;
    const { tx, capturedUpdates } = makeMockTransaction({
      chainOfCustody: existing,
      updatedAt: new Date(),
    });
    await appendCustodyEntry(tx as never, makeMockRef() as never, makeEntry());

    // The written array must be a new array, not the original reference
    expect(capturedUpdates[0]!.chainOfCustody).not.toBe(originalRef);
  });

  it("sets updatedAt to a new Date on each call", async () => {
    const before = new Date("2020-01-01");
    const { tx, capturedUpdates } = makeMockTransaction({
      chainOfCustody: [],
      updatedAt: before,
    });
    await appendCustodyEntry(tx as never, makeMockRef() as never, makeEntry());

    const written = capturedUpdates[0]!.updatedAt!;
    expect(written).toBeInstanceOf(Date);
    expect(written.getTime()).toBeGreaterThan(before.getTime());
  });

  it("handles a document with no existing chainOfCustody field (treats as empty)", async () => {
    const { tx, capturedUpdates } = makeMockTransaction({
      chainOfCustody: undefined as unknown as ChainOfCustodyEntry[],
      updatedAt: new Date(),
    });
    const entry = makeEntry();
    await appendCustodyEntry(tx as never, makeMockRef() as never, entry);

    expect(capturedUpdates[0]!.chainOfCustody).toEqual([entry]);
  });
});

describe("appendCustodyEntry — timestamp validation", () => {
  it("throws TypeError when entry.timestamp is null", async () => {
    const { tx } = makeMockTransaction({ chainOfCustody: [], updatedAt: new Date() });
    const bad = makeEntry({ timestamp: null as unknown as Date });
    await expect(
      appendCustodyEntry(tx as never, makeMockRef() as never, bad)
    ).rejects.toThrow(TypeError);
    await expect(
      appendCustodyEntry(tx as never, makeMockRef() as never, bad)
    ).rejects.toThrow(/native Date/);
  });

  it("throws TypeError when entry.timestamp is a number", async () => {
    const { tx } = makeMockTransaction({ chainOfCustody: [], updatedAt: new Date() });
    const bad = makeEntry({ timestamp: Date.now() as unknown as Date });
    await expect(
      appendCustodyEntry(tx as never, makeMockRef() as never, bad)
    ).rejects.toThrow(TypeError);
  });

  it("throws TypeError when entry.timestamp is a Firestore Timestamp-shaped object", async () => {
    const { tx } = makeMockTransaction({ chainOfCustody: [], updatedAt: new Date() });
    const firestoreTs = { seconds: 1_700_000_000, nanoseconds: 0, toDate: () => new Date() };
    const bad = makeEntry({ timestamp: firestoreTs as unknown as Date });
    await expect(
      appendCustodyEntry(tx as never, makeMockRef() as never, bad)
    ).rejects.toThrow(TypeError);
  });

  it("throws TypeError when entry.timestamp is an Invalid Date", async () => {
    const { tx } = makeMockTransaction({ chainOfCustody: [], updatedAt: new Date() });
    const bad = makeEntry({ timestamp: new Date("invalid") });
    await expect(
      appendCustodyEntry(tx as never, makeMockRef() as never, bad)
    ).rejects.toThrow(TypeError);
    await expect(
      appendCustodyEntry(tx as never, makeMockRef() as never, bad)
    ).rejects.toThrow(/Invalid Date/);
  });
});

describe("appendCustodyEntry — missing document", () => {
  it("throws when the document does not exist", async () => {
    const { tx } = makeMockTransaction(null); // null = not found
    await expect(
      appendCustodyEntry(tx as never, makeMockRef() as never, makeEntry())
    ).rejects.toThrow(/does not exist/);
  });
});

describe("appendCustodyEntry — Property 9: Chain-of-Custody Monotonicity", () => {
  it(
    "P9: after N sequential appends, chainOfCustody.length increases by exactly N",
    async () => {
      // Feature: evidence-trail, Property 9: Chain-of-Custody Monotonicity
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 10 }), // initial entries
          fc.integer({ min: 1, max: 10 }), // entries to append
          async (initialCount, appendCount) => {
            const initial: ChainOfCustodyEntry[] = Array.from(
              { length: initialCount },
              (_, i) => makeEntry({ evidenceId: `ev-${i}`, timestamp: new Date(1_700_000_000_000 + i) })
            );

            // Simulate sequential appends by re-creating the mock each time
            // with the accumulated array (mirroring real Firestore transaction behavior)
            let currentArray = [...initial];

            for (let i = 0; i < appendCount; i++) {
              const { tx, capturedUpdates } = makeMockTransaction({
                chainOfCustody: currentArray,
                updatedAt: new Date(),
              });
              await appendCustodyEntry(
                tx as never,
                makeMockRef() as never,
                makeEntry({ timestamp: new Date(Date.now() + i) })
              );
              currentArray = capturedUpdates[0]!.chainOfCustody!;
            }

            expect(currentArray.length).toBe(initialCount + appendCount);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

describe("appendCustodyEntry — Property 10: Custody Entry Completeness", () => {
  it(
    "P10: appended entry is retrievable with correct action, performedBy, timestamp (instanceof Date), and evidenceId",
    async () => {
      // Feature: evidence-trail, Property 10: Custody Entry Completeness
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            "uploaded", "viewed", "shared", "exported",
            "legal_hold_set", "legal_hold_released", "status_changed",
            "granted", "revoked"
          ) as fc.Arbitrary<ChainOfCustodyEntry["action"]>,
          fc.oneof(
            fc.constant("cloud_function"),
            fc.constant("system"),
            fc.string({ minLength: 1, maxLength: 64 })
          ),
          fc.string({ minLength: 1, maxLength: 64 }),
          async (action, performedBy, evidenceId) => {
            const { tx, capturedUpdates } = makeMockTransaction({
              chainOfCustody: [],
              updatedAt: new Date(),
            });
            const entry = makeEntry({ action, performedBy, evidenceId, timestamp: new Date() });
            await appendCustodyEntry(tx as never, makeMockRef() as never, entry);

            const written = capturedUpdates[0]!.chainOfCustody![0]!;
            expect(written.action).toBe(action);
            expect(written.performedBy).toBe(performedBy);
            expect(written.evidenceId).toBe(evidenceId);
            // CRITICAL: timestamp must be native Date
            expect(written.timestamp).toBeInstanceOf(Date);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});
