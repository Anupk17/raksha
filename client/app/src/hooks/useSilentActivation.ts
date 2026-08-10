import { useEffect, useRef } from 'react'
import { registerPlugin } from '@capacitor/core'
import { EarbudSubDetector, ShakeSubDetector, TriggerDetector } from '@sa/triggerDetector'
import type { ShakeBridgeInterface } from '@sa/triggerDetector'
import type { CountdownManager } from '@sa/countdownManager'
import type { SilentActivationConfig } from '@sa/activationConfig'

// Register the native Capacitor ShakeBridge plugin once at module load.
// On web/browser, this resolves to a no-op stub that rejects its promises,
// causing ShakeSubDetector to fall back to DeviceMotion automatically.
const ShakeBridge = registerPlugin<ShakeBridgeInterface>('ShakeBridge')

interface UseSilentActivationOptions {
  config: SilentActivationConfig | null
  onTrigger: (triggeredAt: Date, type: 'earbud' | 'shake') => void | Promise<void>
}

/**
 * Wires native earbud and shake detection into the trigger flow.
 * Both detectors share a single TriggerDetector for mutual exclusion —
 * if either fires while a countdown is active, the second trigger is dropped.
 */
export function useSilentActivation({
  config,
  onTrigger,
}: UseSilentActivationOptions): void {
  const onTriggerRef = useRef(onTrigger)

  useEffect(() => {
    onTriggerRef.current = onTrigger
  }, [onTrigger])

  useEffect(() => {
    const earbudEnabled = config?.earbudEnabled ?? false
    const shakeEnabled  = config?.shakeEnabled  ?? false

    if (!earbudEnabled && !shakeEnabled) return

    const countdownManager = {
      start: (type: string, firedAt: Date, onComplete: () => void) => {
        const t = (type === 'shake' ? 'shake' : 'earbud') as 'earbud' | 'shake'
        void Promise.resolve(onTriggerRef.current(firedAt, t)).finally(onComplete)
      },
    }

    const triggerDetector = new TriggerDetector(countdownManager as CountdownManager)

    const earbudDetector = earbudEnabled
      ? new EarbudSubDetector({ triggerDetector })
      : null

    const shakeDetector = shakeEnabled
      ? new ShakeSubDetector({
          triggerDetector,
          bridge: ShakeBridge,
          sensitivity: config?.shakeSensitivity ?? 2,
        })
      : null

    return () => {
      earbudDetector?.destroy()
      shakeDetector?.destroy()
    }
  }, [config?.earbudEnabled, config?.shakeEnabled, config?.shakeSensitivity])
}
