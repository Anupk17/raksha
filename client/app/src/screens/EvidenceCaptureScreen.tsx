/**
 * EvidenceCaptureScreen — attach photo/video/audio evidence to an active SOS session.
 *
 * STATE MACHINE (5 phases):
 *   idle       → user selects file
 *   hashing    → computing SHA-256 (brief, <1s typically)
 *   uploading  → captureEvidence running, progress bar visible
 *   success    → upload complete, navigate to Timeline after 2s
 *   error      → upload failed, show message + allow retry
 *
 * SECURITY: The client never writes to Firestore after initial document creation.
 * All status transitions go through Cloud Functions (reportUploadFailure, onEvidenceCreate).
 *
 * Design: §Screen 1: EvidenceCaptureScreen
 * Requirements: 1.1–1.10
 */
import { useState, useRef, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getCurrentHashedLocation } from '../hooks/useGeolocation';
import { captureEvidence } from '../lib/evidence/captureEvidence';
import { makeFirestoreAdapter, makeStorageAdapter, makeFunctionsAdapter } from '../utils/evidenceAdapters';

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type CapturePhase =
  | { kind: 'idle' }
  | { kind: 'hashing' }
  | { kind: 'uploading'; progressPct: number }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

// ---------------------------------------------------------------------------
// Web Crypto SHA-256 — matches captureEvidence signature
// ---------------------------------------------------------------------------

