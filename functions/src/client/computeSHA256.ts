/**
 * On-device SHA-256 computation using the Web Crypto API (Req 1.2).
 *
 * Called before any data leaves the device. The hash is stored on the
 * Firestore document and re-verified server-side by onEvidenceCreate.
 */

/**
 * Computes SHA-256 over raw file bytes.
 * @param file - Browser File object.
 * @returns Lowercase hex digest string (64 chars).
 */
export async function computeSHA256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Computes SHA-256 over a Node.js Buffer (used in tests and server-side paths).
 * @param data - Raw bytes as Buffer.
 * @returns Lowercase hex digest string.
 */
export function computeSHA256Buffer(data: Buffer): string {
  // Use Node.js crypto — same algorithm, different API
  const { createHash } = require("crypto") as typeof import("crypto");
  return createHash("sha256").update(data).digest("hex");
}
