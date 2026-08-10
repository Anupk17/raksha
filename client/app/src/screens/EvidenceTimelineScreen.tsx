/**
 * EvidenceTimelineScreen — list all evidence items for an incident.
 *
 * TIMELINE STATE MACHINE:
 *   loading → loaded (items) | empty | error
 *
 * VIEW STATE MACHINE (independent — a view error never destroys the list):
 *   idle → loading → viewing | error
 *
 * SECURITY: Decrypted content is NEVER cached. serveEvidenceFile returns
 * base64-encoded decrypted bytes. These are converted to a Blob and exposed
 * as an in-memory object URL via URL.createObjectURL(). The object URL is
 * revoked immediately when the modal is closed. Video/audio elements have
 * their src cleared and are paused before revocation to prevent the browser
 * holding a reference through an active media pipeline.
 *
 * Each tap triggers a fresh serveEvidenceFile call — re-checking access
 * rights on every view. A user whose access is revoked will receive
 * PERMISSION_DENIED on their next tap even if they previously viewed the file.
 *
 * Design: §Screen 2: EvidenceTimelineScreen
 * Requirements: 2.1–2.10
 */
import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  collection, query, where, orderBy, getDocs,
  type DocumentData,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, fns } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toDate, requireDate, formatTimestamp } from '../utils/evidenceTimestamp';
import { TYPE_ICONS, STATUS_CHIP, type EvidenceItem, type EvidenceStatus } from '../utils/evidenceTypes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TimelineState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'loaded'; items: EvidenceItem[] }
  | { kind: 'error'; message: string };

type ViewState =
  | { kind: 'idle' }
  | { kind: 'loading'; evidenceId: string }
  | { kind: 'viewing'; evidenceId: string; objectUrl: string; mimeType: string; filename: string }
  | { kind: 'error'; evidenceId: string; message: string };

interface ServeResponse { data: string; mimeType: string }

// ---------------------------------------------------------------------------
// Deserializer
// ---------------------------------------------------------------------------

