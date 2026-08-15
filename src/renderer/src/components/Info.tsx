import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'

/**
 * The lowercase "i" in a circle that explains the setting beside it, and the
 * popup it opens on hover.
 *
 * These descriptions used to be paragraphs under the controls, which is why
 * only some settings had one — every extra note made the panel longer. On hover
 * they cost no space, so every control can carry one.
 *
 * Shared by both panels: the model viewer's panel exists to mirror the zone
 * one, so the two must explain themselves the same way.
 */

/**
 * The popup itself, rendered into `document.body`.
 *
 * A portal rather than a child of the control, because the panels scroll:
 * `overflow-y: auto` clips anything that leaves the box, so a popup positioned
 * inside the panel is cut off at its edges. Fixed positioning off the icon's
 * own rect has no such constraint.
 */
function InfoPopup({ anchor, hostLeft, text }: { anchor: DOMRect; hostLeft: number; text: string }) {
  const WIDTH = 260
  // Opens to the left of the whole panel rather than of the icon, so it never
  // covers the setting it is explaining or its neighbours. Falls back to the
  // right of the icon only if the window is too narrow for that.
  const left = hostLeft - WIDTH - 10 >= 8
    ? hostLeft - WIDTH - 10
    : Math.min(anchor.right + 10, window.innerWidth - WIDTH - 8)
  // Kept clear of both edges. The estimate is deliberately generous: these are
  // one or two sentences at 11px in a 260px column, so ~150px is the ceiling.
  const top = Math.min(Math.max(8, anchor.top - 8), Math.max(8, window.innerHeight - 150))
  return (
    <div className="info-pop" style={{ left, top, width: WIDTH }} role="tooltip">
      {text}
    </div>
  )
}

export function Info({ text }: { text: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [hostLeft, setHostLeft] = useState(0)
  const ref = useRef<HTMLSpanElement>(null)

  const open = () => {
    const el = ref.current
    if (!el) return
    setAnchor(el.getBoundingClientRect())
    // The panel is the thing the popup must clear; fall back to the icon if
    // this ever gets used outside one.
    const host = el.closest('.panel') ?? el
    setHostLeft(host.getBoundingClientRect().left)
  }

  return (
    <>
      <span
        ref={ref}
        className="info"
        tabIndex={0}
        role="button"
        aria-label={text}
        onMouseEnter={open}
        onMouseLeave={() => setAnchor(null)}
        onFocus={open}
        onBlur={() => setAnchor(null)}
        // Every icon sits inside a <label>, and clicking a label activates its
        // control — without this, reaching for an explanation would toggle the
        // setting it explains.
        onClick={e => { e.preventDefault(); e.stopPropagation() }}
      >
        i
      </span>
      {anchor && createPortal(
        <InfoPopup anchor={anchor} hostLeft={hostLeft} text={text} />, document.body)}
    </>
  )
}

/** A control's name, with its info icon. */
export function Label({ text, info }: { text: string; info?: string }) {
  return (
    <span className="control-label">
      {text}
      {info && <Info text={info} />}
    </span>
  )
}
