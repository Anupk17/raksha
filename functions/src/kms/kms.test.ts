/**
 * Tests for KMSClient interface, KMSMock, and createKMSClient factory.
 *
 * These tests run with NODE_ENV=test (set in vitest.config.ts), so
 * createKMSClient() always returns KMSMock — no real Cloud KMS calls.
 *
 * Feature: evidence-trail, Task 1.5: KMS interface + mock + factory
 * Requirements: 4.3, 4.4, 4.5
 */
import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";
import { KMSMock } from "./KMSMock.js";
import { createKMSClient } from "./createKMSClient.js";

describe("createKMSClient factory", () => {
  it("returns KMSMock when NODE_ENV=test", () => {
    // vitest.config.ts sets NODE_ENV=test globally
    const client = createKMSClient();
    expect(client).toBeInstanceOf(KMSMock);
  });

  it("returns KMSMock when FUNCTIONS_EMULATOR=true", () => {
    const original = process.env["FUNCTIONS_EMULATOR"];
    try {
      process.env["FUNCTIONS_EMULATOR"] = "true";
      // Temporarily clear NODE_ENV to test FUNCTIONS_EMULATOR path in isolation
      const saved = process.env["NODE_ENV"];
      delete process.env["NODE_ENV"];
      const client = createKMSClient();
      expect(client).toBeInstanceOf(KMSMock);
      process.env["NODE_ENV"] = saved;
    } finally {
      if (original === undefined) {
        delete process.env["FUNCTIONS_EMULATOR"];
      } else {
        process.env["FUNCTIONS_EMULATOR"] = original;
      }
    }
  });
});

describe("KMSMock", () => {
  let mock: KMSMock;

  beforeEach(() => {
    mock = new KMSMock();
  });

  it("generateDataEncryptionKey returns a 256-bit DEK, 96-bit IV, and non-empty encryptedDEK", async () => {
    const result = await mock.generateDataEncryptionKey("projects/test/keyRings/test/cryptoKeys/test");
    expect(result.plaintextDEK).toBeInstanceOf(Buffer);
    expect(result.plaintextDEK.length).toBe(32); // 256 bits
    expect(result.iv).toBeInstanceOf(Buffer);
    expect(result.iv.length).toBe(12); // 96 bits — NIST SP 800-38D recommended size for GCM
    expect(typeof result.encryptedDEK).toBe("string");
    expect(result.encryptedDEK.length).toBeGreaterThan(0);
  });

  it("decryptDataEncryptionKey recovers the same plaintext DEK", async () => {
    const { encryptedDEK, plaintextDEK } = await mock.generateDataEncryptionKey(
      "projects/test/keyRings/test/cryptoKeys/test"
    );
    const recovered = await mock.decryptDataEncryptionKey(
      encryptedDEK,
      "projects/test/keyRings/test/cryptoKeys/test"
    );
    expect(recovered).toEqual(plaintextDEK);
  });

  it("decryptDataEncryptionKey throws for an unknown encryptedDEK", async () => {
    // The stateless mock uses a "MOCK:" sentinel prefix. A DEK not generated
    // by KMSMock (no prefix) is rejected with a descriptive error message.
    await expect(
      mock.decryptDataEncryptionKey("unknown-key", "projects/test/keyRings/test/cryptoKeys/test")
    ).rejects.toThrow("KMSMock: encryptedDEK does not have the expected mock prefix");
  });

  it("returns a copy from decryptDataEncryptionKey, not the stored reference", async () => {
    const { encryptedDEK, plaintextDEK } = await mock.generateDataEncryptionKey("key-ref");
    const recovered = await mock.decryptDataEncryptionKey(encryptedDEK, "key-ref");
    // Mutating recovered should not affect stored key
    recovered.fill(0);
    const recovered2 = await mock.decryptDataEncryptionKey(encryptedDEK, "key-ref");
    expect(recovered2).toEqual(plaintextDEK);
  });

  it("each call to generateDataEncryptionKey produces a unique DEK and IV", async () => {
    const a = await mock.generateDataEncryptionKey("key-ref");
    const b = await mock.generateDataEncryptionKey("key-ref");
    // Probability of collision is astronomically small; this is a sanity check
    expect(a.plaintextDEK.toString("hex")).not.toBe(b.plaintextDEK.toString("hex"));
    expect(a.iv.toString("hex")).not.toBe(b.iv.toString("hex"));
    expect(a.encryptedDEK).not.toBe(b.encryptedDEK);
  });

  it("separate KMSMock instances share the same stateless format — cross-instance decryption succeeds by design", async () => {
    // The KMSMock was refactored from a stateful Map to a stateless sentinel-prefix
    // design (MOCK:<base64>). This means any instance can decrypt any other
    // instance's DEKs — isolation is intentionally absent in the mock.
    // The real CloudKMSClient uses GCP KMS and IS isolated (different key ring refs).
    // This test documents the mock's actual contract so it doesn't read as a bug.
    const mockA = new KMSMock();
    const mockB = new KMSMock();
    const { encryptedDEK, plaintextDEK } = await mockA.generateDataEncryptionKey("key-ref");
    // mockB can decrypt mockA's key — this is expected for the stateless mock
    const recovered = await mockB.decryptDataEncryptionKey(encryptedDEK, "key-ref");
    expect(recovered).toEqual(plaintextDEK);
  });

  it(
    "property: decrypt(encrypt(dek)) === dek for any key ref string",
    async () => {
      // Feature: evidence-trail, Task 1.5: KMS mock round-trip property
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 128 }),
          async (keyRef) => {
            const instance = new KMSMock();
            const { encryptedDEK, plaintextDEK } =
              await instance.generateDataEncryptionKey(keyRef);
            const recovered = await instance.decryptDataEncryptionKey(
              encryptedDEK,
              keyRef
            );
            expect(recovered).toEqual(plaintextDEK);
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  it(
    "property: each generateDataEncryptionKey call produces a 32-byte DEK and 12-byte IV",
    async () => {
      // Feature: evidence-trail, Task 1.5: KMS mock — 96-bit IV per NIST SP 800-38D
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 128 }),
          async (keyRef) => {
            const instance = new KMSMock();
            const { plaintextDEK, iv, encryptedDEK } =
              await instance.generateDataEncryptionKey(keyRef);
            expect(plaintextDEK.length).toBe(32);
            expect(iv.length).toBe(12); // 96-bit IV
            expect(encryptedDEK.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});
