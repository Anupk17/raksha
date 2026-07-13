/**
 * Tests for AES-256-GCM encrypt/decrypt utilities.
 *
 * Core properties tested:
 *   - Round-trip: decrypt(encrypt(plaintext, k, iv), k, iv) === plaintext
 *   - Auth tag failure: any modification to ciphertext throws
 *   - Wrong key: decryption with different key throws
 *   - Wrong IV: decryption with different IV throws
 *   - Length validation: wrong key/IV lengths throw TypeError
 *
 * Feature: evidence-trail, Task 1.6: AES-GCM utilities
 * Requirements: 4.1, 4.2
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import crypto from "crypto";
import { aesGcmEncrypt, aesGcmDecrypt } from "./aesGcm.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomKey(): Buffer {
  return crypto.randomBytes(32);
}

function randomIv(): Buffer {
  return crypto.randomBytes(12);
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbPlaintext = fc.uint8Array({ minLength: 0, maxLength: 10_000 }).map(Buffer.from);
const arbKey = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(Buffer.from);
const arbIv = fc.uint8Array({ minLength: 12, maxLength: 12 }).map(Buffer.from);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aesGcmEncrypt / aesGcmDecrypt round-trip", () => {
  it("decrypts to the original plaintext for a known small input", () => {
    const key = randomKey();
    const iv = randomIv();
    const plaintext = Buffer.from("hello evidence trail");
    const ciphertext = aesGcmEncrypt(plaintext, key, iv);
    const recovered = aesGcmDecrypt(ciphertext, key, iv);
    expect(recovered).toEqual(plaintext);
  });

  it("handles empty plaintext", () => {
    const key = randomKey();
    const iv = randomIv();
    const plaintext = Buffer.alloc(0);
    const ciphertext = aesGcmEncrypt(plaintext, key, iv);
    const recovered = aesGcmDecrypt(ciphertext, key, iv);
    expect(recovered).toEqual(plaintext);
  });

  it(
    "property P2-analog: round-trip is identity for any plaintext, key, iv",
    () => {
      // Feature: evidence-trail, Task 1.6: AES round-trip property
      fc.assert(
        fc.property(arbPlaintext, arbKey, arbIv, (plaintext, key, iv) => {
          const ciphertext = aesGcmEncrypt(plaintext, key, iv);
          const recovered = aesGcmDecrypt(ciphertext, key, iv);
          expect(recovered).toEqual(plaintext);
        }),
        { numRuns: 100 }
      );
    }
  );

  it(
    "property: ciphertext is always longer than plaintext by exactly 16 bytes (auth tag)",
    () => {
      fc.assert(
        fc.property(arbPlaintext, arbKey, arbIv, (plaintext, key, iv) => {
          const ciphertext = aesGcmEncrypt(plaintext, key, iv);
          // Wire format: [tag(16) | ciphertext(n)] so total = plaintext.length + 16
          expect(ciphertext.length).toBe(plaintext.length + 16);
        }),
        { numRuns: 100 }
      );
    }
  );
});

describe("aesGcmDecrypt authentication tag verification", () => {
  it("throws when a single byte in the auth tag is flipped", () => {
    const key = randomKey();
    const iv = randomIv();
    const plaintext = Buffer.from("sensitive evidence");
    const ciphertext = Buffer.from(aesGcmEncrypt(plaintext, key, iv));
    // Flip bit in the auth tag (first 16 bytes)
    ciphertext[0] ^= 0x01;
    expect(() => aesGcmDecrypt(ciphertext, key, iv)).toThrow(
      "authentication tag verification failed"
    );
  });

  it("throws when a single byte in the ciphertext body is flipped", () => {
    const key = randomKey();
    const iv = randomIv();
    const plaintext = Buffer.from("more sensitive evidence here");
    const ciphertext = Buffer.from(aesGcmEncrypt(plaintext, key, iv));
    // Flip a byte in the ciphertext body (after first 16 tag bytes)
    ciphertext[16] ^= 0xff;
    expect(() => aesGcmDecrypt(ciphertext, key, iv)).toThrow(
      "authentication tag verification failed"
    );
  });

  it(
    "property: any single-byte mutation to ciphertext causes decrypt to throw",
    () => {
      fc.assert(
        fc.property(
          // Use non-empty plaintext so ciphertext body is present
          fc.uint8Array({ minLength: 1, maxLength: 1000 }).map(Buffer.from),
          arbKey,
          arbIv,
          fc.integer({ min: 0, max: 31 }), // byte index to flip (within tag+first body)
          (plaintext, key, iv, byteIdx) => {
            const ciphertext = Buffer.from(aesGcmEncrypt(plaintext, key, iv));
            const idx = byteIdx % ciphertext.length;
            ciphertext[idx] ^= 0x01;
            expect(() => aesGcmDecrypt(ciphertext, key, iv)).toThrow();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  it("throws when decrypting with a different key", () => {
    const key1 = randomKey();
    const key2 = randomKey();
    const iv = randomIv();
    const ciphertext = aesGcmEncrypt(Buffer.from("data"), key1, iv);
    expect(() => aesGcmDecrypt(ciphertext, key2, iv)).toThrow();
  });

  it("throws when decrypting with a different IV", () => {
    const key = randomKey();
    const iv1 = randomIv();
    const iv2 = randomIv();
    const ciphertext = aesGcmEncrypt(Buffer.from("data"), key, iv1);
    expect(() => aesGcmDecrypt(ciphertext, key, iv2)).toThrow();
  });
});

describe("aesGcmEncrypt / aesGcmDecrypt input validation", () => {
  it("encrypt throws TypeError for wrong key length", () => {
    expect(() =>
      aesGcmEncrypt(Buffer.from("test"), Buffer.alloc(16), randomIv())
    ).toThrow(TypeError);
    expect(() =>
      aesGcmEncrypt(Buffer.from("test"), Buffer.alloc(64), randomIv())
    ).toThrow(TypeError);
  });

  it("encrypt throws TypeError for wrong IV length", () => {
    expect(() =>
      aesGcmEncrypt(Buffer.from("test"), randomKey(), Buffer.alloc(8))
    ).toThrow(TypeError);
    // 16 bytes is now wrong (IV is 12 bytes)
    expect(() =>
      aesGcmEncrypt(Buffer.from("test"), randomKey(), Buffer.alloc(16))
    ).toThrow(TypeError);
  });

  it("decrypt throws TypeError for wrong key length", () => {
    const key = randomKey();
    const iv = randomIv();
    const ct = aesGcmEncrypt(Buffer.from("test"), key, iv);
    expect(() => aesGcmDecrypt(ct, Buffer.alloc(16), iv)).toThrow(TypeError);
  });

  it("decrypt throws TypeError for wrong IV length", () => {
    const key = randomKey();
    const iv = randomIv();
    const ct = aesGcmEncrypt(Buffer.from("test"), key, iv);
    expect(() => aesGcmDecrypt(ct, key, Buffer.alloc(8))).toThrow(TypeError);
    // 16 bytes is now wrong (IV is 12 bytes)
    expect(() => aesGcmDecrypt(ct, key, Buffer.alloc(16))).toThrow(TypeError);
  });

  it("decrypt throws TypeError when ciphertext is shorter than auth tag", () => {
    expect(() =>
      aesGcmDecrypt(Buffer.alloc(10), randomKey(), randomIv())
    ).toThrow(TypeError);
  });
});
