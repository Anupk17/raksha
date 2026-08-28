/**
 * TrustedContactsScreen — full CRUD for /trusted_contacts.
 *
 * STATE MACHINES:
 *   ContactsState: loading → loaded(contacts) | error
 *   FormState: closed | adding | editing(contact)
 *
 * DESIGN NOTES:
 * - getDocs (not onSnapshot) — settings data, no real-time needed
 * - writeBatch for priority reorder — two simultaneous updates must be atomic
 * - notifyOnDigitalThreat stored but shown as Coming Soon (UI-honesty)
 * - All timestamps are native Date — no Firestore Timestamp in state
 *
 * Design: §Change 6 — Trusted Contacts Screen
 * Requirements: 8.1–8.10
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  collection, doc, getDocs, setDoc, deleteDoc,
  query, where, orderBy, writeBatch,
  type DocumentData,
} from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth } from '../contexts/AuthContext'
import {
  deserializeTrustedContact,
  validateContactForm,
  EMPTY_FORM,
  type TrustedContact,
  type ContactFormValues,
} from '../utils/trustedContactTypes'

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

type ContactsState =
  | { kind: 'loading' }
  | { kind: 'loaded'; contacts: TrustedContact[] }
  | { kind: 'error'; message: string }

type FormState =
  | { kind: 'closed' }
  | { kind: 'adding' }
  | { kind: 'editing'; contact: TrustedContact }

// ---------------------------------------------------------------------------
// ContactForm — inline form for add/edit
// ---------------------------------------------------------------------------

interface ContactFormProps {
  initial:    ContactFormValues
  allContacts: TrustedContact[]
  excludeId?: string
  onSave:    (values: ContactFormValues) => Promise<void>
  onCancel:  () => void
  saving:    boolean
}

function ContactForm({ initial, allContacts, excludeId, onSave, onCancel, saving }: ContactFormProps) {
  const [values,   setValues]   = useState<ContactFormValues>(initial)
  const [error,    setError]    = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const err = validateContactForm(values, allContacts, excludeId)
    if (err) { setError(err); return }
    setError(null)
    await onSave(values)
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="card stack-sm">
      {error && (
        <div className="banner banner-error" role="alert">{error}</div>
      )}

      <div className="input-group">
        <label className="input-label" htmlFor="tc-name">Name *</label>
        <input
          id="tc-name"
          className="input"
          type="text"
          placeholder="e.g. Priya Sharma"
          value={values.name}
          onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          maxLength={50}
          required
        />
      </div>

      <div className="input-group">
        <label className="input-label" htmlFor="tc-phone">Phone number *</label>
        <input
          id="tc-phone"
          className="input"
          type="tel"
          placeholder="e.g. +91 98765 43210"
          value={values.phoneNumber}
          onChange={(e) => setValues((v) => ({ ...v, phoneNumber: e.target.value }))}
          maxLength={15}
          required
        />
      </div>

      <div className="input-group">
        <label className="input-label" htmlFor="tc-rel">Relationship (optional)</label>
        <input
          id="tc-rel"
          className="input"
          type="text"
          placeholder="e.g. Sister, Friend"
          value={values.relationship}
          onChange={(e) => setValues((v) => ({ ...v, relationship: e.target.value }))}
          maxLength={30}
        />
      </div>

      {/* notifyOnSOS toggle */}
      <label className="toggle-row" htmlFor="tc-sos">
        <div className="toggle-info">
          <div className="toggle-label">Notify when SOS activates</div>
          <div className="toggle-sublabel">This contact will be alerted if no guardian is nearby</div>
        </div>
        <input
          id="tc-sos"
          type="checkbox"
          className="toggle"
          checked={values.notifyOnSOS}
          onChange={(e) => setValues((v) => ({ ...v, notifyOnSOS: e.target.checked }))}
        />
      </label>

      {/* notifyOnDigitalThreat — Coming Soon */}
      <div style={{ opacity: 0.4, pointerEvents: 'none' }}>
        <label className="toggle-row" htmlFor="tc-threat">
          <div className="toggle-info">
            <div className="toggle-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              Notify on digital threat
              <span style={{
                fontSize: '0.65rem', fontWeight: 600, letterSpacing: '0.04em',
                textTransform: 'uppercase', background: 'var(--surface-3)',
                color: 'var(--text-muted)', borderRadius: '4px', padding: '2px 6px',
              }}>
                Coming soon
              </span>
            </div>
          </div>
          <input id="tc-threat" type="checkbox" className="toggle" disabled />
        </label>
      </div>

      <div className="stack-sm" style={{ marginTop: '0.5rem' }}>
        <button type="submit" className="btn btn-safe" disabled={saving}>
          {saving ? 'Saving…' : 'Save contact'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TrustedContactsScreen() {
  const { user } = useAuth()
  const uid = user!.uid

  const [contactsState, setContactsState] = useState<ContactsState>({ kind: 'loading' })
  const [formState,     setFormState]     = useState<FormState>({ kind: 'closed' })
  const [saving,        setSaving]        = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  // ── Load contacts ─────────────────────────────────────────────────────────
  async function loadContacts() {
    setContactsState({ kind: 'loading' })
    try {
      const q = query(
        collection(db, 'trusted_contacts'),
        where('ownerUserId', '==', uid),
        orderBy('priority', 'asc'),
      )
      const snap = await getDocs(q)
      const contacts = snap.docs
        .map((d: { data(): DocumentData }) => deserializeTrustedContact(d.data()))
        .filter((c): c is TrustedContact => c !== null)
      setContactsState({ kind: 'loaded', contacts })
    } catch (err) {
      const msg = import.meta.env.VITE_USE_EMULATOR === 'true'
        ? `Failed to load: ${(err as Error).message}`
        : 'Failed to load contacts. Please try again.'
      setContactsState({ kind: 'error', message: msg })
    }
  }

  useEffect(() => { void loadContacts() }, [uid]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save (add or edit) ────────────────────────────────────────────────────
  async function handleSave(values: ContactFormValues) {
    const contacts = contactsState.kind === 'loaded' ? contactsState.contacts : []
    setSaving(true)
    try {
      const now = new Date()
      if (formState.kind === 'editing') {
        const c = formState.contact
        await setDoc(doc(db, 'trusted_contacts', c.id), {
          ...c, ...values,
          updatedAt: now,
        })
      } else {
        const id = crypto.randomUUID()
        await setDoc(doc(db, 'trusted_contacts', id), {
          id,
          ownerUserId:           uid,
          name:                  values.name.trim(),
          phoneNumber:           values.phoneNumber.trim(),
          relationship:          values.relationship.trim(),
          notifyOnSOS:           values.notifyOnSOS,
          notifyOnDigitalThreat: false,
          priority:              contacts.length + 1,
          createdAt:             now,
          updatedAt:             now,
        })
      }
      setFormState({ kind: 'closed' })
      await loadContacts()
    } finally {
      setSaving(false)
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  async function handleDelete(id: string) {
    setSaving(true)
    try {
      await deleteDoc(doc(db, 'trusted_contacts', id))
      // Re-normalise priorities after deletion
      const contacts = contactsState.kind === 'loaded' ? contactsState.contacts : []
      const remaining = contacts.filter((c) => c.id !== id)
      const batch = writeBatch(db)
      remaining.forEach((c, idx) => {
        batch.update(doc(db, 'trusted_contacts', c.id), { priority: idx + 1, updatedAt: new Date() })
      })
      await batch.commit()
      await loadContacts()
    } finally {
      setSaving(false)
      setDeleteConfirm(null)
    }
  }

  // ── Priority reorder ──────────────────────────────────────────────────────
  async function movePriority(contact: TrustedContact, direction: 'up' | 'down') {
    if (contactsState.kind !== 'loaded') return
    const { contacts } = contactsState
    const idx = contacts.findIndex((c) => c.id === contact.id)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= contacts.length) return

    const other = contacts[swapIdx]
    const batch = writeBatch(db)
    batch.update(doc(db, 'trusted_contacts', contact.id), { priority: other.priority, updatedAt: new Date() })
    batch.update(doc(db, 'trusted_contacts', other.id),   { priority: contact.priority, updatedAt: new Date() })
    await batch.commit()
    await loadContacts()
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const contacts = contactsState.kind === 'loaded' ? contactsState.contacts : []

  return (
    <div className="screen">
      <nav className="nav-bar">
        <span className="nav-logo">🛡️ RAKSHA</span>
        <div className="nav-links">
          <Link to="/settings" className="nav-link">← Settings</Link>
          <Link to="/home" className="nav-link">Home</Link>
        </div>
      </nav>

      <h1 style={{ marginBottom: '0.25rem' }}>Trusted Contacts</h1>
      <p className="text-muted text-sm" style={{ marginBottom: '1.5rem' }}>
        These people are notified when no guardian is nearby during an SOS.
      </p>

      {/* Loading */}
      {contactsState.kind === 'loading' && (
        <div className="screen-centered" style={{ minHeight: 'unset', paddingTop: '2rem' }}>
          <div className="spinner" role="status" aria-label="Loading contacts…" />
        </div>
      )}

      {/* Error */}
      {contactsState.kind === 'error' && (
        <div className="banner banner-error" role="alert" style={{ marginBottom: '1rem' }}>
          {contactsState.message}
        </div>
      )}

      {/* Delete confirm overlay */}
      {deleteConfirm && (
        <div className="banner banner-warning" role="alert" style={{ marginBottom: '1rem' }}>
          <p style={{ marginBottom: '0.75rem' }}>Remove this contact?</p>
          <div className="row" style={{ gap: '0.5rem' }}>
            <button
              className="btn btn-ghost"
              style={{ flex: 1, padding: '0.4rem', fontSize: '0.875rem', color: 'var(--accent-red)' }}
              onClick={() => void handleDelete(deleteConfirm)}
              disabled={saving}
            >
              {saving ? 'Removing…' : 'Remove'}
            </button>
            <button
              className="btn btn-ghost"
              style={{ flex: 1, padding: '0.4rem', fontSize: '0.875rem' }}
              onClick={() => setDeleteConfirm(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Add form */}
      {formState.kind === 'adding' && (
        <ContactForm
          initial={EMPTY_FORM}
          allContacts={contacts}
          onSave={handleSave}
          onCancel={() => setFormState({ kind: 'closed' })}
          saving={saving}
        />
      )}

      {/* Edit form */}
      {formState.kind === 'editing' && (
        <ContactForm
          initial={{
            name:         formState.contact.name,
            phoneNumber:  formState.contact.phoneNumber,
            relationship: formState.contact.relationship,
            notifyOnSOS:  formState.contact.notifyOnSOS,
          }}
          allContacts={contacts}
          excludeId={formState.contact.id}
          onSave={handleSave}
          onCancel={() => setFormState({ kind: 'closed' })}
          saving={saving}
        />
      )}

      {/* Contact list */}
      {contactsState.kind === 'loaded' && formState.kind === 'closed' && (
        <div className="stack">
          {contacts.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '2rem 1rem' }}>
              <p style={{ fontSize: '1.75rem', marginBottom: '0.75rem' }}>👥</p>
              <p className="text-muted" style={{ marginBottom: '1rem' }}>
                No emergency contacts yet. Add someone who should be notified if
                guardians aren't nearby.
              </p>
            </div>
          ) : (
            contacts.map((c, idx) => (
              <div key={c.id} className="card stack-sm">
                <div className="row-between">
                  <div>
                    <p style={{ fontWeight: 600 }}>{c.name}</p>
                    <p className="text-muted text-sm">{c.phoneNumber}</p>
                    {c.relationship && (
                      <p className="text-muted text-xs">{c.relationship}</p>
                    )}
                  </div>
                  <span className={`chip ${c.notifyOnSOS ? 'chip-green' : ''}`}
                    style={!c.notifyOnSOS ? { background: 'var(--surface-3)', color: 'var(--text-muted)' } : undefined}
                  >
                    {c.notifyOnSOS ? '✓ SOS' : 'No SOS'}
                  </span>
                </div>

                <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-ghost"
                    style={{ flex: '0 0 auto', padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
                    onClick={() => void movePriority(c, 'up')}
                    disabled={idx === 0 || saving}
                    aria-label="Move up"
                  >↑</button>
                  <button
                    className="btn btn-ghost"
                    style={{ flex: '0 0 auto', padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
                    onClick={() => void movePriority(c, 'down')}
                    disabled={idx === contacts.length - 1 || saving}
                    aria-label="Move down"
                  >↓</button>
                  <button
                    className="btn btn-ghost"
                    style={{ flex: 1, padding: '0.3rem', fontSize: '0.875rem' }}
                    onClick={() => setFormState({ kind: 'editing', contact: c })}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-ghost"
                    style={{ flex: 1, padding: '0.3rem', fontSize: '0.875rem', color: 'var(--accent-red)' }}
                    onClick={() => setDeleteConfirm(c.id)}
                  >
                    Delete
                  </button>
                </div>

                <p className="text-muted text-xs">Priority {c.priority}</p>
              </div>
            ))
          )}

          <button
            className="btn btn-primary"
            onClick={() => setFormState({ kind: 'adding' })}
            style={{ marginTop: contacts.length === 0 ? 0 : '0.25rem' }}
          >
            + Add contact
          </button>
        </div>
      )}
    </div>
  )
}
