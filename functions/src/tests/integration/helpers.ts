/**
 * Shared helpers for Firebase Emulator integration tests.
 *
 * Uses @firebase/rules-unit-testing to initialise a clean Firestore environment
 * against the running Emulator. Each test suite gets its own project ID to
 * guarantee full isolation.
 *
 * IMPORTANT: The Firebase Emulator must be running before these tests execute:
 *   firebase emulators:start --only firestore,storage --project raksha-test
 *
 * Requirement: Java 21+ (firebase-tools >= 13 dropped support for Java < 21).
 */
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "fs";
import { resolve } from "path";
import { initializeApp, getApps } from "firebase-admin/app";
import type { App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage, type Storage } from "firebase-admin/storage";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Emulator connection constants
// ---------------------------------------------------------------------------
export const EMULATOR_PROJECT_ID = "raksha-test";
export const FIRESTORE_EMULATOR_HOST = "localhost:8080";
export const STORAGE_EMULATOR_HOST = "localhost:9199";
export const KEY_RING_REF = "projects/test/keyRings/test/cryptoKeys/evidence";

// ---------------------------------------------------------------------------
// Rules-testing environment (for security rule assertions)
// ---------------------------------------------------------------------------

let testEnv: RulesTestEnvironment | null = null;

export async function getTestEnv(): Promise<RulesTestEnvironment> {
  if (testEnv) return testEnv;

  const firestoreRules = readFileSync(
    resolve(process.cwd(), "../firestore.rules"),
    "utf8"
  );

  testEnv = await initializeTestEnvironment({
    projectId: EMULATOR_PROJECT_ID,
    firestore: {
      rules: firestoreRules,
      host: "localhost",
      port: 8080,
    },
  });

  return testEnv;
}

export async function cleanupTestEnv(): Promise<void> {
  if (testEnv) {
    await testEnv.cleanup();
    testEnv = null;
  }
}

// ---------------------------------------------------------------------------
// Admin SDK (bypasses security rules — for setup and assertion)
// ---------------------------------------------------------------------------

interface GlobalAdminState {
  _adminApp?: App;
  _adminFirestore?: Firestore;
}

const globalState = globalThis as unknown as GlobalAdminState;

export function getAdminApp(): App {
  if (globalState._adminApp) return globalState._adminApp;

  // Point Admin SDK at the Emulator — must be set before any Firestore call
  process.env["FIRESTORE_EMULATOR_HOST"] = FIRESTORE_EMULATOR_HOST;
  process.env["FIREBASE_STORAGE_EMULATOR_HOST"] = STORAGE_EMULATOR_HOST;

  if (getApps().length === 0) {
    globalState._adminApp = initializeApp({
      projectId: EMULATOR_PROJECT_ID,
      storageBucket: `${EMULATOR_PROJECT_ID}.appspot.com`,
    });
  } else {
    globalState._adminApp = getApps()[0]!;
  }
  return globalState._adminApp;
}

export function getAdminFirestore(): Firestore {
  if (globalState._adminFirestore) return globalState._adminFirestore;

  globalState._adminFirestore = getFirestore(getAdminApp());
  // settings() may only be called once per Firestore instance
  globalState._adminFirestore.settings({ host: FIRESTORE_EMULATOR_HOST, ssl: false });
  return globalState._adminFirestore;
}

export function getAdminStorage(): Storage {
  return getStorage(getAdminApp());
}

// ---------------------------------------------------------------------------
// Test document factories
// ---------------------------------------------------------------------------

export function sha256hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function makeEvidenceDoc(
  evidenceId: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  const now = new Date();
  return {
    evidenceId,
    incidentId: "inc-001",
    userId: "user-001",
    type: "photo",
    storageRef: `evidence/${evidenceId}/photo.jpg`,
    originalFilename: "photo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    sha256Hash: sha256hex(Buffer.from("test file content")),
    encryptionKeyRef: "",
    encryptionIV: "",
    status: "uploading",
    retentionExpiresAt: null,
    legalHoldReason: null,
    chainOfCustody: [],
    createdAt: now,
    updatedAt: now,
    metadata: {
      capturedAt: now,
      deviceInfo: "integration-test",
      locationHash: null,
      incidentContext: null,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Emulator data cleanup
// ---------------------------------------------------------------------------

export async function clearFirestore(): Promise<void> {
  const env = await getTestEnv();
  await env.clearFirestore();
}

export async function clearStorage(): Promise<void> {
  // Use Admin SDK to delete all files in the test bucket
  const storage = getAdminStorage();
  const bucket = storage.bucket(`${EMULATOR_PROJECT_ID}.appspot.com`);
  try {
    const [files] = await bucket.getFiles({ prefix: "evidence/" });
    await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true })));
  } catch {
    // Storage may not have any files — that's fine
  }
}

// ---------------------------------------------------------------------------
// Upload a test file to Storage (mimics what the client does)
// ---------------------------------------------------------------------------

export async function uploadTestFile(
  evidenceId: string,
  content: Buffer
): Promise<void> {
  const storage = getAdminStorage();
  const bucket = storage.bucket(`${EMULATOR_PROJECT_ID}.appspot.com`);
  const file = bucket.file(`evidence/${evidenceId}/photo.jpg`);
  await file.save(content, { contentType: "image/jpeg" });
}
