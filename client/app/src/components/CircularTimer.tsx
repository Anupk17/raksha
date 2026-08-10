/**
 * CircularTimer — SVG ring countdown, 10 → 0 seconds.
 * Colour transitions from green (safe) to red (urgent) as time decreases.
 * Driven by secondsLeft prop — no internal state or animation timers.
 */

const RADIUS       = 45
const CIRCUMFERENCE = 2 * Math.PI * RADIUS  // ≈ 282.74

interface Props {
  secondsLeft: number  // 0–10
}

export function CircularTimer({ secondsLeft }: Props) {
  const fraction = secondsLeft / 10
  const offset   = CIRCUMFERENCE * (1 - fraction)

  // Interpolate hue: 120 (green) → 0 (red)
  const hue   = Math.round(120 * fraction)
  const color = `hsl(${hue}, 72%, 55%)`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
      <svg
        width="200"
        height="200"
        viewBox="0 0 100 100"
        style={{ filter: `drop-shadow(0 0 12px hsl(${hue}, 72%, 35%))` }}
        aria-label={`${secondsLeft} seconds remaining`}
        role="img"
      >
        {/* Background ring */}
        <circle
          cx="50" cy="50" r={RADIUS}
          fill="none"
          stroke="var(--surface-3)"
          strokeWidth="8"
        />
        {/* Progress ring */}
        <circle
          cx="50" cy="50" r={RADIUS}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          transform="rotate(-90 50 50)"
          style={{ transition: 'stroke-dashoffset 0.15s linear, stroke 0.5s ease' }}
        />
        {/* Seconds label */}
        <text
          x="50" y="50"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="24"
          fontWeight="700"
          fontFamily="Inter, system-ui, sans-serif"
          fill={color}
          style={{ transition: 'fill 0.5s ease' }}
        >
          {secondsLeft}
        </text>
      </svg>
    </div>
  )
}
