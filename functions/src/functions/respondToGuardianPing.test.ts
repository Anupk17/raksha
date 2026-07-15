import { describe, it, expect, vi } from "vitest";
import { runRespondToGuardianPing } from "./respondToGuardianPing.js";
import fc from "fast-check";

vi.mock("firebase-functions", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

class MockDb {
  public store = new Map<string, any>();
  public updatedPings = new Map<string, any>();
  public updatedGuardians = new Map<string, any>();

  collection(name: string) {
    const self = this;
    return {
      doc(id: string) {
        const path = `${name}/${id}`;
        return {
          id,
          path,
          async get() {
            const data = self.store.get(path);
            return {
              exists: data !== undefined,
              data: () => data,
            };
          },
        };
      },
    };
  }

  async runTransaction(fn: (tx: any) => Promise<any>) {
    const self = this;
    const tx = {
      get: async (ref: any) => {
        const path = ref.path || `${ref.parent?.path || ""}/${ref.id}`;
        const data = self.store.get(path);
        return {
          exists: data !== undefined,
          id: ref.id,
          data: () => data,
        };
      },
      update: async (ref: any, data: any) => {
        const path = ref.path || `${ref.parent?.path || ""}/${ref.id}`;
        const current = self.store.get(path) || {};
        const merged = { ...current, ...data };
        self.store.set(path, merged);

        if (path.includes("guardian_pings")) {
          self.updatedPings.set(ref.id, merged);
        } else if (path.includes("guardians")) {
          self.updatedGuardians.set(ref.id, merged);
        }
      },
    };
    return fn(tx);
  }
}

describe("respondToGuardianPing Unit Tests", () => {
  it("rejects unauthenticated requests", async () => {
    const db = new MockDb();
    await expect(
      runRespondToGuardianPing({ pingId: "ping-1", response: "accepted" }, "", db as any)
    ).rejects.toThrow("respondToGuardianPing: unauthenticated");
  });

  it("rejects invalid payloads", async () => {
    const db = new MockDb();
    await expect(
      runRespondToGuardianPing({ pingId: "", response: "accepted" }, "g1", db as any)
    ).rejects.toThrow("respondToGuardianPing: missing or invalid payload");

    await expect(
      runRespondToGuardianPing({ pingId: "ping-1", response: "maybe" as any }, "g1", db as any)
    ).rejects.toThrow("respondToGuardianPing: invalid response value");
  });

  it("updates ping and guardian stats correctly inside transaction", async () => {
    const db = new MockDb();
    const sentAt = new Date(Date.now() - 30 * 1000); // 30s ago

    db.store.set("guardian_pings/ping-1", {
      pingId: "ping-1",
      guardianId: "g1",
      sentAt,
      respondedAt: null,
      response: "no_response",
    });

    db.store.set("guardians/g1", {
      guardianId: "g1",
      verificationStatus: "verified",
      onDuty: true,
      responseStats: {
        totalPings: 2,
        respondedCount: 1,
        avgResponseTimeSeconds: 10,
      },
    });

    const res = await runRespondToGuardianPing(
      { pingId: "ping-1", response: "accepted" },
      "g1",
      db as any
    );

    expect(res.success).toBe(true);

    const updatedPing = db.updatedPings.get("ping-1");
    expect(updatedPing.response).toBe("accepted");
    expect(updatedPing.respondedAt).toBeInstanceOf(Date);

    const updatedGuardian = db.updatedGuardians.get("g1");
    expect(updatedGuardian.responseStats.totalPings).toBe(3);
    expect(updatedGuardian.responseStats.respondedCount).toBe(2);
    // 30 seconds response time.
    // oldAvg = 10, count = 1.
    // newAvg = 10 + (30 - 10) / 2 = 20.
    expect(updatedGuardian.responseStats.avgResponseTimeSeconds).toBe(20);
  });

  it("is idempotent on duplicate responses", async () => {
    const db = new MockDb();
    const sentAt = new Date(Date.now() - 30 * 1000);

    db.store.set("guardian_pings/ping-1", {
      pingId: "ping-1",
      guardianId: "g1",
      sentAt,
      respondedAt: new Date(),
      response: "accepted",
    });

    const res = await runRespondToGuardianPing(
      { pingId: "ping-1", response: "accepted" },
      "g1",
      db as any
    );

    expect(res.success).toBe(true);
    expect(res.alreadyResponded).toBe(true);
    expect(db.updatedPings.size).toBe(0);
  });

  it("rejects response from mismatched guardian UIDs", async () => {
    const db = new MockDb();
    db.store.set("guardian_pings/ping-1", {
      pingId: "ping-1",
      guardianId: "g2", // Assigned to G2
      sentAt: new Date(),
      respondedAt: null,
    });

    await expect(
      runRespondToGuardianPing({ pingId: "ping-1", response: "accepted" }, "g1", db as any)
    ).rejects.toThrow("respondToGuardianPing: permission denied");
  });
});

describe("Incremental Mean Property-Based Tests", () => {
  it("verifies incremental mean formula matches naive mean", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.1, max: 1000.0, noNaN: true, noDefaultInfinity: true }), {
          minLength: 1,
          maxLength: 100,
        }),
        (responseTimes) => {
          // Naive average
          const sum = responseTimes.reduce((a, b) => a + b, 0);
          const naiveAvg = sum / responseTimes.length;

          // Incremental average
          let avg = 0;
          let count = 0;
          for (const t of responseTimes) {
            avg = avg + (t - avg) / (count + 1);
            count++;
          }

          // Floating point comparison
          expect(avg).toBeCloseTo(naiveAvg, 9);
        }
      ),
      { numRuns: 100 }
    );
  });
});
