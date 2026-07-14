/**
 * generateLegalExport — HTTPS callable Cloud Function.
 *
 * Assembles a court-ready PDF evidence package for a given incidentId.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
 * Design: §generateLegalExport Function Design
 */
import type { Firestore } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";
import type { KMSClient } from "../kms/kms.interface.js";
// @ts-ignore: pdfkit is added to dependencies
import PDFDocument from "pdfkit";
import { appendCustodyEntry } from "../utils/appendCustodyEntry.js";
import { deserializeFirestoreDate } from "../utils/assertDate.js";
import { aesGcmDecrypt } from "../utils/aesGcm.js";
import type { ChainOfCustodyEntry, EvidenceDocument } from "../types/evidence.js";
import type { PipelineLogger } from "./onEvidenceCreate/pipeline.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateLegalExportRequest {
  incidentId: string;
}

export interface ProcessedEvidence {
  doc: EvidenceDocument;
  decryptedBytes: Buffer;
}

// ---------------------------------------------------------------------------
// Core Logic (exported for testing)
// ---------------------------------------------------------------------------

export async function runGenerateLegalExport(
  incidentId: string,
  callerUid: string,
  db: Firestore,
  bucket: ReturnType<Storage["bucket"]>,
  kms: KMSClient,
  logger: PipelineLogger,
  keyRingRef: string
): Promise<Buffer> {
  // 1. Upfront auth check
  if (!callerUid) {
    throw Object.assign(new Error("Unauthenticated"), { code: "UNAUTHENTICATED" });
  }

  // 2. Query evidence for incident
  const evidenceQuery = await db.collection("evidence").where("incidentId", "==", incidentId).get();
  const evidenceDocs = evidenceQuery.docs;

  // 3. Zero-evidence check
  if (evidenceDocs.length === 0) {
    throw Object.assign(new Error("No evidence found for incident"), { code: "NOT_FOUND" });
  }

  // 4. Verify authorization (owner or active granted contact for any evidence item)
  const firstDocData = evidenceDocs[0].data() as Record<string, unknown>;
  const ownerUid = firstDocData["userId"] as string;
  const isOwner = callerUid === ownerUid;
  let isGrantedContact = false;
  if (!isOwner) {
    const contactSnap = await db
      .collection("grantedContacts")
      .doc(ownerUid)
      .collection("contacts")
      .doc(callerUid)
      .get();
    isGrantedContact = contactSnap.exists && contactSnap.data()?.["revoked"] !== true;
  }
  if (!isOwner && !isGrantedContact) {
    throw Object.assign(new Error("Permission denied"), { code: "PERMISSION_DENIED" });
  }

  // 5. Fail-whole processing: process each evidence item
  const processedEvidence: ProcessedEvidence[] = [];
  for (const docSnap of evidenceDocs) {
    const docData = docSnap.data() as Record<string, unknown>;
    // Deserialize timestamps
    const createdAt = deserializeFirestoreDate(docData["createdAt"], "createdAt");
    const rawMetadata = docData["metadata"] as Record<string, unknown> | undefined;
    const capturedAt = deserializeFirestoreDate(rawMetadata?.["capturedAt"], "metadata.capturedAt");
    // Deserialize chainOfCustody entry timestamps — Firestore returns these as Timestamp objects
    const rawChainOfCustody = (docData["chainOfCustody"] ?? []) as Array<Record<string, unknown>>;
    const chainOfCustody: ChainOfCustodyEntry[] = rawChainOfCustody.map((entry, idx) => ({
      ...(entry as unknown as ChainOfCustodyEntry),
      timestamp: deserializeFirestoreDate(entry["timestamp"], `chainOfCustody[${idx}].timestamp`),
    }));
    const doc = {
      ...(docData as unknown as EvidenceDocument),
      createdAt,
      chainOfCustody,
      metadata: {
        ...(rawMetadata as any),
        capturedAt
      }
    };

    // Fetch encrypted file
    let encryptedBytes: Buffer;
    try {
      const [fileBuffer] = await bucket.file(doc.storageRef).download();
      encryptedBytes = fileBuffer;
    } catch (err) {
      logger.error(`Failed to fetch file for evidence ${doc.evidenceId}: ${(err as Error).message}`);
      throw Object.assign(new Error(`Failed to fetch evidence file for ${doc.evidenceId}`), { code: "INTERNAL" });
    }

    // Decrypt DEK
    let plaintextDEK: Buffer;
    try {
      plaintextDEK = await kms.decryptDataEncryptionKey(doc.encryptionKeyRef, keyRingRef);
    } catch (err) {
      logger.error(`Failed to decrypt DEK for evidence ${doc.evidenceId}: ${(err as Error).message}`);
      throw Object.assign(new Error(`Failed to decrypt DEK for ${doc.evidenceId}`), { code: "INTERNAL" });
    }

    // Decrypt file
    let decryptedBytes: Buffer;
    try {
      const iv = Buffer.from(doc.encryptionIV, "base64");
      decryptedBytes = aesGcmDecrypt(encryptedBytes, plaintextDEK, iv);
    } catch (err) {
      logger.error(`Failed to decrypt file for evidence ${doc.evidenceId}: ${(err as Error).message}`);
      throw Object.assign(new Error(`Failed to decrypt evidence file for ${doc.evidenceId}`), { code: "INTERNAL" });
    }

    processedEvidence.push({ doc, decryptedBytes });
  }

  // 6. Generate PDF
  const pdfBuffer = await generatePdf(incidentId, callerUid, processedEvidence, logger);

  // 7. Append "exported" custody entries
  await Promise.all(
    processedEvidence.map(async ({ doc }) => {
      await db.runTransaction(async (tx) => {
        const entry: ChainOfCustodyEntry = {
          action: "exported",
          performedBy: callerUid,
          timestamp: new Date(),
          evidenceId: doc.evidenceId,
          metadata: { incidentId },
          integritySnapshot: null
        };
        await appendCustodyEntry(tx, db.collection("evidence").doc(doc.evidenceId), entry);
      });
    })
  );

  return pdfBuffer;
}

