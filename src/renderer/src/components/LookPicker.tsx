import type { CSSProperties } from 'react'
import { UI_LOOKS, classicVars, type ClassicKit, type UiLook } from '../lib/uiLook'

/**
 * Shown once, on the very first launch: every look as a card drawn in that
 * look, so the choice is made by eye. Settings -> Interface changes it later.
 */
export default function LookPicker({
  kit, kitFailed, onPick,
}: {
  kit: ClassicKit | null
  kitFailed: boolean
  onPick: (look: UiLook) => void
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal look-picker">
        <h2>Choose a look</h2>
        <p>
          Classic uses the game's own menu art and font, in any of its eight window styles. Modern is a
          clean, high-resolution style. You can change this any time under Interface in the settings panel,
          where Classic windows can also use the Modern font.
        </p>
        {!kit && !kitFailed && <p>Reading the game's menu art…</p>}
        {kitFailed && <p>The game's menu art could not be read from this install, so only Modern is available.</p>}
        <div className="look-grid">
          {UI_LOOKS.map(({ id, name }) => {
            const n = id.startsWith('classic') ? Number(id.slice(7)) : 0
            const ready = !n || !!kit
            const style = (n && kit ? classicVars(kit.styles[n - 1]) : {}) as CSSProperties
            return (
              <button
                key={id}
                className={`look-card ${n ? 'classic' : 'modern'}${ready ? '' : ' disabled'}`}
                style={style}
                disabled={!ready}
                onClick={() => onPick(id)}
              >
                <span className="look-name">{n ? `Window ${n}` : 'Modern'}</span>
                <span className="look-sample">Zone weather</span>
                <span className="look-sample">{name.startsWith('Classic') ? 'Classic' : 'High resolution'}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
