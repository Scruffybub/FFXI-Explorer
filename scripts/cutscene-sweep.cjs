/**
 * The scene sweep: runs every event of every zone headless through the
 * cutscene player (lib/cutsceneSweep.ts, window.__sweep) and writes what it
 * couldn't play.
 *
 *   1. Start the app with a debugging port and the census switch:
 *        npx electron . --remote-debugging-port=9335
 *      then open out/renderer/index.html?census=1 in it (the harness does).
 *   2. node scripts/cutscene-sweep.cjs 9335 <outDir> [zoneId...]
 *
 * Writes <outDir>/rows.jsonl (one line per zone: its rows; a rerun skips
 * zones already there) and <outDir>/report.json (counts by result and by
 * note, the zones and scenes each note touches). Scene names, when
 * resources/scene-names.json has them, go into the report beside each one.
 */
const fs = require('fs')
const path = require('path')

const [port, outDir = 'cutscene-sweep', ...only] = process.argv.slice(2)
if (!port) { console.error('usage: node scripts/cutscene-sweep.cjs <port> <outDir> [zoneId...]'); process.exit(1) }
const onlyIds = only.map(Number).filter(Number.isFinite)
fs.mkdirSync(outDir, { recursive: true })
const rowsFile = path.join(outDir, 'rows.jsonl')

const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'ffxi-zone-viewer', 'settings.json'), 'utf8'))
const root = settings.ffxiPath
const csv = fs.readFileSync(path.join(__dirname, '..', 'resources', 'zone-seed-data.csv'), 'utf8').split(/\r?\n/).slice(1)
const zones = csv.map(l => l.split(',')).filter(f => /DAT$/.test(f[f.length - 2] || '')).map(f => ({ id: Number(f[0]), name: f[1] }))

async function page() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const p = list.find(x => x.type === 'page')
  const ws = new WebSocket(p.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r))
  // Node doesn't wait on a socket alone: keep the process up, and say so if the app goes away.
  const keep = setInterval(() => {}, 1000)
  let closing = false
  ws.addEventListener('close', () => { clearInterval(keep); if (!closing) { console.error('the app closed the connection'); process.exit(2) } })
  let id = 0
  const call = (method, params = {}) => new Promise(res => {
    const my = ++id
    const on = ev => { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener('message', on); res(m) } }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id: my, method, params }))
  })
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'error')
    return r.result?.result?.value
  }
  return { evaluate, close: () => { closing = true; clearInterval(keep); ws.close() } }
}

;(async () => {
  const done = new Set(fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).zone) : [])
  const p = await page()
  const todo = zones.filter(z => (!onlyIds.length || onlyIds.includes(z.id)) && !done.has(z.id))
  const started = Date.now()
  for (const [i, z] of todo.entries()) {
    const t0 = Date.now()
    let rows
    try {
      rows = await p.evaluate(`window.__sweep(${JSON.stringify(root)}, ${z.id})`)
    } catch (err) {
      rows = [{ actor: 0, id: -1, lines: 0, cinematic: false, result: 'crash', time: 0, notes: ['zone: ' + String(err.message).slice(0, 200)] }]
    }
    fs.appendFileSync(rowsFile, JSON.stringify({ zone: z.id, name: z.name, rows }) + '\n')
    const bad = rows.filter(r => r.result !== 'ended' && r.result !== 'menu').length
    console.log(`${i + 1}/${todo.length} ${z.name}: ${rows.length} events, ${bad} not clean, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  }
  p.close()
  await new Promise(r => setTimeout(r, 100))
  console.log(`swept in ${((Date.now() - started) / 60000).toFixed(1)} min`)
  report()
})().catch(err => { console.error(err); process.exit(1) })

function report() {
  const namesFile = path.join(__dirname, '..', 'resources', 'scene-names.json')
  const names = fs.existsSync(namesFile) ? JSON.parse(fs.readFileSync(namesFile, 'utf8')).scenes : {}
  const byResult = {}, byNote = {}, cinematic = {}
  let total = 0
  for (const line of fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean)) {
    const z = JSON.parse(line)
    for (const r of z.rows) {
      total++
      byResult[r.result] = (byResult[r.result] ?? 0) + 1
      if (r.cinematic) cinematic[r.result] = (cinematic[r.result] ?? 0) + 1
      for (const n of r.notes) {
        // Group by kind and detail; keep a few examples of each.
        const e = byNote[n] ??= { count: 0, cinematic: 0, zones: new Set(), examples: [] }
        e.count++
        if (r.cinematic) e.cinematic++
        e.zones.add(z.name)
        if (e.examples.length < 6) e.examples.push(`${z.name} ${r.actor === 0x7ffffff0 ? 'zone' : 'NPC ' + (r.actor & 0xfff)} #${r.id}${names[`${z.zone}:${r.id}`] ? ' (' + names[`${z.zone}:${r.id}`][0] + ')' : ''}`)
      }
    }
  }
  const notes = Object.entries(byNote).sort((a, b) => b[1].cinematic - a[1].cinematic || b[1].count - a[1].count)
    .map(([note, e]) => ({ note, count: e.count, cinematic: e.cinematic, zones: e.zones.size, examples: e.examples }))
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ total, byResult, cinematicByResult: cinematic, notes }, null, 1))
  console.log({ total, byResult, cinematicByResult: cinematic })
  console.log('top notes (by cinematic scenes):')
  for (const n of notes.slice(0, 30)) console.log(`  ${n.cinematic}/${n.count}  ${n.note}  (${n.zones} zones) e.g. ${n.examples[0]}`)
}