// ---------------------------------------------------------------------------
// PDF Generation Helper
// ---------------------------------------------------------------------------

async function generatePdf(
  incidentId: string,
  callerUid: string,
  processedEvidence: ProcessedEvidence[],
  logger: PipelineLogger
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Cover Page
    doc.fontSize(24).text("RAKSHA Evidence Export", { align: "center" }).moveDown();
    doc.fontSize(16).text(`Incident ID: ${incidentId}`, { align: "center" }).moveDown();
    doc.fontSize(12).text(`Exported by: ${callerUid}`, { align: "center" }).moveDown();
    doc.fontSize(12).text(`Exported at: ${new Date().toISOString()}`, { align: "center" }).moveDown();
    doc.fontSize(12).text(`Total evidence items: ${processedEvidence.length}`, { align: "center" }).moveDown(2);

    for (let i = 0; i < processedEvidence.length; i++) {
      const { doc: evidenceDoc, decryptedBytes } = processedEvidence[i];
      doc.addPage();
      doc.fontSize(18).text(`Evidence Item ${i + 1}: ${evidenceDoc.evidenceId}`).moveDown();

      // Metadata section
      doc.fontSize(14).text("Metadata").moveDown();
      doc.fontSize(12)
         .text(`Type: ${evidenceDoc.type}`)
         .text(`Original filename: ${evidenceDoc.originalFilename}`)
         .text(`MIME type: ${evidenceDoc.mimeType}`)
         .text(`Size (bytes): ${evidenceDoc.sizeBytes}`)
         .text(`SHA-256 hash: ${evidenceDoc.sha256Hash}`)
         .text(`Status: ${evidenceDoc.status}`)
         .text(`Captured at: ${evidenceDoc.metadata.capturedAt.toISOString()}`)
         .text(`Device info: ${evidenceDoc.metadata.deviceInfo}`)
         .text(`Location hash: ${evidenceDoc.metadata.locationHash ?? "N/A"}`)
         .text(`Incident context: ${evidenceDoc.metadata.incidentContext ?? "N/A"}`).moveDown();

      // Retention info if expired
      if (evidenceDoc.status === "expired" && evidenceDoc.retentionExpiresAt) {
        doc.fontSize(12).text(`Note: This evidence has passed its retention period. Retention expired: ${evidenceDoc.retentionExpiresAt.toISOString()}`).moveDown();
      }

      // Embed or reference evidence
      if (["photo", "screenshot", "document"].includes(evidenceDoc.type)) {
        if (["photo", "screenshot"].includes(evidenceDoc.type)) {
          // Embed image
          try {
            doc.image(decryptedBytes, { fit: [500, 500], align: "center" }).moveDown();
          } catch (err) {
            logger.warn(`Failed to embed image for ${evidenceDoc.evidenceId}: ${(err as Error).message}`);
            doc.fontSize(12).text(`[Image could not be embedded — ${evidenceDoc.sizeBytes} bytes, sha256: ${evidenceDoc.sha256Hash}]`).moveDown();
          }
        } else {
          // Document: reference by hash — cannot attach raw buffers via pdfkit in Cloud Functions
          doc.fontSize(12).text(`Document: ${evidenceDoc.originalFilename}`).moveDown();
          doc.fontSize(12).text(`SHA-256: ${evidenceDoc.sha256Hash}`).moveDown();
          doc.fontSize(12).text(`Size: ${evidenceDoc.sizeBytes} bytes`).moveDown();
        }
      } else {
        // Audio/video: reference with hash
        doc.fontSize(12).text(`[${evidenceDoc.type} evidence — ${evidenceDoc.originalFilename}]`).moveDown();
        doc.fontSize(12).text(`SHA-256: ${evidenceDoc.sha256Hash}`).moveDown();
        doc.fontSize(12).text(`Size: ${evidenceDoc.sizeBytes} bytes`).moveDown();
      }

      // Chain of Custody section
      doc.addPage();
      doc.fontSize(14).text("Chain of Custody").moveDown();
      doc.fontSize(10);
      const headers = ["Action", "Performed By", "Timestamp", "Integrity Snapshot"];
      const colWidths = [100, 150, 200, 200];
      let y = doc.y;
      // Draw header row
      headers.forEach((header, i) => {
        doc.text(header, 50 + (i > 0 ? colWidths.slice(0, i).reduce((a, b) => a + b, 0) : 0), y, { width: colWidths[i] });
      });
      y += 20;
      // Draw each custody entry
      for (const entry of evidenceDoc.chainOfCustody) {
        doc.text(entry.action, 50, y, { width: colWidths[0] });
        doc.text(entry.performedBy, 50 + colWidths[0], y, { width: colWidths[1] });
        doc.text(entry.timestamp.toISOString(), 50 + colWidths[0] + colWidths[1], y, { width: colWidths[2] });
        doc.text(entry.integritySnapshot ?? "N/A", 50 + colWidths[0] + colWidths[1] + colWidths[2], y, { width: colWidths[3] });
        y += 20;
        if (y > 700) {
          doc.addPage();
          y = 50;
        }
      }
    }

    doc.end();
  });
}

// ---------------------------------------------------------------------------
// Firebase Functions Registration
// ---------------------------------------------------------------------------

export function createGenerateLegalExportHandler(
  db: Firestore,
  bucket: ReturnType<Storage["bucket"]>,
  kms: KMSClient,
  logger: PipelineLogger,
  keyRingRef: string
) {
  return async (
    data: GenerateLegalExportRequest,
    context: { auth?: { uid: string } }
  ): Promise<{ pdf: string }> => {
    const pdfBuffer = await runGenerateLegalExport(
      data.incidentId,
      context.auth?.uid ?? "",
      db,
      bucket,
      kms,
      logger,
      keyRingRef
    );
    return { pdf: pdfBuffer.toString("base64") };
  };
}