async function computeSHA256WebCrypto(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EvidenceCaptureScreen() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const incidentId = searchParams.get('incidentId');

  const [phase, setPhase] = useState<CapturePhase>({ kind: 'idle' });
  const evidenceIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // On success: show banner for 3s then go to Timeline. Keep the session ID in
  // URL so the user can get back to the SOS active screen via browser back.
  useEffect(() => {
    if (phase.kind === 'success' && incidentId) {
      const timer = setTimeout(() => navigate(`/incidents/${incidentId}/evidence`), 3000);
      return () => clearTimeout(timer);
    }
  }, [phase.kind, incidentId, navigate]);

  // ── No session guard ───────────────────────────────────────────────────
  if (!incidentId) {
    return (
      <div className="screen-centered">
        <p style={{ fontSize: '2rem', marginBottom: '1rem' }}>📎</p>
        <h1 style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>No active SOS session</h1>
        <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
          Start an SOS session first to attach evidence.
        </p>
        <Link to="/home" className="btn btn-ghost" style={{ maxWidth: '200px' }}>
          Go home
        </Link>
      </div>
    );
  }

  // ── File selection handler (shared by both camera and gallery inputs) ────
  async function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    // Generate stable evidenceId once
    if (!evidenceIdRef.current) {
      evidenceIdRef.current = crypto.randomUUID();
    }
    const evidenceId = evidenceIdRef.current;

    setPhase({ kind: 'hashing' });

    // Get GPS hash (or null on denial/timeout) — runs concurrently with hash
    const locationPromise = getCurrentHashedLocation();

    // Create adapters
    const firestoreAdapter = makeFirestoreAdapter();
    const storageAdapter = makeStorageAdapter((transferred, total) => {
      const pct = Math.round((transferred / total) * 100);
      setPhase({ kind: 'uploading', progressPct: pct });
    });
    const functionsAdapter = makeFunctionsAdapter();

    setPhase({ kind: 'uploading', progressPct: 0 });

    const location = await locationPromise;

    const metadata = {
      incidentId: incidentId!, // non-null: guarded by early return above
      capturedAt: new Date(),
      deviceInfo: navigator.userAgent.slice(0, 200),
      locationHash: location ? `${location.latHash},${location.lngHash}` : null,
      incidentContext: null,
    };

    try {
      const result = await captureEvidence(
        evidenceId,
        file,
        user!.uid,
        metadata,
        firestoreAdapter,
        storageAdapter,
        functionsAdapter,
        computeSHA256WebCrypto
      );

      if (result.success) {
        setPhase({ kind: 'success' });
      } else {
        setPhase({ kind: 'error', message: result.message });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setPhase({ kind: 'error', message: msg });
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const isIdle = phase.kind === 'idle';
  const disabled = !isIdle;

  return (
    <div className="screen">
      <h1 style={{ marginBottom: '0.5rem' }}>Add Evidence</h1>
      <p className="text-muted text-sm" style={{ marginBottom: '1.5rem' }}>
        Attach photo, video, or audio to incident <strong>{incidentId.slice(0, 8)}…</strong>
      </p>

      <div className="card stack-sm" style={{ marginBottom: '1.5rem' }}>
        {/* ── Camera button ──────────────────────────────────────────────
            Uses a separate input with capture="environment" so Android
            fires MediaStore.ACTION_IMAGE_CAPTURE directly. Kept as a
            separate element from the gallery input so the two activity
            result paths don't interfere with each other. */}
        <div style={{ position: 'relative' }}>
          <label
            htmlFor="evidence-camera"
            className="btn btn-primary"
            style={{
              display: 'block',
              textAlign: 'center',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
            }}
          >
            📷 Take photo / video
          </label>
          <input
            id="evidence-camera"
            type="file"
            accept="image/*,video/*"
            capture="environment"
            onChange={handleFileSelect}
            disabled={disabled}
            style={{
              position: 'absolute',
              inset: 0,
              opacity: 0,
              width: '100%',
              height: '100%',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          />
        </div>

        {/* ── Gallery / files button ─────────────────────────────────────
            No capture attribute — opens the system file picker / gallery.
            This is what works reliably when returning from a non-camera
            activity in the Capacitor WebView. */}
        <div style={{ position: 'relative' }}>
          <label
            htmlFor="evidence-file"
            className="btn btn-ghost"
            style={{
              display: 'block',
              textAlign: 'center',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
            }}
          >
            🖼️ Choose from gallery / files
          </label>
          <input
            ref={fileInputRef}
            id="evidence-file"
            type="file"
            accept="image/*,video/*,audio/*"
            onChange={handleFileSelect}
            disabled={disabled}
            style={{
              position: 'absolute',
              inset: 0,
              opacity: 0,
              width: '100%',
              height: '100%',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          />
        </div>

        <p className="text-muted text-xs" style={{ textAlign: 'center' }}>
          Photo, video, audio — max 100 MB
        </p>
      </div>

      {/* Progress indicator */}
      {phase.kind === 'hashing' && (
        <div className="banner banner-info" role="status">
          Computing file hash…
        </div>
      )}

      {phase.kind === 'uploading' && (
        <div style={{ marginBottom: '1.5rem' }}>
          <p className="text-muted text-sm" style={{ marginBottom: '0.5rem' }}>
            Uploading… {phase.progressPct}%
          </p>
          <div
            style={{
              width: '100%',
              height: '8px',
              background: 'var(--surface-3)',
              borderRadius: 'var(--radius-xs)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${phase.progressPct}%`,
                height: '100%',
                background: 'var(--accent-green)',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
        </div>
      )}

      {/* Success banner */}
      {phase.kind === 'success' && (
        <div className="banner banner-info" role="status">
          ✓ Evidence uploaded successfully. Redirecting to timeline…
        </div>
      )}

      {/* Error banner */}
      {phase.kind === 'error' && (
        <div className="banner banner-error" role="alert" style={{ marginBottom: '1rem' }}>
          {phase.message}
          <button
            className="btn btn-ghost"
            style={{ marginTop: '0.75rem', padding: '0.5rem 1rem', fontSize: '0.875rem' }}
            onClick={() => {
              setPhase({ kind: 'idle' });
              evidenceIdRef.current = null; // Generate new evidenceId on retry
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
          >
            Try again
          </button>
        </div>
      )}

      {/* Back link */}
      <Link
        to={`/incidents/${incidentId}/evidence`}
        className="btn btn-ghost"
        style={{ textAlign: 'center' }}
      >
        View evidence timeline
      </Link>
    </div>
  );
}
