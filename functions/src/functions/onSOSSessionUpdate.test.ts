import { describe, it, expect, vi } from "vitest";
import { runOnSOSSessionUpdate, calculateDistanceMeters } from "./onSOSSessionUpdate.js";
import type { SOSSession } from "../types/sosSession.js";
import type { Guardian } from "../types/guardian.js";

vi.mock("firebase-functions", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

class MockDb {
  public store = new Map<string, any>();
  public createdPings: any[] = [];
  public updatedSessions = new Map<string, any>();

  collection(name: string) {
    const self = this;
    return {
      doc(id: string) {
        const path = `${name}/${id}`;
        return {
          id,
          async create(data: any) {
            if (self.store.has(path)) {
              const err = new Error("Document already exists");
              (err as any).code = "already-exists";
              throw err;
            }
            self.store.set(path, data);
            self.createdPings.push(data);
          },
          async get() {
            const data = self.store.get(path);
            return {
              exists: data !== undefined,
              data: () => data,
            };
          },
          async update(data: any) {
            const current = self.store.get(path) || {};
            const merged = { ...current, ...data };
            self.store.set(path, merged);
            self.updatedSessions.set(id, merged);
          },
        };
      },
      where(field: string, op: string, val: any) {
        const docs: any[] = [];
        self.store.forEach((data, key) => {
          if (key.startsWith(`${name}/`)) {
            if (op === "==" && data[field] === val) {
              docs.push(data);
            }
          }
        });

        const chain = {
          get: async () => ({
            docs: docs.map((d) => ({
              id: d.guardianId || d.id || "mock-id",
              data: () => d,
            })),
          }),
          where(field2: string, op2: string, val2: any) {
            const filtered = docs.filter((d) => {
              if (op2 === "==") {
                return d[field2] === val2;
              }
              return false;
            });
            return {
              get: async () => ({
                docs: filtered.map((d) => ({
                  id: d.guardianId || d.id || "mock-id",
                  data: () => d,
                })),
              }),
            };
          },
        };
        return chain;
      },
    };
  }

  async runTransaction(fn: (tx: any) => Promise<any>) {
    const tx = {
      get: async (ref: any) => {
        const path = `sosSessions/${ref.id}`;
        const data = this.store.get(path);
        return {
          exists: data !== undefined,
          id: ref.id,
          data: () => data,
        };
      },
      update: async (ref: any, data: any) => {
        const path = `sosSessions/${ref.id}`;
        const current = this.store.get(path) || {};
        const merged = { ...current, ...data };
        this.store.set(path, merged);
        this.updatedSessions.set(ref.id, merged);
      },
    };
    return fn(tx);
  }
}

function makeChangeMock(before: SOSSession | null, after: SOSSession | null): any {
  return {
    before: {
      exists: before !== null,
      data: () => before,
    },
    after: {
      exists: after !== null,
      data: () => after,
    },
  };
}

describe("onSOSSessionUpdate Unit Tests", () => {
  it("calculates Haversine distance correctly", () => {
    // Distance between London (51.5074, -0.1278) and Paris (48.8566, 2.3522) is approx 344 km
    const dist = calculateDistanceMeters(51.5074, -0.1278, 48.8566, 2.3522);
    expect(dist / 1000).toBeCloseTo(344, 0);
  });

  it("ignores non-countdown to active transitions", async () => {
    const db = new MockDb();
    const before = { status: "active" } as any;
    const after = { status: "active" } as any;
    const change = makeChangeMock(before, after);

    await runOnSOSSessionUpdate(change, db as any);
    expect(db.createdPings.length).toBe(0);
    expect(db.updatedSessions.size).toBe(0);
  });

  it("excludes the victim/owner from proximity matching", async () => {
    const db = new MockDb();
    const victimId = "victim-1";

    // Set up a verified, onDuty guardian that is also the victim
    const guardianPath = `guardians/${victimId}`;
    db.store.set(guardianPath, {
      guardianId: victimId,
      verificationStatus: "verified",
      onDuty: true,
      currentLocation: { latitude: 10.0001, longitude: 10.0001 },
    });

    const before = { sessionId: "session-1", userId: victimId, status: "countdown" } as any;
    const after = {
      sessionId: "session-1",
      userId: victimId,
      status: "active",
      location: {
        latHash: "hash",
        lngHash: "hash",
        current: { latitude: 10, longitude: 10 },
      },
      triggeredAt: new Date(),
      createdAt: new Date(),
    } as any;
    db.store.set(`sosSessions/session-1`, after);

    const change = makeChangeMock(before, after);
    await runOnSOSSessionUpdate(change, db as any);

    expect(db.createdPings.length).toBe(0); // Excluded!
  });

  it("matches nearby guardians within expanding steps (concentric search rings)", async () => {
    const db = new MockDb();
    const victimId = "victim-1";

    // G1 is 500m away (matches 1km step)
    db.store.set(`guardians/g1`, {
      guardianId: "g1",
      verificationStatus: "verified",
      onDuty: true,
      currentLocation: { latitude: 10.004, longitude: 10.0 }, // ~444m
    });

    // G2 is 1.5km away (matches 2km step)
    db.store.set(`guardians/g2`, {
      guardianId: "g2",
      verificationStatus: "verified",
      onDuty: true,
      currentLocation: { latitude: 10.013, longitude: 10.0 }, // ~1.44km
    });

    // G3 is 4km away (matches 5km step)
    db.store.set(`guardians/g3`, {
      guardianId: "g3",
      verificationStatus: "verified",
      onDuty: true,
      currentLocation: { latitude: 10.035, longitude: 10.0 }, // ~3.89km
    });

    // G4 is 8km away (matches 10km step)
    db.store.set(`guardians/g4`, {
      guardianId: "g4",
      verificationStatus: "verified",
      onDuty: true,
      currentLocation: { latitude: 10.07, longitude: 10.0 }, // ~7.78km
    });

    const before = { sessionId: "session-1", userId: victimId, status: "countdown" } as any;
    const after = {
      sessionId: "session-1",
      userId: victimId,
      status: "active",
      location: {
        latHash: "hash",
        lngHash: "hash",
        current: { latitude: 10, longitude: 10 },
      },
      triggeredAt: new Date(),
      createdAt: new Date(),
    } as any;
    db.store.set(`sosSessions/session-1`, after);

    const change = makeChangeMock(before, after);
    await runOnSOSSessionUpdate(change, db as any);

    // Expansion stops at 5km when we have 3 matched guardians (g1, g2, g3).
    // G4 (8km) should NOT be pinged because 5km ring met the minimum criteria of 3.
    expect(db.createdPings.length).toBe(3);
    const pingedIds = db.createdPings.map((p) => p.guardianId);
    expect(pingedIds).toContain("g1");
    expect(pingedIds).toContain("g2");
    expect(pingedIds).toContain("g3");
    expect(pingedIds).not.toContain("g4");

    const updated = db.updatedSessions.get("session-1");
    expect(updated.guardiansPinged).toEqual(["g1", "g2", "g3"]);
  });

  it("falls back to priority contacts if no guardians found within 10km", async () => {
    const db = new MockDb();
    const victimId = "victim-1";

    // Set up a contact
    db.store.set(`trusted_contacts/contact-1`, {
      id: "contact-1",
      ownerUserId: victimId,
      notifyOnSOS: true,
    });

    // Set up contact that shouldn't be notified
    db.store.set(`trusted_contacts/contact-2`, {
      id: "contact-2",
      ownerUserId: victimId,
      notifyOnSOS: false,
    });

    const before = { sessionId: "session-1", userId: victimId, status: "countdown" } as any;
    const after = {
      sessionId: "session-1",
      userId: victimId,
      status: "active",
      location: {
        latHash: "hash",
        lngHash: "hash",
        current: { latitude: 10, longitude: 10 },
      },
      triggeredAt: new Date(),
      createdAt: new Date(),
    } as any;
    db.store.set(`sosSessions/session-1`, after);

    const change = makeChangeMock(before, after);
    await runOnSOSSessionUpdate(change, db as any);

    expect(db.createdPings.length).toBe(0);
    const updated = db.updatedSessions.get("session-1");
    expect(updated.contactsNotified).toEqual(["contact-1"]);
  });

  it("writes contactsNotified even when a guardian is found (guardian-found path)", async () => {
    // This test explicitly covers the previously-undetected safety gap:
    // contacts were always notified via FCM but contactsNotified was NOT written
    // to the session document when a guardian was dispatched. The Firestore record
    // must now reflect reality in both paths.
    const db = new MockDb();
    const victimId = "victim-guardian-path";

    // One nearby guardian (within 1km)
    db.store.set(`guardians/g1`, {
      guardianId: "g1",
      verificationStatus: "verified",
      onDuty: true,
      currentLocation: { latitude: 10.004, longitude: 10.0 }, // ~444m
    });

    // One trusted contact with SOS notifications enabled
    db.store.set(`trusted_contacts/contact-1`, {
      id: "contact-1",
      ownerUserId: victimId,
      notifyOnSOS: true,
      contactRakshaUid: null, // FCM send is a no-op without a UID — we're testing the field write
    });

    const before = { sessionId: "session-gp", userId: victimId, status: "countdown" } as any;
    const after = {
      sessionId: "session-gp",
      userId: victimId,
      status: "active",
      location: {
        latHash: "hash",
        lngHash: "hash",
        current: { latitude: 10, longitude: 10 },
      },
      triggeredAt: new Date(),
      createdAt: new Date(),
    } as any;
    db.store.set(`sosSessions/session-gp`, after);

    const change = makeChangeMock(before, after);
    await runOnSOSSessionUpdate(change, db as any);

    const updated = db.updatedSessions.get("session-gp");

    // Guardian was dispatched — guardiansPinged must be written
    expect(updated.guardiansPinged).toEqual(["g1"]);

    // Contacts must ALSO be written even though a guardian was found —
    // this is the specific field that was previously missing in this path.
    expect(updated.contactsNotified).toEqual(["contact-1"]);
  });

  it("absorbs ALREADY_EXISTS errors to support resumable triggers", async () => {
    const db = new MockDb();
    const victimId = "victim-1";

    db.store.set(`guardians/g1`, {
      guardianId: "g1",
      verificationStatus: "verified",
      onDuty: true,
      currentLocation: { latitude: 10.001, longitude: 10.001 },
    });

    // Manually create the ping beforehand to trigger ALREADY_EXISTS
    db.store.set(`guardian_pings/session-1_g1`, {
      pingId: "session-1_g1",
      guardianId: "g1",
    });

    const before = { sessionId: "session-1", userId: victimId, status: "countdown" } as any;
    const after = {
      sessionId: "session-1",
      userId: victimId,
      status: "active",
      location: {
        latHash: "hash",
        lngHash: "hash",
        current: { latitude: 10, longitude: 10 },
      },
      triggeredAt: new Date(),
      createdAt: new Date(),
    } as any;
    db.store.set(`sosSessions/session-1`, after);

    const change = makeChangeMock(before, after);
    await runOnSOSSessionUpdate(change, db as any);

    // The handler should absorb the error and still complete the setup and record it
    const updated = db.updatedSessions.get("session-1");
    expect(updated.guardiansPinged).toContain("g1");
  });
});
