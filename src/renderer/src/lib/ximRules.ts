/**
 * Two particle rules read from xim (format reference only), found while
 * making the footprint show (HANDOFF, footsteps stage 3), and on everywhere
 * since 2026-10-22 after Ryan judged the before/after (Castle Zvahl's torches
 * show their flames inside a smaller halo; Bastok's window glows line up;
 * La Theine's crag circle glows). ?ximrules=0 turns them off again, for
 * comparison.
 *
 * 1. A colour or alpha life curve starts from the particle's own value (its
 *    tint), not from the curve's first point (xim ProgressValueUpdater's
 *    initialValueFn, opcodes 0x18-0x1B).
 * 2. Setup flag 0x0200 rotates Z-Y-X; without it, X-Y-Z
 *    (StandardParticleConfiguration.rotationOrder).
 */
export const XIM_RULES = typeof window === 'undefined' ||
  new URLSearchParams(window.location.search).get('ximrules') !== '0'

/** The Euler order for a particle's rotation (rule 2), or always Z-Y-X. */
export function rotationOrder(billboard: number, apply = XIM_RULES): 'XYZ' | 'ZYX' {
  return apply && !(billboard & 0x0200) ? 'XYZ' : 'ZYX'
}

/** The first value a life curve starts from (rule 1): the tint byte on the /255 scale. */
export function curveStart(tintByte: number, apply = XIM_RULES): number | undefined {
  return apply ? tintByte / 255 : undefined
}
