/**
 * offlineQueue — IndexedDB-backed SOS trigger offline queue.
 *
 * Stores SOS session payloads that could not be sent because the device was
 * offline. On reconnect (or after a periodic poll), `flush()` drains the
 * queue in strict FIFO order, calling the provided `createSOSSession`
 * adapter for each entry.
 *
 * ## Capacity (Req 8, Task 7.2)
 *
 * The queue holds at most 10 entries. When the 11th entry arrives, the
 * OLDEST entry is dropped (logged as a warn), not the newest. Rationale:
 * the newest trigger is the most relevant emergency signal.
 *
 * ## FIFO vs Priority — Design Decision
 *
 * Unlike Evidence Trail's offline queue (where a stuck file-upload entry
 * can be safely skipped so that later independent uploads proceed), SOS
 * entries are NOT independently retriable in the same way:
 *
 *   - Entries belong to the same user and are time-critical.
 *   - A stuck entry that eventually succeeds while a newer entry has
 *     already been processed would send a stale emergency signal — which
 *     is potentially worse than no signal at all.
 *
 * Therefore: flush IS sequential/FIFO, but stuck entries are EVICTED after
 * 3 failures (not skipped). Eviction is loud — a `warn` log and an
 * `onDropped` event are emitted so the caller (UI layer) can notify the
 * user that a trigger was lost. This differs from Evidence Trail where
 * entries are skipped-and-retried-later rather than dropped.
 *
 * A stuck entry NEVER silently permits a later entry to supersede it.
 *
 * ## Durability (Req 8, P28)
 *
 * Entries are persisted to IndexedDB before `enqueue` resolves. If the
 * app crashes after enqueue but before flush, the entry survives an app
 * restart — re-opening the DB returns it.
 *
 * ## Flush Serialization (Task 7.4)
 *
 * `flush()` is serialised by a `flushLock` flag. A second concurrent call
 * to `flush()` returns immediately without spawning a second network loop.
 *
 * ## Reconnect (Task 7.5)
 *
 * `init()` registers `window.addEventListener('online', ...)` exactly
 * once. The handler waits 5 seconds before calling `flush()` (Req 8).
 * If the device is already online at `init()` time, `flush()` is called
 * immediately.
 *
 * Requirements: design.md §offlineQueue, tasks.md Task 7
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueueEntry {
  /** Auto-incremented by IndexedDB — used as the FIFO ordering key. */
  id?: number;
  payload: CreateSOSSessionPayload;
  queuedAt: string; // ISO 8601
  retryCount: number;
}

/** Minimal payload type — mirrors types/sosSession.ts for cross-package use. */
export interface CreateSOSSessionPayload {
  triggerType: string;
  triggeredAt: string; // ISO 8601
  syncedAt: string;    // ISO 8601
  location: { latHash: string; lngHash: string } | null;
  deviceInfo: string;
}

export interface CreateSOSSessionResponse {
  sessionId: string;
  status: string;
  alreadyExists: boolean;
}

/** Injectable adapter — wraps the real Firebase callable for testing. */
export type CreateSOSSessionFn = (
  payload: CreateSOSSessionPayload
) => Promise<CreateSOSSessionResponse>;

/** Injectable scheduler for retry backoff — defaults to setTimeout. Injected in tests to avoid fake-timer/IDB conflicts. */
export type ScheduleFlushFn = (delayMs: number) => void;

/** Callback fired when an entry is dropped after max retries. */
export type OnDroppedFn = (entry: QueueEntry, reason: string) => void;

const DB_NAME = "raksha_sos";
const DB_VERSION = 1;
const STORE_NAME = "sos_queue";
const MAX_QUEUE_LENGTH = 10;
const MAX_RETRIES = 3;

/**
 * Exponential backoff base delay in milliseconds.
 * Successive failures: 30s, 60s, 120s, capped at 300s.
 */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 300_000;

