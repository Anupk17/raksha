/**
 * Tests for offlineQueue (Task 7).
 *
 * Uses fake-indexeddb to provide a real IDB implementation in Node,
 * giving us actual persistence semantics without a browser.
 *
 * Requirements: tasks.md Task 7.6
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto"; // patches globalThis.indexedDB
import { IDBFactory } from "fake-indexeddb";
import {
  OfflineQueue,
  openDatabase,
  type CreateSOSSessionPayload,
  type CreateSOSSessionResponse,
  type QueueEntry,
} from "./offlineQueue.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFreshIDB(): IDBFactory {
  // Each call returns a brand-new IDBFactory — no shared state between tests
  return new IDBFactory();
}

function makePayload(overrides: Partial<CreateSOSSessionPayload> = {}): CreateSOSSessionPayload {
  return {
    triggerType: "earbud",
    triggeredAt: new Date().toISOString(),
    syncedAt: new Date().toISOString(),
    location: null,
    deviceInfo: "test-device",
    ...overrides,
  };
}

const SUCCESS_RESPONSE: CreateSOSSessionResponse = {
  sessionId: "sess-001",
  status: "countdown",
  alreadyExists: false,
};

function makeQueue(opts: {
  idb?: IDBFactory;
  createSOSSession?: (p: CreateSOSSessionPayload) => Promise<CreateSOSSessionResponse>;
  onDropped?: (entry: QueueEntry, reason: string) => void;
  scheduleFlush?: (delayMs: number) => void;
} = {}) {
  const idb = opts.idb ?? makeFreshIDB();
  const createSOSSession = opts.createSOSSession ?? vi.fn().mockResolvedValue(SUCCESS_RESPONSE);
  const queue = new OfflineQueue({
    createSOSSession,
    onDropped: opts.onDropped,
    idb,
    scheduleFlush: opts.scheduleFlush,
  });
  return { queue, idb, createSOSSession };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OfflineQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 7.6.1 — enqueue persists entry to IndexedDB
  // -------------------------------------------------------------------------
  it("enqueue persists entry to IndexedDB", async () => {
    const { queue } = makeQueue();
    await queue.open();

    const payload = makePayload();
    await queue.enqueue(payload);

    const entries = await queue._getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].payload.triggerType).toBe("earbud");
    expect(entries[0].retryCount).toBe(0);
    expect(entries[0].queuedAt).toBeDefined();
    // queuedAt must be a valid ISO 8601 string
    expect(() => new Date(entries[0].queuedAt)).not.toThrow();
    expect(isNaN(new Date(entries[0].queuedAt).getTime())).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 7.6.2 — capacity limit: drops oldest, preserves newest (P28)
  // -------------------------------------------------------------------------
  it("enqueue drops oldest when queue reaches 10 entries (P28 capacity)", async () => {
    const { queue } = makeQueue();
    await queue.open();

    // Fill to capacity
    for (let i = 0; i < 10; i++) {
      await queue.enqueue(makePayload({ triggeredAt: new Date(1000 + i).toISOString() }));
    }
    expect(await queue._length()).toBe(10);

    // Capture the oldest entry's triggeredAt before adding the 11th
    const beforeEntries = await queue._getAll();
    const oldestTriggeredAt = beforeEntries[0].payload.triggeredAt;

    // Enqueue one more — should drop the oldest
    const newestPayload = makePayload({ triggeredAt: new Date(2000).toISOString() });
    await queue.enqueue(newestPayload);

    expect(await queue._length()).toBe(10);

    const afterEntries = await queue._getAll();
    // The oldest triggeredAt must no longer be present
    expect(afterEntries.some(e => e.payload.triggeredAt === oldestTriggeredAt)).toBe(false);
    // The newest entry must be present
    expect(afterEntries.some(e => e.payload.triggeredAt === newestPayload.triggeredAt)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 7.6.3 — flush calls createSOSSession in FIFO order
  // -------------------------------------------------------------------------
  it("flush calls createSOSSession for each queued entry in FIFO order", async () => {
    const calls: string[] = [];
    const { queue } = makeQueue({
      createSOSSession: async (p) => {
        calls.push(p.triggeredAt);
        return SUCCESS_RESPONSE;
      },
    });
    await queue.open();

    const p1 = makePayload({ triggeredAt: "2025-01-01T00:00:01Z" });
    const p2 = makePayload({ triggeredAt: "2025-01-01T00:00:02Z" });
    const p3 = makePayload({ triggeredAt: "2025-01-01T00:00:03Z" });
    await queue.enqueue(p1);
    await queue.enqueue(p2);
    await queue.enqueue(p3);

    await queue.flush();

    // Must be called in the exact FIFO insertion order
    expect(calls).toEqual([p1.triggeredAt, p2.triggeredAt, p3.triggeredAt]);
  });

  // -------------------------------------------------------------------------
  // 7.6.4 — flush dequeues on success, retains on failure
  // -------------------------------------------------------------------------
  it("flush dequeues entry on success, retains on network failure", async () => {
    let scheduleCalled = false;
    const { queue } = makeQueue({
      createSOSSession: async () => {
        throw Object.assign(new Error("network error"), { code: "unavailable" });
      },
      scheduleFlush: () => {
        scheduleCalled = true;
      },
    });
    await queue.open();

    await queue.enqueue(makePayload({ triggeredAt: "2025-01-01T00:00:01Z" }));
    await queue.enqueue(makePayload({ triggeredAt: "2025-01-01T00:00:02Z" }));

    // First flush: first entry fails → lock released, backoff timer scheduled → flush halts
    await queue.flush();

    // Second entry should NOT have been processed yet (flush halted after first failure)
    const entries = await queue._getAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].retryCount).toBe(1); // incremented
    expect(scheduleCalled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 7.6.5 — evicts stuck entry after MAX_RETRIES, calls onDropped
  // -------------------------------------------------------------------------
  it("flush evicts entry after 3 retries and calls onDropped", async () => {
    const dropped: QueueEntry[] = [];
    const scheduledDelays: number[] = [];

    const { queue } = makeQueue({
      createSOSSession: async () => {
        throw Object.assign(new Error("always fails"), { code: "unavailable" });
      },
      onDropped: (entry) => dropped.push(entry),
      scheduleFlush: (delayMs) => {
        scheduledDelays.push(delayMs);
      },
    });
    await queue.open();
    await queue.enqueue(makePayload());

    // Flush #1 → retryCount becomes 1, backoff timer scheduled (30s)
    await queue.flush();
    expect(scheduledDelays).toEqual([30000]);

    // Flush #2 → retryCount becomes 2, backoff timer scheduled (60s)
    await queue.flush();
    expect(scheduledDelays).toEqual([30000, 60000]);

    // Flush #3 → retryCount becomes 3 → evicted
    await queue.flush();

    expect(await queue._length()).toBe(0);
    expect(dropped).toHaveLength(1);
    expect(scheduledDelays).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 7.6.6 — durability: entry survives simulated app restart (P28)
  // -------------------------------------------------------------------------
  it("entry survives a simulated app restart (P28 durability)", async () => {
    // Use a shared IDB factory instance so the same DB persists across queue instances
    const sharedIdb = makeFreshIDB();

    const queue1 = new OfflineQueue({
      createSOSSession: vi.fn().mockRejectedValue(new Error("offline")),
      idb: sharedIdb,
    });
    await queue1.open();
    const payload = makePayload({ triggeredAt: "2025-01-01T10:00:00Z" });
    await queue1.enqueue(payload);
    // Simulate app "crash" — queue1 is garbage-collected, IDB connection closed implicitly

    // New queue instance re-opens the SAME IDB
    const queue2 = new OfflineQueue({
      createSOSSession: vi.fn().mockResolvedValue(SUCCESS_RESPONSE),
      idb: sharedIdb,
    });
    await queue2.open();

    const entries = await queue2._getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].payload.triggeredAt).toBe("2025-01-01T10:00:00Z");
  });

  // -------------------------------------------------------------------------
  // 7.6.7 — enqueueAndFlush does NOT persist to IDB when network call succeeds
  // -------------------------------------------------------------------------
  it("enqueueAndFlush does not persist to IndexedDB when network call succeeds", async () => {
    const createFn = vi.fn().mockResolvedValue(SUCCESS_RESPONSE);
    const { queue } = makeQueue({ createSOSSession: createFn });
    await queue.open();

    const result = await queue.enqueueAndFlush(makePayload());

    expect(result).toEqual(SUCCESS_RESPONSE);
    // No IDB entry created
    expect(await queue._length()).toBe(0);
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 7.6.8 — enqueueAndFlush persists on network error
  // -------------------------------------------------------------------------
  it("enqueueAndFlush persists to IndexedDB on network error and returns undefined", async () => {
    const { queue } = makeQueue({
      createSOSSession: async () => {
        throw Object.assign(new Error("failed to fetch"), { code: "unavailable" });
      },
    });
    await queue.open();

    const result = await queue.enqueueAndFlush(makePayload());

    expect(result).toBeUndefined();
    expect(await queue._length()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 7.6.9 — init registers online listener exactly once
  // -------------------------------------------------------------------------
  it("init registers window.online listener exactly once across multiple init calls", async () => {
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const { queue } = makeQueue();

    await queue.init();
    await queue.init(); // second call must be a no-op for listener registration
    await queue.init(); // third call too

    const onlineCalls = addEventListenerSpy.mock.calls.filter(([event]) => event === "online");
    expect(onlineCalls).toHaveLength(1);

    addEventListenerSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 7.6.10 — parallel flush calls do not result in duplicate network calls
  // -------------------------------------------------------------------------
  it("parallel flush calls do not result in duplicate createSOSSession calls", async () => {
    let resolveFirst!: () => void;
    const firstCallStarted = new Promise<void>((r) => { resolveFirst = r; });

    const createFn = vi.fn().mockImplementation(async () => {
      resolveFirst();
      // Slow response to keep the lock held
      await new Promise<void>((r) => setTimeout(r, 50));
      return SUCCESS_RESPONSE;
    });

    const { queue } = makeQueue({ createSOSSession: createFn });
    await queue.open();
    await queue.enqueue(makePayload());

    // Start two flushes concurrently
    const [f1, f2] = [queue.flush(), queue.flush()];
    await firstCallStarted;
    await Promise.all([f1, f2]);

    // Despite two concurrent flush() calls, createSOSSession is called exactly once
    expect(createFn).toHaveBeenCalledTimes(1);
    expect(await queue._length()).toBe(0);
  });
});
