import { useEffect, useState } from 'react'

/**
 * A one-time offer of faster settings on built-in graphics.
 *
 * Shown when the 3D view draws on a built-in chip while the app asked for the
 * high-performance one — so the machine has no dedicated card. (Someone who
 * picked Power saving on a laptop with both chose the chip themselves.)
 * Measured on an Intel Arc, West Ronfaure (2026-10-23): 67% render resolution
 * took it from 103 to 170 fps, and ambient occlusion was the costliest effect.
 * Asked once (localStorage), whatever the answer.
 */

const KEY = 'ffxi-explorer.igpuOffered'

/** Built-in graphics, from the WebGL renderer string ANGLE reports. */
export function isBuiltInGpu(renderer: string): boolean {
  if (/NVIDIA|GeForce|Quadro|Radeon\s*(RX|Pro)|Arc\(TM\)\s*A\d|Arc\s*A\d/i.test(renderer)) return false
  return /Intel|UHD|Iris|Radeon\(TM\)\s*Graphics|Radeon\s*Graphics|Radeon\s*\d{3}M|Vega\s*\d+\s*Graphics|Apple/i.test(renderer)
}

function rendererName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    const raw = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return raw
  } catch {
    return ''
  }
}

export function GpuSuggestion({ onApply }: { onApply: () => void }) {
  const [card, setCard] = useState<string | null>(null)
  useEffect(() => {
    try { if (localStorage.getItem(KEY)) return } catch { return }
    let cancelled = false
    window.ffxi.gpu?.().then(pref => {
      if (cancelled || pref.atLaunch !== 'high-performance') return
      const raw = rendererName()
      if (!isBuiltInGpu(raw)) return
      setCard(raw.match(/^ANGLE \([^,]+, (.+?)(?: \(0x[0-9a-f]+\))? Direct3D/i)?.[1] ?? raw)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  if (!card) return null
  const close = (apply: boolean) => {
    try { localStorage.setItem(KEY, apply ? 'applied' : 'declined') } catch { /* asked again next time */ }
    if (apply) onApply()
    setCard(null)
  }
  return (
    <div className="modal-backdrop" onClick={() => close(false)}>
      <div className="modal update-notice" onClick={e => e.stopPropagation()}>
        <h2>Use faster settings?</h2>
        <p className="update-notes">
          This computer draws with built-in graphics ({card}). Two settings make a big
          difference there: a render resolution of 67%, which nearly doubles the frame
          rate for a slightly softer picture, and Fast ambient occlusion, the most
          demanding effect. You can change either any time, under Interface and
          Post-processing.
        </p>
        <div className="update-actions">
          <button className="primary" onClick={() => close(true)}>Use faster settings</button>
          <button onClick={() => close(false)}>Keep current settings</button>
        </div>
      </div>
    </div>
  )
}
