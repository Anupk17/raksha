/** TriggerRow — toggle + label row with an optional sub-control slot. */
interface Props {
  id: string
  label: string
  sublabel?: string
  checked: boolean
  onChange: (checked: boolean) => void
  children?: React.ReactNode
  /** If true: greyed out, non-interactive, shows "Coming soon" badge */
  comingSoon?: boolean
}

import React from 'react'

export function TriggerRow({ id, label, sublabel, checked, onChange, children, comingSoon }: Props) {
  return (
    <div className="stack-sm" style={comingSoon ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
      <label className="toggle-row" htmlFor={id} style={{ cursor: comingSoon ? 'default' : 'pointer' }}>
        <div className="toggle-info">
          <div className="toggle-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {label}
            {comingSoon && (
              <span style={{
                fontSize: '0.65rem',
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                background: 'var(--surface-3, #e5e5e5)',
                color: 'var(--text-muted, #888)',
                borderRadius: '4px',
                padding: '2px 6px',
                lineHeight: 1.4,
              }}>
                Coming soon
              </span>
            )}
          </div>
          {sublabel && <div className="toggle-sublabel">{sublabel}</div>}
        </div>
        <input
          id={id}
          type="checkbox"
          className="toggle"
          checked={comingSoon ? false : checked}
          onChange={(e) => { if (!comingSoon) onChange(e.target.checked) }}
          disabled={comingSoon}
          aria-disabled={comingSoon}
          tabIndex={comingSoon ? -1 : undefined}
        />
      </label>
      {!comingSoon && checked && children && (
        <div
          className="card-sm"
          style={{ marginTop: '-0.25rem', borderTop: 'none', borderRadius: '0 0 var(--radius-sm) var(--radius-sm)' }}
        >
          {children}
        </div>
      )}
    </div>
  )
}
