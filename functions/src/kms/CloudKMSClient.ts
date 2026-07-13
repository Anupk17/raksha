/**
 * CloudKMSClient — production implementation of KMSClient using Google Cloud KMS.
 *
 * This class is NEVER instantiated in test or emulator environments.
 * createKMSClient() returns KMSMock instead when FUNCTIONS_EMULATOR or
 * NODE_ENV=test is detected.
 *
 * Envelope encryption pattern:
 *   1. Generate a random 256-bit DEK locally.
 *   2. Encrypt the DEK using the Cloud KMS key ring (KMS wraps the DEK).
 *   3. Store the KMS-encrypted DEK (encryptedDEK) on the evidence document.
 *   4. Use the plaintext DEK for AES-256-GCM encryption of the file bytes,
 *      then zero the plaintext DEK from memory.
 *
 * Requirements: 4.1, 4.2, 4.3
 * Design: §KMS Encryption Interface — Real Implementation
 */
import crypto from "crypto";
import type { KMSClient } from "./kms.interface.js";

export class CloudKMSClient implements KMSClient {
  async generateDataEncryptionKey(keyRingRef: string): Promise<{
    encryptedDEK: string;
    plaintextDEK: Buffer;
    iv: Buffer;
  }> {
    // Lazy import to avoid loading @google-cloud/kms in test environments.
    // createKMSClient() prevents this class from being instantiated in tests,
    // but the lazy import adds a second layer of protection.
    const { KeyManagementServiceClient } = await import("@google-cloud/kms");
    const client = new KeyManagementServiceClient();

    const plaintextDEK = crypto.randomBytes(32); // 256-bit DEK
    const iv = crypto.randomBytes(12); // 96-bit IV (NIST SP 800-38D)

    // Encrypt the DEK with Cloud KMS
    const [encryptResponse] = await client.encrypt({
      name: keyRingRef,
      plaintext: plaintextDEK,
    });

    if (!encryptResponse.ciphertext) {
      throw new Error(
        `CloudKMSClient: KMS encrypt returned empty ciphertext for key ${keyRingRef}`
      );
    }

    const ciphertextBytes =
      encryptResponse.ciphertext instanceof Uint8Array
        ? encryptResponse.ciphertext
        : Buffer.from(encryptResponse.ciphertext as string, "base64");

    const encryptedDEK = Buffer.from(ciphertextBytes).toString("base64");

    return { encryptedDEK, plaintextDEK, iv };
  }

  async decryptDataEncryptionKey(
    encryptedDEK: string,
    keyRingRef: string
  ): Promise<Buffer> {
    const { KeyManagementServiceClient } = await import("@google-cloud/kms");
    const client = new KeyManagementServiceClient();

    const ciphertext = Buffer.from(encryptedDEK, "base64");

    const [decryptResponse] = await client.decrypt({
      name: keyRingRef,
      ciphertext,
    });

    if (!decryptResponse.plaintext) {
      throw new Error(
        `CloudKMSClient: KMS decrypt returned empty plaintext for key ${keyRingRef}`
      );
    }

    return Buffer.from(decryptResponse.plaintext as Uint8Array);
  }
}
