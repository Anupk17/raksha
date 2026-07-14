/**
 * activationConfig.test.ts — Unit tests for Task 12.
 *
 * Target: 7 tests (per tasks.md §Task 12)
 *
 * Tests:
 *   12.4.1 — validateActivationConfig rejects when no triggers enabled
 *   12.4.2 — validateActivationConfig rejects duress PIN that matches normal PIN
 *   12.4.3 — validateActivationConfig rejects duress PIN with fewer than 6 digits (not 4)
 *   12.4.4 — validateActivationConfig rejects duress PIN outside 6–8 digit range (9 digits)
 *   12.4.5 — validateActivationConfig rejects phrase shorter than 2 words
 *   12.4.6 — saveActivationConfig hashes PIN with bcrypt cost=10; plaintext not in written object
 *   12.4.7 — test mode routes to testTrigger, not createSOSSession
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcryptjs";
import {
  validateActivationConfig,
  saveActivationConfig,
  resolveTriggerCallable,
  type SilentActivationConfig,
  type FirestoreConfigWriter,
} from "./activationConfig.js";

// ---------------------------------------------------------------------------
// 12.4.1 — rejects when no triggers enabled
// ---------------------------------------------------------------------------
describe("validateActivationConfig", () => {
  it("rejects config when no trigger type is enabled", () => {
    const errors = validateActivationConfig({
      powerButtonEnabled: false,
      earbudEnabled: false,
      duressPinEnabled: false,
      duressPhraseEnabled: false,
    });

    expect(errors.length).toBeGreaterThan(0);
    const generalError = errors.find((e) => e.field === "general");
    expect(generalError).toBeDefined();
    expect(generalError!.message).toMatch(/at least one trigger/i);
  });

  // -------------------------------------------------------------------------
  // 12.4.2 — rejects duress PIN that matches normal PIN
  // -------------------------------------------------------------------------
  it("rejects duress PIN that is identical to the normal PIN", () => {
    const errors = validateActivationConfig({
      duressPinEnabled: true,
      duressPin: "123456",
      normalPin: "123456",
    });

    const pinError = errors.find((e) => e.field === "duressPin");
    expect(pinError).toBeDefined();
    expect(pinError!.message).toMatch(/same as your normal/i);
  });

  // -------------------------------------------------------------------------
  // 12.4.3 — rejects duress PIN with fewer than 6 digits (not 4)
  // -------------------------------------------------------------------------
  it("rejects a 4-digit duress PIN (minimum is 6, not 4)", () => {
    const errors = validateActivationConfig({
      duressPinEnabled: true,
      duressPin: "1234",  // 4 digits — below the 6-digit minimum
      normalPin: "9999",
    });

    const pinError = errors.find((e) => e.field === "duressPin");
    expect(pinError).toBeDefined();
    expect(pinError!.message).toMatch(/6 to 8/i);
  });

  // -------------------------------------------------------------------------
  // 12.4.4 — rejects duress PIN outside the 6–8 digit range (9 digits)
  // -------------------------------------------------------------------------
  it("rejects a 9-digit duress PIN (maximum is 8)", () => {
    const errors = validateActivationConfig({
      duressPinEnabled: true,
      duressPin: "123456789", // 9 digits — above the 8-digit maximum
      normalPin: "999999",
    });

    const pinError = errors.find((e) => e.field === "duressPin");
    expect(pinError).toBeDefined();
    expect(pinError!.message).toMatch(/6 to 8/i);
  });

  // -------------------------------------------------------------------------
  // 12.4.5 — rejects phrase shorter than 2 words
  // -------------------------------------------------------------------------
  it("rejects a duress phrase that is a single word", () => {
    const errors = validateActivationConfig({
      duressPhraseEnabled: true,
      duressPhrase: "help",  // one word — minimum is 2 words
    });

    const phraseError = errors.find((e) => e.field === "duressPhrase");
    expect(phraseError).toBeDefined();
    expect(phraseError!.message).toMatch(/at least two words/i);
  });

  // -------------------------------------------------------------------------
  // Valid config produces zero errors
  // -------------------------------------------------------------------------
  it("returns no errors for a fully valid config", () => {
    const errors = validateActivationConfig({
      earbudEnabled: true,
      duressPinEnabled: true,
      duressPin: "654321",
      normalPin: "111111",
      duressPhraseEnabled: true,
      duressPhrase: "call for help",
    });

    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 12.4.6 — saveActivationConfig hashes PIN with bcrypt cost=10; plaintext absent
// ---------------------------------------------------------------------------
describe("saveActivationConfig", () => {
  it("hashes the duress PIN with bcrypt cost=10 and does not write the plaintext PIN", async () => {
    const written: Record<string, unknown> = {};

    const mockWriter: FirestoreConfigWriter = async (_userId, patch) => {
      Object.assign(written, patch);
    };

    const config: SilentActivationConfig = {
      duressPinEnabled: true,
      duressPin: "654321",
      earbudEnabled: true,
    };

    await saveActivationConfig("user-abc", config, mockWriter);

    // The written object must contain a hash
    expect(written.duressPinHash).toBeDefined();
    expect(typeof written.duressPinHash).toBe("string");

    // The hash must be a valid bcrypt cost=10 hash
    const hash = written.duressPinHash as string;
    expect(hash).toMatch(/^\$2[abxy]\$10\$/);

    // The written object must NOT contain the plaintext PIN
    expect((written as Record<string, unknown>).duressPin).toBeUndefined();
    expect((written as Record<string, unknown>).normalPin).toBeUndefined();

    // The hash must actually match the original PIN
    const matches = await bcrypt.compare("654321", hash);
    expect(matches).toBe(true);
  }, 15_000); // bcrypt cost=10 is slow; allow generous timeout
});

// ---------------------------------------------------------------------------
// 12.4.7 — test mode routes to testTrigger
// ---------------------------------------------------------------------------
describe("resolveTriggerCallable", () => {
  it("returns 'testTrigger' when testMode is true", () => {
    const callable = resolveTriggerCallable({ testMode: true });
    expect(callable).toBe("testTrigger");
  });

  it("returns 'createSOSSession' when testMode is false", () => {
    const callable = resolveTriggerCallable({ testMode: false });
    expect(callable).toBe("createSOSSession");
  });

  it("returns 'createSOSSession' when testMode is absent", () => {
    const callable = resolveTriggerCallable({});
    expect(callable).toBe("createSOSSession");
  });
});
