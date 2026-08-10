import React from 'react'

interface State { hasError: boolean; message: string }

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(err: unknown): State {
    return {
      hasError: true,
      message: err instanceof Error ? err.message : 'Unknown error',
    }
  }

  override componentDidCatch(err: unknown, info: React.ErrorInfo) {
    // In dev, log; in prod this would go to an error-reporting service
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary]', err, info)
    }
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="screen-centered" style={{ textAlign: 'center', gap: '1rem' }}>
          <p style={{ fontSize: '2rem' }}>⚠️</p>
          <h1>Something went wrong</h1>
          <p className="text-muted">
            {import.meta.env.VITE_USE_EMULATOR === 'true'
              ? this.state.message
              : 'An unexpected error occurred. Please reload the app.'}
          </p>
          <button
            className="btn btn-ghost"
            style={{ maxWidth: '200px' }}
            onClick={() => window.location.reload()}
          >
            Reload app
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
