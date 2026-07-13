/**
 * Injectable KMS client interface.
 *
 * All Cloud Functions that need to encrypt or decrypt evidence files use this
 * interface, never the concrete implementations directly. This allows the
 * Firebase Emulator Suite (which does NOT emulate Cloud KMS) to swap in
 * KMSMock via createKMSClient().
 *
 * Requirements: 4.3, 4.4, 4.5
 * Design: §KMS Encryption Interface
 */
export interface KMSClient {
  /**
   * Generates a new Data Encryption Key (DEK) under the given KMS key ring.
   *
   * Returns:
   *   encryptedDEK  — the DEK encrypted by Cloud KMS, base64-encoded; store
   *                   this on the evidence document as encryptionKeyRef.
   *   plaintextDEK  — raw 256-bit DEK bytes for immediate use; zero after use,
   *                   never persist.
   *   iv            — random 96-bit (12-byte) AES-GCM IV, per NIST SP 800-38D.
   *                   Encoded as base64 it produces a 16-character string,
   *                   stored as encryptionIV on the evidence document.
   */
  generateDataEncryptionKey(keyRingRef: string): Promise<{
    encryptedDEK: string;
    plaintextDEK: Buffer;
    iv: Buffer;
  }>;

  /**
   * Decrypts an encrypted DEK using the Cloud KMS key ring, returning the
   * plaintext 256-bit DEK bytes for decryption.
   */
  decryptDataEncryptionKey(
    encryptedDEK: string,
    keyRingRef: string
  ): Promise<Buffer>;
}
