/**
 * Tests for Guardian types and runtime structures.
 *
 * Checks that values match structural constraints.
 *
 * Feature: Hyperlocal Guardian Network, Task 1.1
 */
import { describe, it, expect } from "vitest";
import type {
  Guardian,
  GuardianPing,
  GuardianVerificationStatus,
  GuardianResponse,
} from "./guardian.js";

describe("Guardian types", () => {
  it("defines correct verification statuses", () => {
    const statuses: GuardianVerificationStatus[] = ["pending", "verified", "rejected"];
    expect(statuses).toContain("pending");
    expect(statuses).toContain("verified");
    expect(statuses).toContain("rejected");
    expect(statuses.length).toBe(3);
  });

  it("defines correct responses", () => {
    const responses: GuardianResponse[] = ["accepted", "declined", "no_response"];
    expect(responses).toContain("accepted");
    expect(responses).toContain("declined");
    expect(responses).toContain("no_response");
    expect(responses.length).toBe(3);
  });
});
