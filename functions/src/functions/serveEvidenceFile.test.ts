/**
 * Tests for serveEvidenceFile (Phase 5).
 * Requirements: 5.5, 5.6, 6.6, 7.1, 7.2, 7.3
 */
import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";
import { runServeEvidenceFile } from "./serveEvidenceFile.js";
import { KMSMock } from "../kms/KMSMock.js";
import { aesGcmEncrypt } from "../utils/aesGcm.js";
import type { PipelineLogger } from "./onEvidenceCreate/pipeline.js";

const KEY_RING = "projects/test/keyRings/test/cryptoKeys/test";

function makeLogger(): PipelineLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// Build a document with a real encrypted file so the full decrypt path works
async function makeEncryptedDoc(kms: KMSMock, plaintext: Buffer, overrides: Record<string, unknown> = {}) {
  const { encryptedDEK, plaintextDEK, iv } = await kms.generateDataEncryptionKey(KEY_RING);
  const encryptedBytes = aesGcmEncrypt(plaintext, plaintextDEK, iv);
  const sha256 = crypto.createHash("sha256").update(plaintext).digest("hex");
  return {
    doc: {
      evidenceId: "ev-001", incidentId: "inc-001", userId: "user-001",
      type: "photo", storageRef: "evidence/ev-001/photo.jpg",
      originalFilename: "photo.jpg", mimeType: "image/jpeg", sizeBytes: plaintext.length,
      sha256Hash: sha256, encryptionKeyRef: encryptedDEK,
      encryptionIV: iv.toString("base64"),
      status: "available", retentionExpiresAt: null, legalHoldReason: null,
      chainOfCustody: [], createdAt: new Date("2024-01-01"), updatedAt: new Date("2024-01-01"),
      metadata: { capturedAt: new Date("2024-01-01"), deviceInfo: "test", locationHash: null, incidentContext: null },
      ...overrides,
    },
    encryptedBytes,
  };
}

function makeDb(
  doc: Record<string, unknown> | null,
  grantedContact?: { exists: boolean; revoked?: boolean }
) {
  const updates: unknown[] = [];
  return {
    db: {
      collection: vi.fn().mockImplementation((col: string) => {
        if (col === "grantedContacts") {
          return {
            doc: vi.fn().mockReturnValue({
              collection: vi.fn().mockReturnValue({
                doc: vi.fn().mockReturnValue({
                  get: vi.fn().mockResolvedValue({
                    exists: grantedContact?.exists ?? false,
                    data: () => ({ revoked: grantedContact?.revoked ?? false }),
                  }),
                }),
              }),
            }),
          };
        }
        // evidence collection
        return {
          doc: vi.fn().mockReturnValue({
            get: vi.fn().mockResolvedValue({ exists: doc !== null, data: () => doc ?? undefined }),
          }),
        };
      }),
      runTransaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          get: vi.fn().mockResolvedValue({
            exists: true,
            data: () => ({ ...doc, chainOfCustody: [] }),
          }),
          update: vi.fn((_: unknown, data: unknown) => updates.push(data)),
        };
        await fn(tx);
      }),
    } as unknown as import("firebase-admin/firestore").Firestore,
    updates,
  };
}

function makeBucket(encryptedBytes: Buffer, fail = false) {
  return {
    file: vi.fn().mockReturnValue({
      download: vi.fn().mockImplementation(async () => {
        if (fail) throw new Error("Storage unavailable");
        return [encryptedBytes];
      }),
    }),
  } as unknown as ReturnType<import("firebase-admin/storage").Storage["bucket"]>;
}

