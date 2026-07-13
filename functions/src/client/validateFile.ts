/**
 * Client-side file validation (Req 1.1).
 * Runs entirely on-device before any Firestore or Storage interaction.
 */

export type EvidenceFileType = "photo" | "video" | "audio" | "screenshot" | "document";

export const SUPPORTED_MIME_TYPES: Record<string, EvidenceFileType> = {
  // photo
  "image/jpeg": "photo", "image/png": "photo", "image/webp": "photo", "image/gif": "photo",
  // video
  "video/mp4": "video", "video/quicktime": "video", "video/webm": "video",
  // audio
  "audio/mpeg": "audio", "audio/wav": "audio", "audio/ogg": "audio", "audio/mp4": "audio",
  // screenshot
  "image/bmp": "screenshot", "image/tiff": "screenshot",
  // document
  "application/pdf": "document",
  "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "text/plain": "document",
};

export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

export type ValidationResult =
  | { valid: true; type: EvidenceFileType }
  | { valid: false; reason: string };

export function validateFile(mimeType: string, sizeBytes: number): ValidationResult {
  const type = SUPPORTED_MIME_TYPES[mimeType];
  if (!type) {
    return { valid: false, reason: `Unsupported file type: ${mimeType}` };
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      reason: `File exceeds 100 MB limit (${sizeBytes} bytes)`,
    };
  }
  return { valid: true, type };
}
