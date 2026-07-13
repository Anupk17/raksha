/**
 * AES-256-GCM encryption and decryption utilities.
 *
 * Used by onEvidenceCreate to encrypt file bytes before storing them in
 * Firebase Storage, and by serveEvidenceFile / generateLegalExport to
 * decrypt them before serving or exporting.
 *
 * AES-256-GCM was chosen because it provides both confidentiality and
 * authenticated integrity (via the GCM authentication tag). The auth tag
 * means any tampering of the ciphertext is detected at decrypt time —
 * aesGcmDecrypt throws if the tag does not match, rather than silently
 * returning corrupted plaintext.
 *
 * Key requirements:
 *   - key:  256 bits (32 bytes)  — from KMS-generated DEK
 *   - iv:    96 bits (12 bytes)  — NIST SP 800-38D recommended size for GCM.
 *                                  With a 96-bit IV the counter block is formed
 *                                  directly (IV ∥ 0x00000001), avoiding the
 *                                  GHASH pre-processing required for other sizes.
 *                                  Generated fresh via crypto.randomBytes(12)
 *                                  per encryption call — never reused or derived.
 *   - tag:  128 bits (16 bytes)  — appended to the ciphertext by encrypt,
 *                                  read back and verified by decrypt
 *
 * Note on the spec: requirements.md Req 4.2 originally said "128-bit IV
 * encoded as a 24-char base64 string" (16 bytes). That was incorrect —
 * 16 bytes is the auth tag size, not the IV size. The spec has been corrected
 * to "96-bit IV encoded as a 16-char base64 string" (12 bytes → 16 base64 chars
 * with standard padding).
 *
 * Wire format stored in Firebase Storage:
 *   [ GCM_AUTH_TAG (16 bytes) | CIPHERTEXT (variable) ]
 *
 * Requirements: 4.1, 4.2 (4.6 in tasks.md)
 * Design: §onEvidenceCreate — Steps 6, 7 and §serveEvidenceFile — Step 6
 */
import crypto from "crypto";

const AUTH_TAG_LENGTH = 16; // bytes (128-bit GCM authentication tag)
const KEY_LENGTH = 32; // bytes (256-bit AES key)
const IV_LENGTH = 12; // bytes (96-bit GCM IV — NIST SP 800-38D recommended size)

/**
 * Encrypts plaintext bytes using AES-256-GCM.
 *
 * @param plaintext - Raw file bytes to encrypt.
 * @param key       - 256-bit (32-byte) AES key (plaintextDEK from KMS).
 * @param iv        - 96-bit (12-byte) initialization vector.
 * @returns Wire-format buffer: [ auth_tag (16) | ciphertext (n) ]
 * @throws TypeError if key or IV are wrong length.
 */
export function aesGcmEncrypt(
  plaintext: Buffer,
  key: Buffer,
  iv: Buffer
): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new TypeError(
      `aesGcmEncrypt: key must be ${KEY_LENGTH} bytes (got ${key.length})`
    );
  }
  if (iv.length !== IV_LENGTH) {
    throw new TypeError(
      `aesGcmEncrypt: iv must be ${IV_LENGTH} bytes (got ${iv.length})`
    );
  }

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.alloc(0)); // no additional authenticated data for evidence files

  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag(); // always 16 bytes for GCM

  // Prepend the auth tag so decrypt can locate it without a separate field.
  return Buffer.concat([tag, encrypted]);
}

/**
 * Decrypts AES-256-GCM ciphertext produced by aesGcmEncrypt.
 *
 * @param ciphertext - Wire-format buffer: [ auth_tag (16) | ciphertext (n) ]
 * @param key        - 256-bit (32-byte) AES key.
 * @param iv         - 96-bit (12-byte) initialization vector.
 * @returns Decrypted plaintext bytes.
 * @throws Error if the authentication tag does not match (tampering detected).
 * @throws TypeError if key, IV, or ciphertext length is invalid.
 */
export function aesGcmDecrypt(
  ciphertext: Buffer,
  key: Buffer,
  iv: Buffer
): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new TypeError(
      `aesGcmDecrypt: key must be ${KEY_LENGTH} bytes (got ${key.length})`
    );
  }
  if (iv.length !== IV_LENGTH) {
    throw new TypeError(
      `aesGcmDecrypt: iv must be ${IV_LENGTH} bytes (got ${iv.length})`
    );
  }
  if (ciphertext.length < AUTH_TAG_LENGTH) {
    throw new TypeError(
      `aesGcmDecrypt: ciphertext too short to contain auth tag ` +
        `(need ≥ ${AUTH_TAG_LENGTH} bytes, got ${ciphertext.length})`
    );
  }

  const tag = ciphertext.subarray(0, AUTH_TAG_LENGTH);
  const encrypted = ciphertext.subarray(AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.alloc(0));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    // Node.js throws when the auth tag verification fails. Re-throw with a
    // clear message so callers know to reject the file as tampered.
    throw new Error(
      "aesGcmDecrypt: authentication tag verification failed — " +
        "ciphertext may have been tampered with"
    );
  }
}
