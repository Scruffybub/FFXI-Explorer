/**
 * Version comparison for the update check.
 *
 * Split out of updates.ts so it can be tested without Electron — this one
 * function decides whether every user gets an update popup, and getting it
 * backwards would either nag people forever or never tell them anything.
 * `scripts/version-test.cjs` runs the cases.
 */

/** True when `candidate` is a later version than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = String(v).trim().replace(/^v/i, '').split('-', 2)
    const parts = core.split('.').map(n => parseInt(n, 10) || 0)
    while (parts.length < 3) parts.push(0)
    return { parts, hasPre: Boolean(pre) }
  }
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i]
  }
  // Same numbers: 1.0.0 is newer than 1.0.0-beta, and never the other way.
  return !a.hasPre && b.hasPre
}
