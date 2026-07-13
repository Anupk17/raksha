/**
 * KMSMock — test/emulator substitute for the real Cloud KMS client.
 *
 * Used automatically when:
 *   - process.env.FUNCTIONS_EMULATOR === 'true'  (Firebase Emulator Suite)
 *   - process.env.NODE_ENV === 'test'             (vitest / jest)
 *
 * No external calls. Uses Node.js crypto.randomBytes for key and IV
 * generation, and stores the plaintext DEK in-memory for decryption.
 *
 * Requirements: 4.3, 4.4
 * Design: §KMS Encryption Interface — Mock Implementation
 */
import crypto from "crypto";
import type { KMSClient } from "./kms.interface.js";

export class KMSMock implements KMSClient {
  /**
   * Maps encryptedDEK (base64 string) → plaintext DEK Buffer.
   * Scoped per KMSMock instance so tests that create fresh instances
   * are fully isolated.
   */
  private readonly store = new Map<string, Buffer>();

  async generateDataEncryptionKey(_keyRingRef: string): Promise<{
    encryptedDEK: string;
    plaintextDEK: Buffer;
    iv: Buffer;
  }> {
    const plaintextDEK = crypto.randomBytes(32); // 256-bit AES key
    const iv = crypto.randomBytes(12); // 96-bit IV (NIST SP 800-38D recommended for GCM)

    // "Encrypt" by base64-encoding the plaintext — no real KMS call.
    // This is deliberately simple: the mock's job is testability, not security.
    const encryptedDEK = plaintextDEK.toString("base64");

    // Store so decryptDataEncryptionKey can recover it.
    this.store.set(encryptedDEK, Buffer.from(plaintextDEK));

    return { encryptedDEK, plaintextDEK, iv };
  }

  async decryptDataEncryptionKey(
    encryptedDEK: string,
    _keyRingRef: string
  ): Promise<Buffer> {
    const key = this.store.get(encryptedDEK);
    if (!key) {
      throw new Error(
        `KMSMock: unknown encryptedDEK "${encryptedDEK.slice(0, 16)}…" — ` +
          `was generateDataEncryptionKey called on this instance?`
      );
    }
    return Buffer.from(key); // return a copy, not the stored reference
  }

  /** Expose store size for assertions in tests. */
  get keyCount(): number {
    return this.store.size;
  }
}
