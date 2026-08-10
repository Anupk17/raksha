/**
 * evidenceAdapters — real Firebase SDK adapter factories for captureEvidence.
 *
 * The captureEvidence orchestrator accepts injected adapters so it can run
 * in both browser and test environments. These factories produce the real
 * Firebase SDK implementations for use in the browser.
 *
 * StorageAdapter uses uploadBytesResumable so the progress callback fires
 * during upload, allowing EvidenceCaptureScreen to show a live progress bar.
 *
 * Design: §Shared Utilities — evidenceAdapters.ts
 */
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { ref, uploadBytesResumable } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { db, storage, fns } from '../firebase';
import type { FirestoreAdapter, StorageAdapter, FunctionsAdapter } from '../lib/evidence/captureEvidence';

export type UploadProgressCallback = (transferred: number, total: number) => void;

// ---------------------------------------------------------------------------
// Firestore adapter
// ---------------------------------------------------------------------------

export function makeFirestoreAdapter(): FirestoreAdapter {
  return {
    async createDocument(evidenceId, docData) {
      await setDoc(doc(db, 'evidence', evidenceId), docData);
    },

    async getDocument(evidenceId) {
      try {
        const snap = await getDoc(doc(db, 'evidence', evidenceId));
        return snap.exists() ? snap.data() : null;
      } catch (err) {
        // Firestore returns permission-denied when the document does not exist
        // and the security rule references resource.data (null for missing docs).
        // Treat this as "document not found" — the fresh-upload branch handles it.
        const code = (err as { code?: string }).code ?? '';
        if (code === 'permission-denied') return null;
        throw err;
      }
    },

    async getDocumentWithRetry(evidenceId, retries) {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await this.getDocument(evidenceId);
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    },
  };
}

// ---------------------------------------------------------------------------
// Storage adapter
// ---------------------------------------------------------------------------

export function makeStorageAdapter(onProgress?: UploadProgressCallback): StorageAdapter {
  return {
    upload(storageRef, data, mimeType) {
      return new Promise<void>((resolve, reject) => {
        const fileRef = ref(storage, storageRef);
        const task = uploadBytesResumable(fileRef, data, { contentType: mimeType });
        task.on(
          'state_changed',
          (snap) => onProgress?.(snap.bytesTransferred, snap.totalBytes),
          reject,
          resolve,
        );
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Functions adapter
// ---------------------------------------------------------------------------

export function makeFunctionsAdapter(): FunctionsAdapter {
  return {
    async call(name, data) {
      const fn = httpsCallable<Record<string, unknown>, Record<string, unknown>>(fns, name);
      const result = await fn(data);
      return result.data;
    },
  };
}