// ---------------------------------------------------------------------------
// IndexedDB helpers (injectable for tests via IDBFactory override)
// ---------------------------------------------------------------------------

export function getIDBFactory(): IDBFactory {
  if (typeof indexedDB !== "undefined") return indexedDB;
  throw new Error("offlineQueue: IndexedDB is not available in this environment");
}

export function openDatabase(idb: IDBFactory = getIDBFactory()): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("queuedAt", "queuedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("phrase_template")) {
        db.createObjectStore("phrase_template", { keyPath: "userId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Low-level IDB operations (wrapped as Promises for readability)
// ---------------------------------------------------------------------------

function idbGetAll(db: IDBDatabase): Promise<QueueEntry[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as QueueEntry[]);
    req.onerror = () => reject(req.error);
  });
}

function idbAdd(db: IDBDatabase, entry: Omit<QueueEntry, "id">): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).add(entry);
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, entry: QueueEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// OfflineQueue class
// ---------------------------------------------------------------------------

export class OfflineQueue {
  private db: IDBDatabase | null = null;
  private flushLock = false;
  private onlineListenerRegistered = false;
  private readonly createSOSSession: CreateSOSSessionFn;
  private readonly onDropped: OnDroppedFn | undefined;
  private readonly idb: IDBFactory;
  private readonly scheduleFlushFn: ScheduleFlushFn;

