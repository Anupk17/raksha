/**
 * Tests for phraseEnrolment (Task 11.4).
 *
 * Requirements: tasks.md Task 11.4
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { enrolPhrase } from "./phraseEnrolment.js";
import { openDatabase } from "./offlineQueue.js";

function makeFreshIDB(): IDBFactory {
  return new IDBFactory();
}

describe("phraseEnrolment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 11.4.1 — stores encrypted (not plaintext) token sequence in IndexedDB
  // -------------------------------------------------------------------------
  it("stores encrypted (not plaintext) token sequence in IndexedDB", async () => {
    const idb = makeFreshIDB();
    const mockTokens = new Float32Array([1.5, 2.5, -3.5, 4.0]);
    const audioBuffer = new Float32Array([0.1, 0.2, 0.3, 0.4]);

    const extractTokens = vi.fn().mockResolvedValue(mockTokens);

    await enrolPhrase(audioBuffer, "user-abc", "salt-123", {
      idb,
      extractTokens,
    });

    const db = await openDatabase(idb);
    const tx = db.transaction("phrase_template", "readonly");
    const store = tx.objectStore("phrase_template");
    const record = await new Promise<any>((resolve, reject) => {
      const req = store.get("user-abc");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    expect(record).toBeDefined();
    expect(record.userId).toBe("user-abc");
    expect(record.encryptedTemplate).toBeDefined();
    expect(record.encryptedTemplate.constructor.name).toBe("Uint8Array");

    // Verify it is encrypted: plaintext representation of the array must not be in the bytes
    const textDecoder = new TextDecoder();
    const decodedString = textDecoder.decode(record.encryptedTemplate);
    expect(decodedString).not.toContain("1.5");
    expect(decodedString).not.toContain("2.5");
    expect(decodedString).not.toContain("-3.5");
  });

  // -------------------------------------------------------------------------
  // 11.4.2 — zeroes the plaintext buffer after encryption
  // -------------------------------------------------------------------------
  it("zeroes the plaintext buffers (audioBuffer and tokenSequence) after encryption", async () => {
    const idb = makeFreshIDB();
    const mockTokens = new Float32Array([1.5, 2.5, -3.5, 4.0]);
    const audioBuffer = new Float32Array([0.1, 0.2, 0.3, 0.4]);

    const extractTokens = vi.fn().mockResolvedValue(mockTokens);

    await enrolPhrase(audioBuffer, "user-abc", "salt-123", {
      idb,
      extractTokens,
    });

    // Plaintext buffers must be filled with 0
    expect(Array.from(audioBuffer)).toEqual([0, 0, 0, 0]);
    expect(Array.from(mockTokens)).toEqual([0, 0, 0, 0]);
  });
});
