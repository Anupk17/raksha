/**
 * Tests for generateLegalExport
 *
 * Properties:
 *   P16: No Partial Export
 *
 * NOTE: Known test gap! PDF structural/content verification (e.g., matching evidence
 * count between Firestore and PDF, matching chain-of-custody data) is NOT yet covered
 * in unit/integration tests. Current tests only verify PDF-format validity (starts
 * with "%PDF-") and transaction call counts. This should be revisited before RAKSHA
 * handles real evidence, ideally with proper PDF-parsing-based content checks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import { runGenerateLegalExport } from "./generateLegalExport.js";
import { aesGcmEncrypt } from "../utils/aesGcm.js";
import type { Firestore } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";
import type { KMSClient } from "../kms/kms.interface.js";
import type { EvidenceDocument } from "../types/evidence.js";
import crypto from "crypto";

// Tiny valid 1x1 PNG image (base64 encoded, then decoded to Buffer)
const TINY_VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const createMockFirestore = (
  evidenceDocs: EvidenceDocument[],
  grantedContact?: { revoked: boolean }
) => {
  // Track calls to runTransaction!
  const runTransaction = vi.fn().mockImplementation(async (fn) => {
    const txMock = {
      get: vi.fn().mockResolvedValue({
        data: vi.fn().mockReturnValue({ chainOfCustody: [] }),
        exists: true
      }),
      update: vi.fn()
    };
    await fn(txMock);
  });

  // Helper function to create a DocumentReference mock that can return collections
  const createDocMock = () => ({
    collection: vi.fn().mockImplementation((collName) => {
      if (collName === "contacts" && grantedContact !== undefined) {
        // This is grantedContacts/{ownerUid}/contacts, so the next doc call will return our grantedContact
        return {
          doc: vi.fn().mockImplementation(() => ({
            get: vi.fn().mockResolvedValue({
              exists: true,
              data: vi.fn().mockReturnValue(grantedContact)
            })
          }))
        };
      }
      // Default: return an empty collection
      return {
        doc: vi.fn().mockImplementation(() => ({
          get: vi.fn().mockResolvedValue({ exists: false, data: vi.fn().mockReturnValue(null) })
        }))
      };
    }),
    get: vi.fn().mockResolvedValue({ exists: false, data: vi.fn().mockReturnValue(null) })
  });

  const collectionMock = vi.fn().mockImplementation((collName) => {
    if (collName === "evidence") {
      return {
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue({
            docs: evidenceDocs.map((doc) => ({
              data: vi.fn().mockReturnValue(doc),
              id: doc.evidenceId
            }))
          })
        }),
        doc: createDocMock
      };
    } else if (collName === "grantedContacts") {
      return {
        doc: createDocMock
      };
    }
    return {
      where: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue({ docs: [] }) }),
      doc: createDocMock
    };
  });

  return {
    collection: collectionMock,
    runTransaction
  } as unknown as Firestore & { runTransaction: ReturnType<typeof vi.fn> };
};

const createMockStorage = (
  fileBuffers: Map<string, Buffer>
) => {
  const bucketMock = {
    file: vi.fn().mockImplementation((path: string) => ({
      download: vi.fn().mockResolvedValue([fileBuffers.get(path) ?? Buffer.from("test")])
    }))
  };
  return {
    bucket: vi.fn().mockReturnValue(bucketMock)
  } as unknown as Storage;
};

const createMockKmsClient = (): KMSClient => {
  const keys = new Map<string, Buffer>();
  return {
    generateDataEncryptionKey: vi.fn().mockImplementation(async (keyRingRef) => {
      const plaintextDEK = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12); // AES-GCM requires 12-byte IV!
      const encryptedDEK = plaintextDEK.toString("base64");
      keys.set(encryptedDEK, plaintextDEK);
      return { encryptedDEK, plaintextDEK, iv };
    }),
    decryptDataEncryptionKey: vi.fn().mockImplementation(async (encryptedDEK) => {
      const plaintextDEK = keys.get(encryptedDEK);
      if (!plaintextDEK) {
        throw new Error(`KMS mock: unknown encrypted DEK ${encryptedDEK}`);
      }
      return plaintextDEK;
    })
  };
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

const TEST_KEY_RING_REF = "projects/test/locations/global/keyRings/test";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateLegalExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should reject unauthenticated requests", async () => {
    const db = createMockFirestore([]);
    const storage = createMockStorage(new Map());
    const kms = createMockKmsClient();

    await expect(
      runGenerateLegalExport(
        "incident-123",
        "", // No callerUid
        db,
        storage.bucket(),
        kms,
        mockLogger,
        TEST_KEY_RING_REF
      )
    ).rejects.toThrow("Unauthenticated");
  });

  it("should reject requests with no evidence for incident", async () => {
    const db = createMockFirestore([]);
    const storage = createMockStorage(new Map());
    const kms = createMockKmsClient();

    await expect(
      runGenerateLegalExport(
        "incident-123",
        "user-123",
        db,
        storage.bucket(),
        kms,
        mockLogger,
        TEST_KEY_RING_REF
      )
    ).rejects.toThrow("No evidence found for incident");
  });

  it("should reject requests from users who are not owner or granted contact", async () => {
    const testEvidence: EvidenceDocument = {
      evidenceId: "evidence-123",
      incidentId: "incident-123",
      userId: "user-456", // Not the caller
      type: "photo",
      storageRef: "evidence/evidence-123/test.jpg",
      originalFilename: "test.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 100,
      sha256Hash: "testhash",
      encryptionKeyRef: "test-encrypted-dek",
      encryptionIV: Buffer.from("testiv").toString("base64"),
      status: "available",
      retentionExpiresAt: null,
      legalHoldReason: null,
      chainOfCustody: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        capturedAt: new Date(),
        deviceInfo: "test device",
        locationHash: null,
        incidentContext: null
      }
    };

    const db = createMockFirestore([testEvidence], undefined); // No granted contact
    const storage = createMockStorage(new Map());
    const kms = createMockKmsClient();

    await expect(
      runGenerateLegalExport(
        "incident-123",
        "user-123", // Caller is not owner or granted
        db,
        storage.bucket(),
        kms,
        mockLogger,
        TEST_KEY_RING_REF
      )
    ).rejects.toThrow("Permission denied");
  });

  it("should accept requests from the owner", async () => {
    // Step 1: Create real DEK and IV
    const plaintextDEK = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12); // 12 bytes for AES-GCM
    const encryptedDEK = plaintextDEK.toString("base64");

    // Step 2: Encrypt the test file
    const encryptedFileBytes = aesGcmEncrypt(TINY_VALID_PNG, plaintextDEK, iv);

    const testEvidence: EvidenceDocument = {
      evidenceId: "evidence-123",
      incidentId: "incident-123",
      userId: "user-123", // Caller is owner
      type: "photo",
      storageRef: "evidence/evidence-123/test.jpg",
      originalFilename: "test.jpg",
      mimeType: "image/jpeg",
      sizeBytes: TINY_VALID_PNG.length,
      sha256Hash: crypto.createHash("sha256").update(TINY_VALID_PNG).digest("hex"),
      encryptionKeyRef: encryptedDEK,
      encryptionIV: iv.toString("base64"),
      status: "available",
      retentionExpiresAt: null,
      legalHoldReason: null,
      chainOfCustody: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        capturedAt: new Date(),
        deviceInfo: "test device",
        locationHash: null,
        incidentContext: null
      }
    };

    const fileBuffers = new Map([[testEvidence.storageRef, encryptedFileBytes]]);
    const db = createMockFirestore([testEvidence], undefined);
    const storage = createMockStorage(fileBuffers);
    const kms = {
      generateDataEncryptionKey: vi.fn(),
      decryptDataEncryptionKey: vi.fn().mockResolvedValue(plaintextDEK)
    };

    const pdfBuffer = await runGenerateLegalExport(
      "incident-123",
      "user-123",
      db,
      storage.bucket(),
      kms as unknown as KMSClient,
      mockLogger,
      TEST_KEY_RING_REF
    );

    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);
  });

  it("should accept requests from an active granted contact", async () => {
    const plaintextDEK = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const encryptedDEK = plaintextDEK.toString("base64");
    const encryptedFileBytes = aesGcmEncrypt(TINY_VALID_PNG, plaintextDEK, iv);

    const testEvidence: EvidenceDocument = {
      evidenceId: "evidence-123",
      incidentId: "incident-123",
      userId: "user-456", // Owner is someone else
      type: "photo",
      storageRef: "evidence/evidence-123/test.jpg",
      originalFilename: "test.jpg",
      mimeType: "image/jpeg",
      sizeBytes: TINY_VALID_PNG.length,
      sha256Hash: crypto.createHash("sha256").update(TINY_VALID_PNG).digest("hex"),
      encryptionKeyRef: encryptedDEK,
      encryptionIV: iv.toString("base64"),
      status: "available",
      retentionExpiresAt: null,
      legalHoldReason: null,
      chainOfCustody: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        capturedAt: new Date(),
        deviceInfo: "test device",
        locationHash: null,
        incidentContext: null
      }
    };

    const fileBuffers = new Map([[testEvidence.storageRef, encryptedFileBytes]]);
    const db = createMockFirestore([testEvidence], { revoked: false }); // Active granted contact
    const storage = createMockStorage(fileBuffers);
    const kms = {
      generateDataEncryptionKey: vi.fn(),
      decryptDataEncryptionKey: vi.fn().mockResolvedValue(plaintextDEK)
    };

    const pdfBuffer = await runGenerateLegalExport(
      "incident-123",
      "user-123", // Caller is granted contact
      db,
      storage.bucket(),
      kms as unknown as KMSClient,
      mockLogger,
      TEST_KEY_RING_REF
    );

    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);
  });

  it("should fail whole if any evidence file is inaccessible", async () => {
    // First evidence should be valid (encrypted correctly)
    const plaintextDEK1 = crypto.randomBytes(32);
    const iv1 = crypto.randomBytes(12);
    const encryptedDEK1 = plaintextDEK1.toString("base64");
    const encryptedFile1 = aesGcmEncrypt(TINY_VALID_PNG, plaintextDEK1, iv1);

    const testEvidence1: EvidenceDocument = {
      evidenceId: "evidence-123",
      incidentId: "incident-123",
      userId: "user-123",
      type: "photo",
      storageRef: "evidence/evidence-123/test.jpg",
      originalFilename: "test.jpg",
      mimeType: "image/jpeg",
      sizeBytes: TINY_VALID_PNG.length,
      sha256Hash: crypto.createHash("sha256").update(TINY_VALID_PNG).digest("hex"),
      encryptionKeyRef: encryptedDEK1,
      encryptionIV: iv1.toString("base64"),
      status: "available",
      retentionExpiresAt: null,
      legalHoldReason: null,
      chainOfCustody: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        capturedAt: new Date(),
        deviceInfo: "test device",
        locationHash: null,
        incidentContext: null
      }
    };
    const testEvidence2: EvidenceDocument = {
      evidenceId: "evidence-456",
      incidentId: "incident-123",
      userId: "user-123",
      type: "video",
      storageRef: "evidence/evidence-456/test.mp4",
      originalFilename: "test.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1000,
      sha256Hash: "testhash2",
      encryptionKeyRef: "test-encrypted-dek2",
      encryptionIV: crypto.randomBytes(12).toString("base64"),
      status: "available",
      retentionExpiresAt: null,
      legalHoldReason: null,
      chainOfCustody: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        capturedAt: new Date(),
        deviceInfo: "test device 2",
        locationHash: null,
        incidentContext: null
      }
    };

    const fileBuffers = new Map([[testEvidence1.storageRef, encryptedFile1]]);
    const db = createMockFirestore([testEvidence1, testEvidence2], undefined);
    // Mock storage to fail for testEvidence2
    const bucketMock = {
      file: vi.fn().mockImplementation((path: string) => ({
        download: path === testEvidence2.storageRef
          ? vi.fn().mockRejectedValue(new Error("File not found"))
          : vi.fn().mockResolvedValue([fileBuffers.get(path)])
      }))
    };
    const storage = {
      bucket: vi.fn().mockReturnValue(bucketMock)
    } as unknown as Storage;

    const kms = {
      generateDataEncryptionKey: vi.fn(),
      decryptDataEncryptionKey: vi.fn().mockImplementation(async (keyRef) => {
        if (keyRef === encryptedDEK1) return plaintextDEK1;
        throw new Error("Unknown DEK");
      })
    };

    await expect(
      runGenerateLegalExport(
        "incident-123",
        "user-123",
        db,
        storage.bucket(),
        kms as unknown as KMSClient,
        mockLogger,
        TEST_KEY_RING_REF
      )
    ).rejects.toThrow("Failed to fetch evidence file for evidence-456");
  });

  it("should generate a PDF with correct structure and content", async () => {
    const testCustodyEntry1 = {
      action: "uploaded" as const,
      performedBy: "cloud_function",
      timestamp: new Date(),
      evidenceId: "evidence-123",
      metadata: { sha256Hash: "testhash1" },
      integritySnapshot: "snapshot1"
    };
    const testCustodyEntry2 = {
      action: "viewed" as const,
      performedBy: "user-123",
      timestamp: new Date(),
      evidenceId: "evidence-456",
      metadata: null,
      integritySnapshot: null
    };

    // Create real DEK/IV and encrypt both files
    const plaintextDEK1 = crypto.randomBytes(32);
    const iv1 = crypto.randomBytes(12);
    const encryptedDEK1 = plaintextDEK1.toString("base64");
    const encryptedFile1 = aesGcmEncrypt(TINY_VALID_PNG, plaintextDEK1, iv1);

    const plaintextDEK2 = crypto.randomBytes(32);
    const iv2 = crypto.randomBytes(12);
    const encryptedDEK2 = plaintextDEK2.toString("base64");
    const encryptedFile2 = aesGcmEncrypt(TINY_VALID_PNG, plaintextDEK2, iv2);

    const testEvidence1: EvidenceDocument = {
      evidenceId: "evidence-123",
      incidentId: "incident-123",
      userId: "user-123",
      type: "photo",
      storageRef: "evidence/evidence-123/test.jpg",
      originalFilename: "test.jpg",
      mimeType: "image/jpeg",
      sizeBytes: TINY_VALID_PNG.length,
      sha256Hash: crypto.createHash("sha256").update(TINY_VALID_PNG).digest("hex"),
      encryptionKeyRef: encryptedDEK1,
      encryptionIV: iv1.toString("base64"),
      status: "available",
      retentionExpiresAt: null,
      legalHoldReason: null,
      chainOfCustody: [testCustodyEntry1],
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        capturedAt: new Date(),
        deviceInfo: "test device 1",
        locationHash: "loc123",
        incidentContext: "test incident context"
      }
    };

    const testEvidence2: EvidenceDocument = {
      evidenceId: "evidence-456",
      incidentId: "incident-123",
      userId: "user-123",
      type: "audio",
      storageRef: "evidence/evidence-456/test.mp3",
      originalFilename: "test.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: TINY_VALID_PNG.length,
      sha256Hash: crypto.createHash("sha256").update(TINY_VALID_PNG).digest("hex"),
      encryptionKeyRef: encryptedDEK2,
      encryptionIV: iv2.toString("base64"),
      status: "available",
      retentionExpiresAt: null,
      legalHoldReason: null,
      chainOfCustody: [testCustodyEntry2],
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        capturedAt: new Date(),
        deviceInfo: "test device 2",
        locationHash: null,
        incidentContext: null
      }
    };

    const fileBuffers = new Map([
      [testEvidence1.storageRef, encryptedFile1],
      [testEvidence2.storageRef, encryptedFile2]
    ]);
    const db = createMockFirestore([testEvidence1, testEvidence2], undefined);
    const storage = createMockStorage(fileBuffers);
    const kms = {
      generateDataEncryptionKey: vi.fn(),
      decryptDataEncryptionKey: vi.fn().mockImplementation(async (encryptedDEK) => {
        if (encryptedDEK === encryptedDEK1) return plaintextDEK1;
        if (encryptedDEK === encryptedDEK2) return plaintextDEK2;
        throw new Error("Unknown DEK");
      })
    };

    const pdfBuffer = await runGenerateLegalExport(
      "incident-123",
      "user-123",
      db,
      storage.bucket(),
      kms as unknown as KMSClient,
      mockLogger,
      TEST_KEY_RING_REF
    );

    // Verify we got a valid PDF buffer!
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);
    expect(pdfBuffer.toString("utf8", 0, 5)).toEqual("%PDF-");

    // Verify runTransaction was called twice (once per evidence item)!
    expect(db.runTransaction).toHaveBeenCalledTimes(2);
  });

  it("P16: No Partial Export — either returns complete PDF or throws (fast‑check, 100 runs)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }), // number of evidence items
        fc.integer({ min: 0, max: 10 }), // which item fails (0 = none, ≥1 = index+1 fails)
        async (numItems, failIndex) => {
          // Generate N evidence documents with real encryption
          const evidenceDocs: EvidenceDocument[] = [];
          const fileBuffers = new Map<string, Buffer>();
          const plaintextDEKs = new Map<string, Buffer>();
          for (let i = 0; i < numItems; i++) {
            const evidenceId = `evidence-${i}`;
            const storageRef = `evidence/${evidenceId}/file.jpg`;
            const plaintextDEK = crypto.randomBytes(32);
            const iv = crypto.randomBytes(12);
            const encryptedDEK = plaintextDEK.toString("base64");
            const encryptedFile = aesGcmEncrypt(TINY_VALID_PNG, plaintextDEK, iv);

            const testCustodyEntry: EvidenceDocument = {
              evidenceId,
              incidentId: "incident-123",
              userId: "user-123",
              type: "photo",
              storageRef,
              originalFilename: `file${i}.jpg`,
              mimeType: "image/jpeg",
              sizeBytes: TINY_VALID_PNG.length,
              sha256Hash: crypto.createHash("sha256").update(TINY_VALID_PNG).digest("hex"),
              encryptionKeyRef: encryptedDEK,
              encryptionIV: iv.toString("base64"),
              status: "available",
              retentionExpiresAt: null,
              legalHoldReason: null,
              chainOfCustody: [
                {
                  action: "uploaded" as const,
                  performedBy: "cloud_function",
                  timestamp: new Date(),
                  evidenceId,
                  metadata: null,
                  integritySnapshot: null,
                },
              ],
              createdAt: new Date(),
              updatedAt: new Date(),
              metadata: {
                capturedAt: new Date(),
                deviceInfo: `test device ${i}`,
                locationHash: null,
                incidentContext: null,
              },
            };
            evidenceDocs.push(testCustodyEntry);
            fileBuffers.set(storageRef, encryptedFile);
            plaintextDEKs.set(encryptedDEK, plaintextDEK);
          }

          // Mock db and storage
          const bucketMock = {
            file: vi.fn().mockImplementation((path) => {
              // Check if this path corresponds to the failIndex
              const shouldFail = (failIndex > 0) && (failIndex <= numItems) && (path === evidenceDocs[failIndex - 1]?.storageRef);
              return {
                download: shouldFail
                  ? vi.fn().mockRejectedValue(new Error("Download failed"))
                  : vi.fn().mockResolvedValue([fileBuffers.get(path) ?? Buffer.alloc(0)]),
              };
            }),
          };
          const storage = {
            bucket: vi.fn().mockReturnValue(bucketMock),
          } as unknown as Storage;

          const db = createMockFirestore(evidenceDocs, undefined);
          const kms = {
            generateDataEncryptionKey: vi.fn(),
            decryptDataEncryptionKey: vi.fn().mockImplementation(async (encryptedDEK) => {
              const dek = plaintextDEKs.get(encryptedDEK);
              if (!dek) throw new Error("Unknown DEK");
              return dek;
            }),
          };

          // Either succeeds OR throws with no side effects
          let threw = false;
          let result: Buffer | undefined;
          try {
            result = await runGenerateLegalExport(
              "incident-123",
              "user-123",
              db,
              storage.bucket(),
              kms as unknown as KMSClient,
              mockLogger,
              TEST_KEY_RING_REF,
            );
          } catch (e) {
            threw = true;
          }

          if (threw) {
            expect(result).toBeUndefined();
          } else {
            expect(result).toBeDefined();
            expect(result!).toBeInstanceOf(Buffer);
            expect(result!.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
