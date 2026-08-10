/**
 * evidenceTypes — client-side representation of an evidence item.
 *
 * This is a UI-facing subset of the full EvidenceDocument from the backend.
 * Fields not needed for display (sha256Hash, encryptionKeyRef, encryptionIV,
 * raw chainOfCustody entries) are omitted to keep React state minimal.
 *
 * All timestamps are native Date objects — Firestore Timestamps must be
 * converted at the deserialization boundary (see evidenceTimestamp.ts).
 *
 * Design: §Shared Utilities — evidenceTypes.ts
 */

export type EvidenceStatus =
  | 'uploading'
  | 'processing'
  | 'available'
  | 'expired'
  | 'legal_hold'
  | 'failed'
  | 'integrity_failed'
  | 'encryption_failed';

export interface EvidenceItem {
  evidenceId:          string;
  incidentId:          string;
  type:                'photo' | 'video' | 'audio' | 'screenshot' | 'document';
  originalFilename:    string;
  mimeType:            string;
  sizeBytes:           number;
  status:              EvidenceStatus;
  /** capturedAt from evidence.metadata — always native Date in client state */
  capturedAt:          Date;
  /** null until set by Cloud Function, or null for expired items past retention */
  retentionExpiresAt:  Date | null;
  /** Length of the chainOfCustody array — used for the "N actions recorded" summary */
  custodyCount:        number;
}

/** Maps evidence type to display emoji */
export const TYPE_ICONS: Record<EvidenceItem['type'], string> = {
  photo:      '📷',
  video:      '🎥',
  audio:      '🎤',
  screenshot: '🖼️',
  document:   '📄',
};

/** Maps status to chip class and display label */
export const STATUS_CHIP: Record<EvidenceStatus, { cls: string; label: string }> = {
  uploading:          { cls: 'chip-amber', label: 'Uploading…'       },
  processing:         { cls: 'chip-amber', label: 'Processing…'      },
  available:          { cls: 'chip-green', label: 'Available'         },
  legal_hold:         { cls: 'chip-green', label: 'Legal Hold'        },
  expired:            { cls: 'chip-amber', label: 'Expired'           },
  failed:             { cls: 'chip-red',   label: 'Upload failed'     },
  integrity_failed:   { cls: 'chip-red',   label: 'Integrity error'   },
  encryption_failed:  { cls: 'chip-red',   label: 'Encryption error'  },
};