// ---------------------------------------------------------------------------
// Auth / authz
// ---------------------------------------------------------------------------
describe("serveEvidenceFile — auth and authz", () => {
  it("throws UNAUTHENTICATED for empty callerUid", async () => {
    const kms = new KMSMock();
    const { doc } = await makeEncryptedDoc(kms, Buffer.from("x"));
    const { db } = makeDb(doc);
    const err = await runServeEvidenceFile("ev-001", "", db, makeBucket(Buffer.alloc(0)), kms, makeLogger(), KEY_RING).catch(e => e);
    expect(err.code).toBe("UNAUTHENTICATED");
  });

  it("throws NOT_FOUND when document is missing", async () => {
    const { db } = makeDb(null);
    const err = await runServeEvidenceFile("ev-001", "uid", db, makeBucket(Buffer.alloc(0)), new KMSMock(), makeLogger(), KEY_RING).catch(e => e);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("throws PERMISSION_DENIED for unrelated user", async () => {
    const kms = new KMSMock();
    const { doc } = await makeEncryptedDoc(kms, Buffer.from("x"));
    const { db } = makeDb(doc, { exists: false });
    const err = await runServeEvidenceFile("ev-001", "hacker", db, makeBucket(Buffer.alloc(0)), kms, makeLogger(), KEY_RING).catch(e => e);
    expect(err.code).toBe("PERMISSION_DENIED");
  });

  it("allows access for a non-revoked GrantedContact (P12: access exclusivity)", async () => {
    const kms = new KMSMock();
    const plaintext = Buffer.from("secret evidence");
    const { doc, encryptedBytes } = await makeEncryptedDoc(kms, plaintext);
    const { db } = makeDb(doc, { exists: true, revoked: false });
    const result = await runServeEvidenceFile("ev-001", "granted-user", db, makeBucket(encryptedBytes), kms, makeLogger(), KEY_RING);
    expect(Buffer.from(result.data, "base64")).toEqual(plaintext);
  });

  it("throws PERMISSION_DENIED for a revoked GrantedContact (P12)", async () => {
    const kms = new KMSMock();
    const { doc } = await makeEncryptedDoc(kms, Buffer.from("x"));
    const { db } = makeDb(doc, { exists: true, revoked: true });
    const err = await runServeEvidenceFile("ev-001", "revoked-user", db, makeBucket(Buffer.alloc(0)), kms, makeLogger(), KEY_RING).catch(e => e);
    expect(err.code).toBe("PERMISSION_DENIED");
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
describe("serveEvidenceFile — happy path", () => {
  it("decrypts and returns the plaintext file with correct mimeType", async () => {
    const kms = new KMSMock();
    const plaintext = Buffer.from("real evidence content");
    const { doc, encryptedBytes } = await makeEncryptedDoc(kms, plaintext);
    const { db } = makeDb(doc);
    const result = await runServeEvidenceFile("ev-001", "user-001", db, makeBucket(encryptedBytes), kms, makeLogger(), KEY_RING);
    expect(Buffer.from(result.data, "base64")).toEqual(plaintext);
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("appends a 'viewed' custody entry with native Date timestamp (Req 5.6, P10)", async () => {
    const kms = new KMSMock();
    const plaintext = Buffer.from("file");
    const { doc, encryptedBytes } = await makeEncryptedDoc(kms, plaintext);
    const { db, updates } = makeDb(doc);
    await runServeEvidenceFile("ev-001", "user-001", db, makeBucket(encryptedBytes), kms, makeLogger(), KEY_RING);
    const custody = (updates[0] as Record<string, unknown>)["chainOfCustody"] as unknown[];
    const entry = custody[0] as Record<string, unknown>;
    expect(entry["action"]).toBe("viewed");
    expect(entry["performedBy"]).toBe("user-001");
    expect(entry["timestamp"]).toBeInstanceOf(Date); // CRITICAL: native Date
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------
describe("serveEvidenceFile — error paths", () => {
  it("throws UNAVAILABLE when Storage file is inaccessible", async () => {
    const kms = new KMSMock();
    const { doc } = await makeEncryptedDoc(kms, Buffer.from("x"));
    const { db } = makeDb(doc);
    const err = await runServeEvidenceFile("ev-001", "user-001", db, makeBucket(Buffer.alloc(0), true), kms, makeLogger(), KEY_RING).catch(e => e);
    expect(err.code).toBe("UNAVAILABLE");
  });

  it("throws INTERNAL when KMS decryption fails — no bytes transmitted", async () => {
    const kms = new KMSMock();
    const plaintext = Buffer.from("file");
    const { doc, encryptedBytes } = await makeEncryptedDoc(kms, plaintext);
    // Use a KMS stub that unconditionally rejects — the stateless KMSMock cannot
    // simulate cross-instance isolation (it decrypts any MOCK:-prefixed DEK).
    const rejectingKms = {
      generateDataEncryptionKey: vi.fn(),
      decryptDataEncryptionKey: vi.fn().mockRejectedValue(new Error("KMS unavailable")),
    } as unknown as KMSMock;
    const { db } = makeDb(doc);
    const err = await runServeEvidenceFile("ev-001", "user-001", db, makeBucket(encryptedBytes), rejectingKms, makeLogger(), KEY_RING).catch(e => e);
    expect(err.code).toBe("INTERNAL");
  });

  it("throws DATA_LOSS when ciphertext auth tag fails (tampered file)", async () => {
    const kms = new KMSMock();
    const plaintext = Buffer.from("real file");
    const { doc, encryptedBytes } = await makeEncryptedDoc(kms, plaintext);
    // Corrupt the ciphertext
    const tampered = Buffer.from(encryptedBytes);
    tampered[0] ^= 0xff;
    const { db } = makeDb(doc);
    const err = await runServeEvidenceFile("ev-001", "user-001", db, makeBucket(tampered), kms, makeLogger(), KEY_RING).catch(e => e);
    expect(err.code).toBe("DATA_LOSS");
  });

  it("throws INTERNAL when custody append fails — no bytes returned (Req 5.5)", async () => {
    const kms = new KMSMock();
    const plaintext = Buffer.from("file");
    const { doc, encryptedBytes } = await makeEncryptedDoc(kms, plaintext);
    // Make the transaction throw
    const db = {
      collection: vi.fn().mockImplementation((col: string) => {
        if (col === "grantedContacts") {
          return { doc: vi.fn().mockReturnValue({ collection: vi.fn().mockReturnValue({ doc: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue({ exists: false }) }) }) }) };
        }
        return { doc: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue({ exists: true, data: () => doc }) }) };
      }),
      runTransaction: vi.fn().mockRejectedValue(new Error("Firestore unavailable")),
    } as unknown as import("firebase-admin/firestore").Firestore;
    const err = await runServeEvidenceFile("ev-001", "user-001", db, makeBucket(encryptedBytes), kms, makeLogger(), KEY_RING).catch(e => e);
    expect(err.code).toBe("INTERNAL");
  });
});
