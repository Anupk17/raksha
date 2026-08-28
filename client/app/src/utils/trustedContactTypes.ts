/**
 * trustedContactTypes — client-side TrustedContact interface + helpers.
 *
 * Mirrors functions/src/types/trustedContact.ts with all timestamps as
 * native Date objects. Firestore Timestamps are converted at the
 * deserialization boundary via toDate().
 *
 * Design: §Change 1 — TrustedContact Type
 */
import type { DocumentData } from 'firebase/firestore'

export interface TrustedContact {
  id:                    string
  ownerUserId:           string
  name:                  string
  phoneNumber:           string
  relationship:          string
  priority:              number
  notifyOnSOS:           boolean
  notifyOnDigitalThreat: boolean
  createdAt:             Date
  updatedAt:             Date
}

export interface ContactFormValues {
  name:         string
  phoneNumber:  string
  relationship: string
  notifyOnSOS:  boolean
}

export const EMPTY_FORM: ContactFormValues = {
  name: '', phoneNumber: '', relationship: '', notifyOnSOS: true,
}

/** Phone: 7–15 chars, digits plus common formatting chars */
export const PHONE_REGEX = /^[+\d\s\-()]{7,15}$/

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------

function toDate(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof (value as { toDate?: unknown }).toDate === 'function')
    return (value as { toDate(): Date }).toDate()
  if (typeof value === 'string') { const d = new Date(value); return isNaN(d.getTime()) ? null : d }
  return null
}

// ---------------------------------------------------------------------------
// Deserializer
// ---------------------------------------------------------------------------

export function deserializeTrustedContact(raw: DocumentData): TrustedContact | null {
  try {
    return {
      id:                    raw['id']                    as string,
      ownerUserId:           raw['ownerUserId']           as string,
      name:                  raw['name']                  as string,
      phoneNumber:           raw['phoneNumber']           as string,
      relationship:          (raw['relationship'] as string) ?? '',
      priority:              (raw['priority'] as number) ?? 1,
      notifyOnSOS:           (raw['notifyOnSOS'] as boolean) ?? true,
      notifyOnDigitalThreat: (raw['notifyOnDigitalThreat'] as boolean) ?? false,
      createdAt:             toDate(raw['createdAt'])  ?? new Date(),
      updatedAt:             toDate(raw['updatedAt'])  ?? new Date(),
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateContactForm(
  values: ContactFormValues,
  allContacts: TrustedContact[],
  excludeId?: string,
): string | null {
  if (!values.name.trim()) return 'Name is required.'
  if (values.name.trim().length > 50) return 'Name must be 50 characters or fewer.'
  if (!values.phoneNumber.trim()) return 'Phone number is required.'
  const digitsOnly = values.phoneNumber.replace(/[\s\-()]/g, '')
  if (!PHONE_REGEX.test(values.phoneNumber) || digitsOnly.replace('+', '').length < 7)
    return 'Enter a valid phone number (7–15 digits).'
  if (values.relationship.length > 30) return 'Relationship must be 30 characters or fewer.'
  const duplicate = allContacts.find(
    (c) => c.phoneNumber === values.phoneNumber && c.id !== excludeId
  )
  if (duplicate) return `${values.phoneNumber} is already in your contacts.`
  return null
}
