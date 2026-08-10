/**
 * LegalExportScreen — generate a court-ready PDF export for an incident.
 *
 * EXPORT STATE MACHINE:
 *   idle → generating → done | error
 *
 * PDF DELIVERY: window.location.href = data:application/pdf;base64,…
 * This causes Android to intercept the navigation and open the system PDF
 * viewer (or share sheet), which lets the user save/share the file.
 * window.open() and <a download> are both silently blocked in the Capacitor
 * WebView; the data URL navigation is the only approach that works without
 * extra Capacitor plugins.
 *
 * Design: §Screen 3: LegalExportScreen
 * Requirements: 3.1–3.9
 */
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { httpsCallable } from 'firebase/functions';
import { Capacitor } from '@capacitor/core';
import { fns } from '../firebase';

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type ExportState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'done'; pdfBase64: string; generatedAt: Date }
  | { kind: 'error'; message: string; errorCode?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openPdf(pdfBase64: string) {
  if (Capacitor.isNativePlatform()) {
    // Native Android: use PdfOpenerPlugin which writes to cache and fires
    // ACTION_VIEW via FileProvider — the only approach that works in a
    // Capacitor WebView without extra npm packages.
    const { Plugins } = Capacitor as unknown as { Plugins: Record<string, { open: (args: { base64: string; filename: string }) => Promise<void> }> };
    void Plugins['PdfOpener']?.open({
      base64: pdfBase64,
      filename: `raksha-export-${Date.now()}.pdf`,
    });
  } else {
    // Web/desktop: standard blob download
    const binaryStr = atob(pdfBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `raksha-export-${Date.now()}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function parseExportError(err: unknown): { message: string; errorCode?: string } {
  const code = (err as { code?: string }).code ?? '';
  const rawMsg = (err as { message?: string }).message ?? '';

  if (code === 'functions/not-found') {
    return { message: 'No evidence available for this incident.', errorCode: code };
  }
  if (code === 'functions/permission-denied' || code === 'functions/unauthenticated') {
    return { message: 'You do not have permission to export this evidence.', errorCode: code };
  }
  if (code === 'functions/internal') {
    const match = rawMsg.match(/Failed to fetch evidence file for (.+)/);
    if (match) {
      return {
        message: `Export failed — evidence file could not be accessed: ${match[1]}. Try again in a moment.`,
        errorCode: code,
      };
    }
    return { message: 'Export failed due to a server error. Try again in a moment.', errorCode: code };
  }
  if (import.meta.env.VITE_USE_EMULATOR === 'true') {
    return { message: `Export failed (${code}: ${rawMsg})`, errorCode: code };
  }
  return { message: 'Export failed. Please try again.', errorCode: code };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LegalExportScreen() {
  const { incidentId } = useParams<{ incidentId: string }>();
  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' });

  async function handleGenerate() {
    if (!incidentId) return;
    setExportState({ kind: 'generating' });

    try {
      const fn = httpsCallable<{ incidentId: string }, { pdf: string }>(fns, 'generateLegalExport');
      const result = await fn({ incidentId });

      const pdfBase64 = result.data.pdf;
      setExportState({ kind: 'done', pdfBase64, generatedAt: new Date() });
      openPdf(pdfBase64);
    } catch (err) {
      const { message, errorCode } = parseExportError(err);
      setExportState({ kind: 'error', message, errorCode });
    }
  }

  function resetToIdle() {
    setExportState({ kind: 'idle' });
  }

  return (
    <div className="screen">
      {/* Nav */}
      <nav className="nav-bar">
        <span className="nav-logo">🛡️ RAKSHA</span>
        <div className="nav-links">
          {incidentId && (
            <Link to={`/incidents/${incidentId}/evidence`} className="nav-link">
              ← Evidence
            </Link>
          )}
          <Link to="/home" className="nav-link">Home</Link>
        </div>
      </nav>

      <h1 style={{ marginBottom: '0.5rem' }}>Legal Export</h1>
      <p className="text-muted text-sm" style={{ marginBottom: '1.75rem' }}>
        Generate a court-ready PDF package containing all evidence, metadata,
        and the complete chain-of-custody log for this incident.
      </p>

      {incidentId && (
        <p className="text-muted text-xs" style={{ marginBottom: '1.5rem' }}>
          Incident: {incidentId.slice(0, 8)}…
        </p>
      )}

      {/* Idle */}
      {exportState.kind === 'idle' && (
        <div className="card stack">
          <p className="text-muted text-sm">The export will include:</p>
          <ul className="text-muted text-sm" style={{ paddingLeft: '1.25rem', lineHeight: 1.8 }}>
            <li>All evidence files for this incident</li>
            <li>Metadata (type, timestamp, device, location hash)</li>
            <li>Chain-of-custody log per evidence item</li>
            <li>Integrity verification (SHA-256 hashes, status)</li>
          </ul>
          <p className="text-muted text-xs">
            This may take a few seconds. All files must be accessible — if any
            file is unavailable, the export will fail with an error.
          </p>
          <button
            className="btn btn-primary"
            onClick={() => void handleGenerate()}
            aria-label="Generate legal export PDF"
          >
            Generate Legal Export
          </button>
        </div>
      )}

      {/* Generating */}
      {exportState.kind === 'generating' && (
        <div className="card" style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
          <div className="spinner" role="status" aria-label="Generating export…" style={{ marginBottom: '1rem' }} />
          <p style={{ fontWeight: 500 }}>Generating export…</p>
          <p className="text-muted text-sm" style={{ marginTop: '0.5rem' }}>
            Decrypting and assembling all evidence files. This may take a few seconds.
          </p>
        </div>
      )}

      {/* Done */}
      {exportState.kind === 'done' && (
        <div className="stack">
          <div className="banner banner-info" role="status">
            ✓ Export generated — PDF opened in viewer.
          </div>
          <div className="card stack-sm">
            <p className="text-muted text-sm">
              Generated at: {exportState.generatedAt.toLocaleTimeString()}
            </p>
            <button
              className="btn btn-ghost"
              onClick={() => openPdf(exportState.pdfBase64)}
              aria-label="Open PDF again"
            >
              Open PDF again
            </button>
            <button
              className="btn btn-ghost"
              onClick={resetToIdle}
              aria-label="Generate a new export"
            >
              Generate new export
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {exportState.kind === 'error' && (
        <div className="stack">
          <div className="banner banner-error" role="alert">
            {exportState.message}
          </div>
          <button className="btn btn-ghost" onClick={resetToIdle}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
