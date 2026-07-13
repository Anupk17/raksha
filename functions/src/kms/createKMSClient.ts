/**
 * Factory function that returns the correct KMSClient for the current environment.
 *
 * Returns KMSMock when:
 *   - process.env.FUNCTIONS_EMULATOR === 'true'  (Firebase Emulator Suite)
 *   - process.env.NODE_ENV === 'test'             (vitest / jest)
 *
 * Returns CloudKMSClient in all other environments (production, staging).
 *
 * The real Cloud KMS API is NEVER called from test or emulator environments.
 * This is a hard requirement (Req 4.4) — the Firebase Emulator Suite does not
 * emulate Cloud KMS, and calling the real API from tests would be both
 * expensive and a security risk.
 *
 * USAGE: Call createKMSClient() once at Cloud Function initialization time
 * (module scope), not per-request. This ensures the mock is a stable singleton
 * within a test run and plaintext DEKs generated during generateDataEncryptionKey
 * are still retrievable when decryptDataEncryptionKey is called later.
 *
 * Requirements: 4.3, 4.4, 4.5
 * Design: §KMS Encryption Interface — Injection Mechanism
 */
import type { KMSClient } from "./kms.interface.js";
import { KMSMock } from "./KMSMock.js";
import { CloudKMSClient } from "./CloudKMSClient.js";

export function createKMSClient(): KMSClient {
  if (
    process.env["FUNCTIONS_EMULATOR"] === "true" ||
    process.env["NODE_ENV"] === "test"
  ) {
    return new KMSMock();
  }
  return new CloudKMSClient();
}