function deserializeEvidenceItem(raw: DocumentData): EvidenceItem | null {
  try {
    const metadata = raw['metadata'] as Record<string, unknown> | undefined;
    return {
      evidenceId:         raw['evidenceId'] as string,
      incidentId:         raw['incidentId'] as string,
      type:               raw['type'] as EvidenceItem['type'],
      originalFilename:   raw['originalFilename'] as string,
      mimeType:           raw['mimeType'] as string,
      sizeBytes:          raw['sizeBytes'] as number,
      status:             raw['status'] as EvidenceStatus,
      capturedAt:         requireDate(metadata?.['capturedAt'], 'metadata.capturedAt'),
      retentionExpiresAt: toDate(raw['retentionExpiresAt']),
      custodyCount:       Array.isArray(raw['chainOfCustody']) ? raw['chainOfCustody'].length : 0,
    };
  } catch (err) {
    console.error('[EvidenceTimeline] deserialize failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

function formatViewError(err: unknown): string {
  const code = (err as { code?: string }).code ?? '';
  if (code === 'functions/permission-denied' || code === 'functions/unauthenticated') {
    return 'You no longer have permission to view this file.';
  }
  if (code === 'functions/not-found') {
    return 'This evidence file could not be found.';
  }
  if (code === 'functions/unavailable') {
    return 'File temporarily unavailable — try again in a moment.';
  }
  if (import.meta.env.VITE_USE_EMULATOR === 'true') {
    const msg = (err as { message?: string }).message ?? '';
    return `Could not load file (${code}: ${msg})`;
  }
  return 'Could not load file — please try again.';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EvidenceTimelineScreen() {
  const { incidentId } = useParams<{ incidentId: string }>();
  const { user } = useAuth();

  const [timeline, setTimeline] = useState<TimelineState>({ kind: 'loading' });
  const [viewState, setViewState] = useState<ViewState>({ kind: 'idle' });

  // Refs for media elements — needed to pause + clear src before URL revocation
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // ── Load evidence items on mount ────────────────────────────────────────
  useEffect(() => {
    if (!incidentId || !user) return;

    async function load() {
      try {
        const q = query(
          collection(db, 'evidence'),
          where('incidentId', '==', incidentId),
          where('userId', '==', user!.uid),
          orderBy('metadata.capturedAt', 'desc'),
        );
        const snap = await getDocs(q);

        if (snap.empty) {
          setTimeline({ kind: 'empty' });
          return;
        }

        const items = snap.docs
          .map(d => deserializeEvidenceItem(d.data()))
          .filter((item): item is EvidenceItem => item !== null);

        setTimeline(items.length ? { kind: 'loaded', items } : { kind: 'empty' });
      } catch (err) {
        const msg = import.meta.env.VITE_USE_EMULATOR === 'true'
          ? `Failed to load evidence: ${(err as Error).message}`
          : 'Failed to load evidence. Please try again.';
        setTimeline({ kind: 'error', message: msg });
      }
    }

    void load();
  }, [incidentId, user]);

  // ── View a single evidence item ─────────────────────────────────────────
  async function handleView(item: EvidenceItem) {
    if (item.status !== 'available' && item.status !== 'legal_hold') return;

    setViewState({ kind: 'loading', evidenceId: item.evidenceId });

    try {
      const fn = httpsCallable<{ evidenceId: string }, ServeResponse>(fns, 'serveEvidenceFile');
      const result = await fn({ evidenceId: item.evidenceId });

      // base64 → Uint8Array → Blob — decrypted bytes exist only in memory
      const binaryStr = atob(result.data.data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: result.data.mimeType });
      const objectUrl = URL.createObjectURL(blob);

      setViewState({
        kind: 'viewing',
        evidenceId: item.evidenceId,
        objectUrl,
        mimeType: result.data.mimeType,
        filename: item.originalFilename,
      });
    } catch (err) {
      setViewState({ kind: 'error', evidenceId: item.evidenceId, message: formatViewError(err) });
    }
  }

  // ── Close modal + immediately revoke object URL ──────────────────────────
  function closeModal() {
    if (viewState.kind === 'viewing') {
      // Pause and clear src before revoke to prevent browser holding a media ref
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.src = '';
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
      // Revoke immediately — decrypted bytes no longer accessible after this
      URL.revokeObjectURL(viewState.objectUrl);
    }
    setViewState({ kind: 'idle' });
  }

  // ── Render ───────────────────────────────────────────────────────────────
  const isModalOpen = viewState.kind === 'loading' || viewState.kind === 'viewing' || viewState.kind === 'error';

  return (
    <div className="screen">
      {/* Nav */}
      <nav className="nav-bar">
        <span className="nav-logo">🛡️ RAKSHA</span>
        <div className="nav-links">
          <Link to="/home" className="nav-link">Home</Link>
        </div>
      </nav>

      <div className="row-between" style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ fontSize: '1.25rem' }}>Evidence</h1>
        {incidentId && (
          <Link
            to={`/evidence/capture?incidentId=${incidentId}`}
            className="btn btn-ghost"
            style={{ width: 'auto', padding: '0.4rem 0.75rem', fontSize: '0.875rem' }}
          >
            + Add
          </Link>
        )}
      </div>

      {incidentId && (
        <p className="text-muted text-xs" style={{ marginBottom: '1.25rem' }}>
          Incident: {incidentId.slice(0, 8)}…
        </p>
      )}

      {/* Timeline states */}
      {timeline.kind === 'loading' && (
        <div className="screen-centered" style={{ minHeight: 'unset', paddingTop: '2rem' }}>
          <div className="spinner" role="status" aria-label="Loading evidence…" />
        </div>
      )}

      {timeline.kind === 'error' && (
        <div className="banner banner-error" role="alert">{timeline.message}</div>
      )}

      {timeline.kind === 'empty' && (
        <div className="card" style={{ textAlign: 'center', padding: '2rem 1rem' }}>
          <p style={{ fontSize: '1.75rem', marginBottom: '0.75rem' }}>📂</p>
          <p className="text-muted" style={{ marginBottom: '1rem' }}>No evidence captured yet.</p>
          {incidentId && (
            <Link
              to={`/evidence/capture?incidentId=${incidentId}`}
              className="btn btn-primary"
              style={{ maxWidth: '200px', margin: '0 auto' }}
            >
              Capture evidence
            </Link>
          )}
        </div>
      )}

      {timeline.kind === 'loaded' && (
        <div className="stack">
          {timeline.items.map(item => {
            const chip = STATUS_CHIP[item.status];
            const icon = TYPE_ICONS[item.type];
            const canView = item.status === 'available' || item.status === 'legal_hold';
            return (
              <button
                key={item.evidenceId}
                className="card"
                onClick={() => { if (canView) void handleView(item); }}
                disabled={!canView}
                aria-label={`View ${item.originalFilename} — ${chip.label}`}
                style={{
                  textAlign: 'left',
                  cursor: canView ? 'pointer' : 'default',
                  border: '0.5px solid var(--border)',
                  width: '100%',
                  background: 'var(--surface)',
                }}
              >
                <div className="row-between" style={{ marginBottom: '0.5rem' }}>
                  <span style={{ fontSize: '1.25rem' }} aria-hidden="true">{icon}</span>
                  <span
                    className={`chip ${chip.cls}`}
                    aria-label={`Status: ${chip.label}`}
                  >
                    {chip.label}
                  </span>
                </div>
                <p style={{ fontWeight: 500, fontSize: '0.9375rem', marginBottom: '0.25rem' }}>
                  {item.originalFilename}
                </p>
                <p className="text-muted text-sm">{formatTimestamp(item.capturedAt)}</p>
                <p className="text-muted text-xs" style={{ marginTop: '0.25rem' }}>
                  {item.custodyCount} {item.custodyCount === 1 ? 'action' : 'actions'} recorded
                </p>
                {!canView && (
                  <p className="text-muted text-xs" style={{ marginTop: '0.25rem' }}>
                    Not yet available for viewing
                  </p>
                )}
              </button>
            );
          })}

          {/* Export link */}
          <Link
            to={`/incidents/${incidentId}/export`}
            className="btn btn-ghost"
            style={{ textAlign: 'center', marginTop: '0.5rem' }}
          >
            📄 Generate legal export
          </Link>
        </div>
      )}

      {/* View modal */}
      {isModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Evidence viewer"
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            padding: '1rem', zIndex: 100,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div
            style={{
              background: 'var(--surface)',
              borderRadius: 'var(--radius)',
              padding: '1.25rem',
              width: '100%', maxWidth: '480px',
              maxHeight: '90dvh', overflow: 'auto',
            }}
          >
            {/* Loading */}
            {viewState.kind === 'loading' && (
              <div style={{ textAlign: 'center', padding: '2rem' }}>
                <div className="spinner" role="status" aria-label="Loading file…" />
                <p className="text-muted text-sm" style={{ marginTop: '1rem' }}>
                  Decrypting file…
                </p>
              </div>
            )}

            {/* Error */}
            {viewState.kind === 'error' && (
              <>
                <div className="banner banner-error" role="alert" style={{ marginBottom: '1rem' }}>
                  {viewState.message}
                </div>
                <button className="btn btn-ghost" onClick={closeModal}>Close</button>
              </>
            )}

            {/* Viewing */}
            {viewState.kind === 'viewing' && (
              <>
                <div className="row-between" style={{ marginBottom: '1rem' }}>
                  <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>{viewState.filename}</p>
                  <button
                    className="btn btn-ghost"
                    style={{ width: 'auto', padding: '0.25rem 0.75rem' }}
                    onClick={closeModal}
                    aria-label="Close viewer"
                  >
                    ✕
                  </button>
                </div>

                {/* Render by MIME type */}
                {viewState.mimeType.startsWith('image/') && (
                  <img
                    src={viewState.objectUrl}
                    alt={viewState.filename}
                    style={{ width: '100%', borderRadius: 'var(--radius-sm)' }}
                  />
                )}
                {viewState.mimeType.startsWith('video/') && (
                  <video
                    ref={videoRef}
                    src={viewState.objectUrl}
                    controls
                    style={{ width: '100%', borderRadius: 'var(--radius-sm)' }}
                  />
                )}
                {viewState.mimeType.startsWith('audio/') && (
                  <audio
                    ref={audioRef}
                    src={viewState.objectUrl}
                    controls
                    style={{ width: '100%' }}
                  />
                )}
                {viewState.mimeType === 'application/pdf' && (
                  <iframe
                    src={viewState.objectUrl}
                    title={viewState.filename}
                    style={{ width: '100%', height: '60dvh', border: 'none' }}
                  />
                )}
                {/* Fallback: download link for unsupported display types */}
                {!viewState.mimeType.startsWith('image/') &&
                  !viewState.mimeType.startsWith('video/') &&
                  !viewState.mimeType.startsWith('audio/') &&
                  viewState.mimeType !== 'application/pdf' && (
                  <a
                    href={viewState.objectUrl}
                    download={viewState.filename}
                    className="btn btn-primary"
                    style={{ textAlign: 'center', display: 'block' }}
                  >
                    Download {viewState.filename}
                  </a>
                )}

                <p className="text-muted text-xs" style={{ marginTop: '1rem', textAlign: 'center' }}>
                  Decrypted view — not cached. Closing this dialog permanently clears the file from memory.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