  constructor(opts: {
    createSOSSession: CreateSOSSessionFn;
    onDropped?: OnDroppedFn;
    idb?: IDBFactory;
    /** Override the retry scheduler — used in tests to avoid fake-timer/IDB conflicts. */
    scheduleFlush?: ScheduleFlushFn;
  }) {
    this.createSOSSession = opts.createSOSSession;
    this.onDropped = opts.onDropped;
    this.idb = opts.idb ?? getIDBFactory();
    // Default: real setTimeout. Tests inject a synchronous capture function.
    this.scheduleFlushFn = opts.scheduleFlush ?? ((delayMs) => {
      setTimeout(() => void this.flush(), delayMs);
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async open(): Promise<void> {
    this.db = await openDatabase(this.idb);
  }

  /**
   * Initialises the queue:
   * - Opens the IndexedDB connection (if not already open).
   * - Registers the `window.online` listener exactly once.
   * - Flushes immediately if already online.
   *
   * Safe to call multiple times — the online listener is registered only once.
   */
  async init(): Promise<void> {
    if (!this.db) {
      await this.open();
    }

    if (!this.onlineListenerRegistered && typeof window !== "undefined") {
      window.addEventListener("online", () => {
        // 5-second delay before flushing per Req 8
        setTimeout(() => void this.flush(), 5_000);
      });
      this.onlineListenerRegistered = true;
    }

    // Flush immediately if already online
    if (typeof navigator !== "undefined" && navigator.onLine) {
      void this.flush();
    }
  }

  // -------------------------------------------------------------------------
  // enqueue
  // -------------------------------------------------------------------------

  /**
   * Persists a trigger payload to IndexedDB.
   *
   * If the queue already holds MAX_QUEUE_LENGTH entries, the OLDEST entry
   * is dropped first (logged as warn). The newest trigger is preserved as
   * the most operationally relevant emergency signal.
   */
  async enqueue(payload: CreateSOSSessionPayload): Promise<void> {
    const db = this.requireDb();

    const entries = await idbGetAll(db);

    if (entries.length >= MAX_QUEUE_LENGTH) {
      // Drop the oldest entry (lowest auto-incremented id = first inserted)
      const oldest = entries.reduce((a, b) => (a.id! < b.id! ? a : b));
      await idbDelete(db, oldest.id!);
      console.warn("[OfflineQueue] capacity limit reached — dropped oldest entry", {
        droppedId: oldest.id,
        droppedQueuedAt: oldest.queuedAt,
        queueLength: entries.length,
      });
    }

    await idbAdd(db, {
      payload,
      queuedAt: new Date().toISOString(),
      retryCount: 0,
    });
  }

  // -------------------------------------------------------------------------
  // enqueueAndFlush
  // -------------------------------------------------------------------------

  /**
   * Tries the network call first. If it succeeds, does NOT persist to
   * IndexedDB. Falls through to `enqueue` only on a network-level error.
   *
   * Returns the response on success, or undefined if the payload was queued.
   */
  async enqueueAndFlush(
    payload: CreateSOSSessionPayload
  ): Promise<CreateSOSSessionResponse | undefined> {
    try {
      const response = await this.createSOSSession(payload);
      // Network call succeeded — no queue entry needed
      return response;
    } catch (err: any) {
      const isNetworkError =
        err?.code === "unavailable" ||
        err?.message?.toLowerCase().includes("network") ||
        err?.message?.toLowerCase().includes("offline") ||
        err?.message?.toLowerCase().includes("failed to fetch");

      if (isNetworkError) {
        await this.enqueue(payload);
        return undefined;
      }
      // Non-network error (e.g. validation rejected by server) — re-throw
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // flush
  // -------------------------------------------------------------------------

  /**
   * Drains the queue in FIFO order, one entry at a time (serialised).
   *
   * **Stuck-entry eviction policy** (differs from Evidence Trail):
   * After MAX_RETRIES failures, the entry is DROPPED (not skipped) and
   * the `onDropped` callback fires. A time-critical SOS trigger that has
   * failed 3 times is likely stale and should not silently succeed later.
   *
   * Flush serialisation: only one concurrent flush loop runs at a time.
   */
  async flush(): Promise<void> {
    if (this.flushLock) return;
    this.flushLock = true;

    try {
      const db = this.requireDb();

      // Read all entries in ascending id order (FIFO)
      const entries = await idbGetAll(db);
      const sorted = [...entries].sort((a, b) => a.id! - b.id!);

      for (const entry of sorted) {
        try {
          await this.createSOSSession(entry.payload);
          // Success — remove from queue
          await idbDelete(db, entry.id!);
        } catch (err: any) {
          const updatedEntry: QueueEntry = {
            ...entry,
            retryCount: entry.retryCount + 1,
          };

          if (updatedEntry.retryCount >= MAX_RETRIES) {
            // EVICT after max retries — loud drop, not silent skip
            await idbDelete(db, entry.id!);
            const reason = `max retries (${MAX_RETRIES}) exceeded`;
            console.warn("[OfflineQueue] evicted stuck entry after max retries", {
              id: entry.id,
              queuedAt: entry.queuedAt,
              retryCount: updatedEntry.retryCount,
            });
            this.onDropped?.(entry, reason);
          } else {
            // Persist incremented retryCount and stop flushing (backoff)
            await idbPut(db, updatedEntry);
            const backoffMs = Math.min(
              BACKOFF_BASE_MS * Math.pow(2, updatedEntry.retryCount - 1),
              BACKOFF_MAX_MS
            );
            console.warn("[OfflineQueue] entry failed, scheduling backoff flush", {
              id: entry.id,
              retryCount: updatedEntry.retryCount,
              backoffMs,
            });
            // Release the lock before scheduling the retry
            this.flushLock = false;
            this.scheduleFlushFn(backoffMs);
            return; // Stop this flush run — backoff timer will restart it
          }
        }
      }
    } finally {
      this.flushLock = false;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireDb(): IDBDatabase {
    if (!this.db) {
      throw new Error("OfflineQueue: call open() or init() before using the queue");
    }
    return this.db;
  }

  /** Exposed for testing — returns all queue entries sorted by id. */
  async _getAll(): Promise<QueueEntry[]> {
    const db = this.requireDb();
    const entries = await idbGetAll(db);
    return entries.sort((a, b) => a.id! - b.id!);
  }

  /** Exposed for testing — returns current queue length. */
  async _length(): Promise<number> {
    const entries = await this._getAll();
    return entries.length;
  }
}
