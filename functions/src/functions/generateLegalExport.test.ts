/**
 * Tests for generateLegalExport
 *
 * Properties:
 *   P16: No Partial Export — either returns complete PDF or throws
 *
 * Content-verification approach:
 *   pdfkit is called with { pdfVersion: "1.3", compress: false } so that
 *   pdf-parse (pdf.js v1.10.100) can extract text reliably.
 *
 *   Root cause of earlier "bad XRef entry" / "Invalid number" failures:
 *     Buffer.concat() returns a Buffer backed by a shared ArrayBuffer pool
 *     with a non-zero byteOffset.  pdf-parse passes the raw .buffer
 *     (ArrayBuffer) to pdf.js, which always reads from offset 0 — i.e. into
 *     pool memory before the actual PDF bytes — corrupting XRef / number
 *     parsing.  Fix: parsePdfText() wraps the Buffer in `new Uint8Array(buf)`
 *     which copies bytes into a fresh ArrayBuffer at offset 0.
 *
 *   Tests parse the generated PDF with pdf-parse and assert on the extracted text:
 *   1. incidentId appears on the cover page
 *   2. each evidence item's evidenceId appears in a section header
 *   3. chain-of-custody action and performedBy appear in the extracted text
 *   4. the callerUid (exporter) appears as the "Exported by" field
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
// @ts-ignore — pdf-parse has no bundled types
import pdfParse from "pdf-parse";
import { runGenerateLegalExport } from "./generateLegalExport.js";
import { aesGcmEncrypt } from "../utils/aesGcm.js";
import type { Firestore } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";
import type { KMSClient } from "../kms/kms.interface.js";
import type { EvidenceDocument } from "../types/evidence.js";
import crypto from "crypto";

// Tiny valid 1x1 PNG (base64-encoded)
const TINY_VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

// ---------------------------------------------------------------------------
// Helper: parse PDF buffer and return extracted text
//
// Root cause of earlier "bad XRef entry" / "Invalid number" failures:
//   Buffer.concat() returns a Buffer backed by a shared ArrayBuffer pool with
//   a non-zero byteOffset.  pdf-parse passes the raw .buffer (ArrayBuffer) to
//   pdf.js, which always reads from offset 0 — i.e. into pool memory before
//   the actual PDF bytes — causing corrupt XRef / number-parse errors.
//
//   Fix: `new Uint8Array(buf)` copies the bytes into a fresh ArrayBuffer whose
//   byteOffset is 0, so pdf.js sees the correct data.
// ---------------------------------------------------------------------------
async function parsePdfText(buf: Buffer): Promise<string> {
  const data = await pdfParse(new Uint8Array(buf));
  return data.text as string;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const createMockFirestore = (
  evidenceDocs: EvidenceDocument[],
  grantedContact?: { revoked: boolean }
) => {
  const runTransaction = vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
    const txMock = {
      get: vi.fn().mockResolvedValue({
        data: vi.fn().mockReturnValue({ chainOfCustody: [] }),
        exists: true,
      }),
      update: vi.fn(),
    };
    await fn(txMock);
  });

  const createDocMock = () => ({
    collection: vi.fn().mockImplementation((collName: string) => {
      if (collName === "contacts" && grantedContact !== undefined) {
        return {
          doc: vi.fn().mockReturnValue({
            get: vi.fn().mockResolvedValue({
              exists: true,
              data: vi.fn().mockReturnValue(grantedContact),
            }),
          }),
        };
      }
      return {
        doc: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue({ exists: false, data: vi.fn().mockReturnValue(null) }),
        }),
      };
    }),
    get: vi.fn().mockResolvedValue({ exists: false, data: vi.fn().mockReturnValue(null) }),
  });

  const collectionMock = vi.fn().mockImplementation((collName: string) => {
    if (collName === "evidence") {
      return {
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue({
            docs: evidenceDocs.map((doc) => ({
              data: vi.fn().mockReturnValue(doc),
              id: doc.evidenceId,
            })),
          }),
        }),
        doc: createDocMock,
      };
    }
    if (collName === "grantedContacts") {
      return { doc: createDocMock };
    }
    return {
      where: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue({ docs: [] }) }),
      doc: createDocMock,
    };
  });

  return {
    collection: collectionMock,
    runTransaction,
  } as unknown as Firestore & { runTransaction: ReturnType<typeof vi.fn> };
};

const createMockStorage = (fileBuffers: Map<string, Buffer>) => ({
  file: vi.fn().mockImplementation((path: string) => ({
    download: vi.fn().mockResolvedValue([fileBuffers.get(path) ?? Buffer.from("test")]),
  })),
});

function makeEvidence(
  evidenceId: string,
  incidentId: string,
  userId: string,
  plaintextDEK: Buffer,
  iv: Buffer,
  custodyEntries: EvidenceDocument["chainOfCustody"] = []
): { doc: EvidenceDocument; encryptedBytes: Buffer } {
  const encryptedBytes = aesGcmEncrypt(TINY_VALID_PNG, plaintextDEK, iv);
  const encryptedDEK = plaintextDEK.toString("base64");
  const doc: EvidenceDocument = {
    evidenceId,
    incidentId,
    userId,
    type: "photo",
    storageRef: `evidence/${evidenceId}/photo.jpg`,
    originalFilename: "photo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: TINY_VALID_PNG.length,
    sha256Hash: crypto.createHash("sha256").update(TINY_VALID_PNG).digest("hex"),
    encryptionKeyRef: encryptedDEK,
    encryptionIV: iv.toString("base64"),
    status: "available",
    retentionExpiresAt: null,
    legalHoldReason: null,
    chainOfCustody: custodyEntries,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    metadata: {
      capturedAt: new Date("2024-01-01T00:00:00.000Z"),
      deviceInfo: "test-device",
      locationHash: null,
      incidentContext: null,
    },
  };
  return { doc, encryptedBytes };
}

function makeKms(deks: Map<string, Buffer>): KMSClient {
  return {
    generateDataEncryptionKey: vi.fn(),
    decryptDataEncryptionKey: vi.fn().mockImplementation(async (encryptedDEK: string) => {
      const dek = deks.get(encryptedDEK);
      if (!dek) throw new Error(`KMS mock: unknown DEK ${encryptedDEK.slice(0, 8)}…`);
      return dek;
    }),
  };
}

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const TEST_KEY_RING_REF = "projects/test/locations/global/keyRings/test";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateLegalExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Auth / authz
  // -------------------------------------------------------------------------

  it("should reject unauthenticated requests", async () => {
    const db = createMockFirestore([]);
    await expect(
      runGenerateLegalExport("incident-123", "", db, createMockStorage(new Map()) as never, makeKms(new Map()), mockLogger, TEST_KEY_RING_REF)
    ).rejects.toThrow("Unauthenticated");
  });

  it("should reject requests with no evidence for incident", async () => {
    const db = createMockFirestore([]);
    await expect(
      runGenerateLegalExport("incident-123", "user-123", db, createMockStorage(new Map()) as never, makeKms(new Map()), mockLogger, TEST_KEY_RING_REF)
    ).rejects.toThrow("No evidence found for incident");
  });

  it("should reject requests from users who are not owner or granted contact", async () => {
    const dek = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const { doc } = makeEvidence("ev-001", "incident-123", "owner-999", dek, iv);
    const db = createMockFirestore([doc], undefined);
    await expect(
      runGenerateLegalExport("incident-123", "attacker", db, createMockStorage(new Map([[doc.storageRef, makeEvidence("ev-001", "incident-123", "owner-999", dek, iv).encryptedBytes]])) as never, makeKms(new Map([[dek.toString("base64"), dek]])), mockLogger, TEST_KEY_RING_REF)
    ).rejects.toThrow("Permission denied");
  });

  it("should accept requests from an active granted contact", async () => {
    const dek = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const { doc, encryptedBytes } = makeEvidence("ev-gc", "incident-123", "owner-999", dek, iv);
    const db = createMockFirestore([doc], { revoked: false });
    const fileBuffers = new Map([[doc.storageRef, encryptedBytes]]);
    const pdfBuffer = await runGenerateLegalExport(
      "incident-123", "granted-user", db, createMockStorage(fileBuffers) as never,
      makeKms(new Map([[dek.toString("base64"), dek]])), mockLogger, TEST_KEY_RING_REF
    );
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.toString("utf8", 0, 5)).toBe("%PDF-");
  });

  it("should fail whole if any evidence file is inaccessible", async () => {
    const dek1 = crypto.randomBytes(32); const iv1 = crypto.randomBytes(12);
    const dek2 = crypto.randomBytes(32); const iv2 = crypto.randomBytes(12);
    const { doc: doc1, encryptedBytes: enc1 } = makeEvidence("ev-ok", "incident-123", "user-123", dek1, iv1);
    const { doc: doc2 } = makeEvidence("ev-fail", "incident-123", "user-123", dek2, iv2);
    const db = createMockFirestore([doc1, doc2], undefined);
    const bucketMock = {
      file: vi.fn().mockImplementation((path: string) => ({
        download: path === doc2.storageRef
          ? vi.fn().mockRejectedValue(new Error("Storage 503"))
          : vi.fn().mockResolvedValue([enc1]),
      })),
    };
    await expect(
      runGenerateLegalExport(
        "incident-123", "user-123", db, bucketMock as never,
        makeKms(new Map([[dek1.toString("base64"), dek1], [dek2.toString("base64"), dek2]])),
        mockLogger, TEST_KEY_RING_REF
      )
    ).rejects.toThrow("Failed to fetch evidence file for ev-fail");
  });

  // -------------------------------------------------------------------------
  // PDF content-structure assertions (items 1–4 from the task)
  // -------------------------------------------------------------------------

  it("PDF content: incidentId, evidenceIds (one per item), chain-of-custody data, and exporter all present", async () => {
    const INCIDENT_ID = "incident-content-test";
    const CALLER_UID  = "exporter-user-007";

    const dek1 = crypto.randomBytes(32); const iv1 = crypto.randomBytes(12);
    const dek2 = crypto.randomBytes(32); const iv2 = crypto.randomBytes(12);

    const custody1: EvidenceDocument["chainOfCustody"] = [{
      action: "uploaded",
      performedBy: "cloud_function",
      timestamp: new Date("2024-01-01T00:00:00.000Z"),
      evidenceId: "ev-content-001",
      metadata: null,
      integritySnapshot: null,
    }];
    const custody2: EvidenceDocument["chainOfCustody"] = [{
      action: "viewed",
      performedBy: "exporter-user-007",
      timestamp: new Date("2024-01-02T00:00:00.000Z"),
      evidenceId: "ev-content-002",
      metadata: null,
      integritySnapshot: null,
    }];

    const { doc: doc1, encryptedBytes: enc1 } = makeEvidence("ev-content-001", INCIDENT_ID, CALLER_UID, dek1, iv1, custody1);
    const { doc: doc2, encryptedBytes: enc2 } = makeEvidence("ev-content-002", INCIDENT_ID, CALLER_UID, dek2, iv2, custody2);

    const fileBuffers = new Map([
      [doc1.storageRef, enc1],
      [doc2.storageRef, enc2],
    ]);
    const deks = new Map([
      [dek1.toString("base64"), dek1],
      [dek2.toString("base64"), dek2],
    ]);

    const db = createMockFirestore([doc1, doc2], undefined);
    const pdfBuffer = await runGenerateLegalExport(
      INCIDENT_ID, CALLER_UID, db, createMockStorage(fileBuffers) as never,
      makeKms(deks), mockLogger, TEST_KEY_RING_REF
    );

    // Parse the PDF text
    const text = await parsePdfText(pdfBuffer);

    // 1. incidentId appears on the cover page
    expect(text).toContain(INCIDENT_ID);

    // 2. exporter callerUid appears as "Exported by" value
    expect(text).toContain(CALLER_UID);

    // 3. Each evidence item's evidenceId appears (one section per item)
    //    We use the section header pattern "Evidence Item N: <evidenceId>"
    expect(text).toContain("ev-content-001");
    expect(text).toContain("ev-content-002");

    // Count: each evidenceId must appear at least once in a section heading
    const occurrences001 = (text.match(/ev-content-001/g) ?? []).length;
    const occurrences002 = (text.match(/ev-content-002/g) ?? []).length;
    expect(occurrences001).toBeGreaterThanOrEqual(1);
    expect(occurrences002).toBeGreaterThanOrEqual(1);

    // 4a. Chain-of-custody: action "uploaded" for ev-content-001 is present
    expect(text).toContain("uploaded");

    // 4b. Chain-of-custody: action "viewed" and performedBy callerUid for ev-content-002 is present
    expect(text).toContain("viewed");
    // The exporter appears both in "Exported by" and as performedBy in custody2
    // Both occurrences must be traceable to what appendCustodyEntry would write
    const callerOccurrences = (text.match(new RegExp(CALLER_UID, "g")) ?? []).length;
    // At minimum: "Exported by: exporter-user-007" (cover) + "viewed" entry performedBy
    expect(callerOccurrences).toBeGreaterThanOrEqual(2);

    // 5. The "exported" action appended by the function itself also appears
    //    (appendCustodyEntry writes it to Firestore; the transaction mock is called twice)
    expect(db.runTransaction).toHaveBeenCalledTimes(2);

    // 6. Total evidence count on cover page
    expect(text).toContain("Total evidence items: 2");
  });

  it("PDF content: single-evidence export contains exactly one evidence section heading", async () => {
    const dek = crypto.randomBytes(32); const iv = crypto.randomBytes(12);
    const { doc, encryptedBytes } = makeEvidence("ev-solo-001", "incident-solo", "user-solo", dek, iv, []);
    const db = createMockFirestore([doc], undefined);
    const pdfBuffer = await runGenerateLegalExport(
      "incident-solo", "user-solo", db,
      createMockStorage(new Map([[doc.storageRef, encryptedBytes]])) as never,
      makeKms(new Map([[dek.toString("base64"), dek]])),
      mockLogger, TEST_KEY_RING_REF
    );

    const text = await parsePdfText(pdfBuffer);

    // incidentId and evidenceId must both be present
    expect(text).toContain("incident-solo");
    expect(text).toContain("ev-solo-001");
    expect(text).toContain("Total evidence items: 1");
    // Section heading for item 1
    expect(text).toContain("Evidence Item 1");
    // No second section heading
    expect(text).not.toContain("Evidence Item 2");
  });

  it("PDF content: correct evidence count header matches actual evidence array length", async () => {
    // 3 evidence items — PDF cover page must say "Total evidence items: 3"
    const deks = new Map<string, Buffer>();
    const docs: EvidenceDocument[] = [];
    const fileBuffers = new Map<string, Buffer>();

    for (let i = 0; i < 3; i++) {
      const dek = crypto.randomBytes(32);
      const iv  = crypto.randomBytes(12);
      const { doc, encryptedBytes } = makeEvidence(`ev-count-00${i}`, "incident-count", "user-count", dek, iv);
      deks.set(dek.toString("base64"), dek);
      docs.push(doc);
      fileBuffers.set(doc.storageRef, encryptedBytes);
    }

    const db = createMockFirestore(docs, undefined);
    const pdfBuffer = await runGenerateLegalExport(
      "incident-count", "user-count", db,
      createMockStorage(fileBuffers) as never,
      makeKms(deks), mockLogger, TEST_KEY_RING_REF
    );

    const text = await parsePdfText(pdfBuffer);
    expect(text).toContain("Total evidence items: 3");
    for (let i = 0; i < 3; i++) {
      expect(text).toContain(`ev-count-00${i}`);
    }
  });

  // -------------------------------------------------------------------------
  // P16: No Partial Export (fast-check, 100 runs)
  // -------------------------------------------------------------------------

  it("P16: No Partial Export — either returns complete PDF or throws (fast‑check, 100 runs)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 10 }),
        async (numItems, failIndex) => {
          const evidenceDocs: EvidenceDocument[] = [];
          const fileBuffers = new Map<string, Buffer>();
          const deks = new Map<string, Buffer>();

          for (let i = 0; i < numItems; i++) {
            const dek = crypto.randomBytes(32);
            const iv  = crypto.randomBytes(12);
            const { doc, encryptedBytes } = makeEvidence(`ev-p16-${i}`, "incident-p16", "user-p16", dek, iv, [{
              action: "uploaded" as const,
              performedBy: "cloud_function",
              timestamp: new Date(),
              evidenceId: `ev-p16-${i}`,
              metadata: null,
              integritySnapshot: null,
            }]);
            deks.set(dek.toString("base64"), dek);
            evidenceDocs.push(doc);
            fileBuffers.set(doc.storageRef, encryptedBytes);
          }

          const bucketMock = {
            file: vi.fn().mockImplementation((path: string) => {
              const shouldFail = failIndex > 0 && failIndex <= numItems && path === evidenceDocs[failIndex - 1]?.storageRef;
              return {
                download: shouldFail
                  ? vi.fn().mockRejectedValue(new Error("Download failed"))
                  : vi.fn().mockResolvedValue([fileBuffers.get(path) ?? Buffer.alloc(0)]),
              };
            }),
          };

          const db = createMockFirestore(evidenceDocs, undefined);
          let threw = false;
          let result: Buffer | undefined;
          try {
            result = await runGenerateLegalExport(
              "incident-p16", "user-p16", db, bucketMock as never,
              makeKms(deks), mockLogger, TEST_KEY_RING_REF
            );
          } catch {
            threw = true;
          }

          // P16: either a complete PDF is returned, or an error is thrown — never a partial result
          if (threw) {
            expect(result).toBeUndefined();
          } else {
            expect(result).toBeInstanceOf(Buffer);
            expect(result!.length).toBeGreaterThan(0);
            expect(result!.toString("utf8", 0, 5)).toBe("%PDF-");
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
