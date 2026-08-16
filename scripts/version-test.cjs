/**
 * Cases for the update check's version comparison.
 *
 *   node scripts/version-test.cjs
 *
 * This one function decides whether every user sees an update popup. Getting it
 * backwards either nags people who are current or never tells anyone about a
 * release, and neither shows up in a screenshot.
 *
 * The source is TypeScript with no imports, so it is stripped and evaluated
 * rather than built — this stays runnable without a build step.
 */
const fs = require('fs')
const { join } = require('path')
const vm = require('vm')

const src = fs.readFileSync(join(__dirname, '../src/main/version.ts'), 'utf8')
// Strip the type annotations this file uses: parameter/return types and the
// `export` keyword. Nothing here needs a real TypeScript compiler.
const js = src
  .replace(/export\s+function/g, 'function')
  .replace(/\(candidate:\s*string,\s*current:\s*string\)/g, '(candidate, current)')
  .replace(/\)\s*:\s*boolean\s*\{/g, ') {')
  .replace(/\(v:\s*string\)/g, '(v)')
const context = { module: {}, exports: {} }
vm.createContext(context)
vm.runInContext(js + '\n; this.isNewer = isNewer', context)
const { isNewer } = context

const cases = [
  // [candidate, current, expected]
  ['0.2.0', '0.1.0', true],
  ['v0.2.0', '0.1.0', true],          // tags carry a leading v
  ['0.1.1', '0.1.0', true],
  ['1.0.0', '0.9.9', true],
  ['0.10.0', '0.9.0', true],          // numeric, not lexical: "10" > "9"
  ['0.1.0', '0.1.0', false],          // same version must not nag
  ['0.1.0', '0.2.0', false],          // older release must never offer itself
  ['0.0.9', '0.1.0', false],
  ['0.1', '0.1.0', false],            // short forms pad with zeros
  ['0.2', '0.1.0', true],
  ['1.0.0', '1.0.0-beta', true],      // release beats its own pre-release
  ['1.0.0-beta', '1.0.0', false],
  ['1.0.0-beta', '0.9.0', true],
  ['garbage', '0.1.0', false],        // unparsable must not trigger an update
  ['', '0.1.0', false],
]

let failed = 0
for (const [candidate, current, expected] of cases) {
  const actual = isNewer(candidate, current)
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} isNewer(${JSON.stringify(candidate)}, ` +
    `${JSON.stringify(current)}) = ${actual}, expected ${expected}`)
}

console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exit(failed ? 1 : 0)
