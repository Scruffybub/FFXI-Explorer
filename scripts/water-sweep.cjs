/**
 * Looks at every zone's Generator water up close, to take it out of beta.
 * The faults it hunts are the ones Ryan found by eye (2026-10-10): Bastok's
 * canals went lavender and flashed through colours, Windurst's and Port
 * Bastok's water went white or brown, Beaucedine's entrance grew a grey slab.
 *
 * Per zone, in daylight: the water bodies — DAT folders holding a scrolling
 * mesh, the biggest three by extent — each framed from above and to the side.
 * All views with Generator water off (W), then it is turned on once (the zone
 * rebuilds) and each view taken again (A) and 0.7 s later (A2).
 *
 *   bright    share brightened by > 60 levels W->A: water darkens or keeps
 *             the ground's tone; milk-white sheets brighten.
 *   violet    share that turns saturated purple / violet / magenta W->A:
 *             Bastok's lavender canals (hue 240-330, saturation > 0.35).
 *   flicker   share that moves by > 48 levels A->A2: a layer flashing.
 *   water     how many generator water meshes draw.
 *
 *   npx electron scripts/water-sweep.cjs <outDir> [shard/of] [zoneId...]
 *
 * Writes <outDir>/results.jsonl (a rerun skips zones already there) and per
 * view W|A side by side in <outDir>/img. Needs ?census=1 (__setScene,
 * __zoneData, __zoneMeshes, __camTo).
 */
const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron')
const { join } = require('path')
const { promises: fs, readFileSync, existsSync } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const outDir = process.argv[2] || 'effects-sweep'
const shardArg = /^\d+\/\d+$/.test(process.argv[3] || '') ? process.argv[3] : null
const onlyIds = process.argv.slice(shardArg ? 4 : 3).map(Number).filter(Number.isFinite)
const TIME = Number(process.env.SWEEP_TIME || 12)
// Extra query, read after the defaults (the last of a repeated key wins), so
// e.g. &scene_zoneWeather=true views the water under the zone's own lighting.
const EXTRA = process.env.SWEEP_EXTRA || ''
// SWEEP_BODIES: a file of page-side JS returning the views to take instead of
// the four widest bodies — [{ dir, kind, size, at, from? }] — for close-ups.
const BODIES = process.env.SWEEP_BODIES ? readFileSync(process.env.SWEEP_BODIES, 'utf8') : null
if (process.env.SWEEP_PROFILE) app.setPath('userData', process.env.SWEEP_PROFILE)

async function isValidFfxiDir(dir) {
  for (const e of ['ROM', 'ROM2', 'VTABLE.DAT']) {
    try { await fs.stat(join(dir, e)) } catch { return false }
  }
  return true
}
async function detectInstall() {
  for (const key of [
    'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnlineUS\\InstallFolder',
    'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnlineEU\\InstallFolder',
  ]) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/v', '0001'])
      const m = stdout.match(/REG_SZ\s+(.+)/)
      if (m) {
        const d = m[1].trim().replace(/[\\/]+$/, '')
        if (await isValidFfxiDir(d)) return d
      }
    } catch { /* next */ }
  }
  return 'C:\\FFXI-Data'
}

function splitCsvLine(line) {
  const out = []; let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
    else if (ch === ',' && !q) { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}
function zoneTable() {
  const lines = readFileSync(join(__dirname, '../resources/zone-seed-data.csv'), 'utf8').split(/\r?\n/).filter(l => l.trim())
  const h = splitCsvLine(lines[0])
  const zones = []
  for (const l of lines.slice(1)) {
    const f = splitCsvLine(l)
    const id = Number(f[h.indexOf('ID')]), name = (f[h.indexOf('NAME')] || '').trim(), model = (f[h.indexOf('MODEL')] || '').trim()
    if (!Number.isFinite(id) || !model || !name || name === 'unknown') continue
    zones.push({ id, name, model })
  }
  return zones.sort((a, b) => a.name.localeCompare(b.name))
}

/** Brightness per pixel of a capture shrunk to 240 wide. */
function lumOf(img) {
  const s = img.resize({ width: 240 })
  const { width: W, height: H } = s.getSize(), b = s.toBitmap()
  const g = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) g[i] = Math.round(0.299 * b[i * 4 + 2] + 0.587 * b[i * 4 + 1] + 0.114 * b[i * 4])
  return g
}
/** RGB per pixel of a capture shrunk to 240 wide. */
function rgbOf(img) {
  const s = img.resize({ width: 240 })
  const b = s.toBitmap(), n = b.length / 4, out = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) { out[i * 3] = b[i * 4 + 2]; out[i * 3 + 1] = b[i * 4 + 1]; out[i * 3 + 2] = b[i * 4] }
  return out
}
/** Saturated purple, violet or magenta (hue 240-330), as Bastok's lavender canals. */
function violet(rgb, i) {
  const r = rgb[i * 3] / 255, g = rgb[i * 3 + 1] / 255, b = rgb[i * 3 + 2] / 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  if (mx < 0.15 || d / mx < 0.35) return false
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  h *= 60; if (h < 0) h += 360
  return h >= 240 && h <= 330
}
const share = (a, b, test) => {
  if (!a || !b || a.length !== b.length) return null
  let n = 0
  for (let i = 0; i < a.length; i++) if (test(a[i], b[i])) n++
  return +(n / a.length).toFixed(4)
}
/** Captures side by side, each 400 wide. */
function strip(imgs) {
  const bm = imgs.map(i => i.resize({ width: 400 }))
  const { width: w, height: h } = bm[0].getSize(), k = bm.length
  const out = Buffer.alloc(w * k * h * 4)
  bm.forEach((im, j) => {
    const b = im.toBitmap()
    for (let y = 0; y < h; y++) b.copy(out, (y * w * k + j * w) * 4, y * w * 4, (y + 1) * w * 4)
  })
  return nativeImage.createFromBitmap(out, { width: w * k, height: h })
}

const wait = ms => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async () => {
  const root = await detectInstall()
  ipcMain.handle('ffxi:autoDetect', () => root)
  ipcMain.handle('ffxi:pickDirectory', () => ({ status: 'cancelled' }))
  ipcMain.handle('ffxi:readDat', (_e, r, rel) => fs.readFile(join(r, ...rel.replace(/\\/g, '/').split('/'))))
  ipcMain.handle('ffxi:fileExists', async (_e, r, rel) => {
    try { await fs.stat(join(r, ...rel.replace(/\\/g, '/').split('/'))); return true } catch { return false }
  })
  await fs.mkdir(join(outDir, 'img'), { recursive: true })
  const resultsPath = join(outDir, 'results.jsonl')
  const done = new Set()
  if (existsSync(resultsPath)) for (const l of readFileSync(resultsPath, 'utf8').split('\n')) {
    try { done.add(JSON.parse(l).id) } catch { /* partial line */ }
  }

  let zones = zoneTable()
  if (onlyIds.length) zones = zones.filter(z => onlyIds.includes(z.id))
  if (shardArg) { const [k, n] = shardArg.split('/').map(Number); zones = zones.filter((_, i) => i % n === k) }
  zones = zones.filter(z => !done.has(z.id))
  console.log(`sweeping ${zones.length} zones from ${root}`)

  // Shown off-screen: a hidden window is throttled and particles barely move.
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false, backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  })
  win.setPosition(-3000, 0)
  win.showInactive()
  let errors = []
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(msg.slice(0, 300)) })
  win.webContents.on('render-process-gone', (_e, d) => errors.push('RENDERER GONE ' + JSON.stringify(d)))

  const js = (code, fallback = null) => win.webContents.executeJavaScript(code).catch(e => (fallback ?? { error: String(e) }))
  const canvasRect = async () => {
    const r = await js(`(() => { const c = document.querySelector('canvas'); if (!c) return null; const b = c.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } })()`)
    // Clear of the corner buttons and the zone label.
    return r && r.width ? { x: r.x + 10, y: r.y + 60, width: r.width - 20, height: r.height - 150 } : null
  }
  const capture = async () => win.webContents.capturePage((await canvasRect()) || undefined)
  const open = async (search) => {
    await win.loadFile(join(__dirname, '../out/renderer/index.html'), { search })
    for (let t = 0; t < 120; t++) {
      await wait(500)
      const ok = await js(`!!(window.__view && window.__zoneData && document.querySelector('canvas'))`, false)
      if (ok === true) { await wait(2500); return js(`window.__view`) }
      const failed = await js(`!!document.body.innerText.match(/contains no renderable geometry|Failed|Error reading/)`, false)
      if (failed === true) return null
    }
    return null
  }
  // What Generator water draws, by DAT folder: water (a folder with a
  // scrolling mesh, or a flat untextured colour sheet — Windurst's canals
  // scroll nothing) and the scenery models generators place (mode/,
  // Beaucedine's entrance). Each folder's meshes boxed in world space
  // (position + scale x the mesh's own box; rotation ignored); the four
  // widest kept, water first.
  const bodies = () => BODIES ? js(BODIES) : js(`(() => {
    const z = window.__zoneData
    const sp = (z.spawns || []).filter(s => s.link === 'mesh' && !/(^|\\/)weat(\\/|$)/.test(s.dir) && !s.followCamera)
    const scroll = new Set(sp.filter(s => s.uvScroll[0] || s.uvScroll[1]).map(s => s.dir))
    const sheet = pi => {
      const p = z.prefabs[pi]
      if (!p || !p.untextured) return false
      let y0 = 1e9, y1 = -1e9, h = 0
      const lo = [1e9, 1e9], hi = [-1e9, -1e9]
      for (let k = 0; k < p.vertices.length; k += 3) {
        y0 = Math.min(y0, p.vertices[k + 1]); y1 = Math.max(y1, p.vertices[k + 1])
        lo[0] = Math.min(lo[0], p.vertices[k]); hi[0] = Math.max(hi[0], p.vertices[k])
        lo[1] = Math.min(lo[1], p.vertices[k + 2]); hi[1] = Math.max(hi[1], p.vertices[k + 2])
      }
      h = Math.max(hi[0] - lo[0], hi[1] - lo[1])
      return y1 - y0 < 0.05 * h
    }
    const kind = new Map()
    for (const s of sp) {
      if (scroll.has(s.dir) || s.prefabIndices.some(sheet)) kind.set(s.dir, 'water')
      else if (/(^|\\/)mode(\\/|$)/.test(s.dir) && !kind.has(s.dir)) kind.set(s.dir, 'scenery')
    }
    const box = new Map()
    for (const s of sp) {
      if (!kind.has(s.dir)) continue
      for (const pi of s.prefabIndices) {
        const p = z.prefabs[pi]; if (!p) continue
        const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]
        for (let k = 0; k < p.vertices.length; k += 3) for (let c = 0; c < 3; c++) {
          lo[c] = Math.min(lo[c], p.vertices[k + c]); hi[c] = Math.max(hi[c], p.vertices[k + c])
        }
        const b = box.get(s.dir) || { lo: [1e9, 1e9, 1e9], hi: [-1e9, -1e9, -1e9], n: 0 }
        for (let c = 0; c < 3; c++) {
          const sign = c === 0 ? 1 : -1
          const x0 = sign * (s.position[c] + s.scale[c] * lo[c]), x1 = sign * (s.position[c] + s.scale[c] * hi[c])
          b.lo[c] = Math.min(b.lo[c], x0, x1); b.hi[c] = Math.max(b.hi[c], x0, x1)
        }
        b.n++
        box.set(s.dir, b)
      }
    }
    return [...box].map(([dir, b]) => ({ dir, kind: kind.get(dir), n: b.n, size: Math.max(b.hi[0] - b.lo[0], b.hi[2] - b.lo[2]),
      at: [0, 1, 2].map(c => (b.lo[c] + b.hi[c]) / 2) }))
      .filter(b => b.size > 0.5 && b.size < 20000)
      .sort((a, b) => (a.kind === b.kind ? b.size - a.size : a.kind === 'water' ? -1 : 1)).slice(0, 4)
  })()`)
  const aim = b => {
    if (b.from) return js(`window.__camTo([${b.from.join(',')}], [${b.at.join(',')}])`)
    const r = Math.min(250, Math.max(25, b.size * 0.6))
    return js(`window.__camTo([${b.at[0] + r * 0.7}, ${b.at[1] + Math.max(15, r * 0.45)}, ${b.at[2] + r * 0.7}], [${b.at.join(',')}])`)
  }
  // Turning Generator water on rebuilds the zone: wait for the mesh count to
  // hold still for 1.5 s, after at least 3 s (at most 20 s).
  const settle = async () => {
    await wait(3000)
    let last = -1, still = 0
    for (let t = 0; t < 34 && still < 3; t++) {
      await wait(500)
      const n = await js(`(window.__zoneMeshes || []).length`, -1)
      still = n === last ? still + 1 : 0
      last = n
    }
    await wait(1500)
  }

  for (const zone of zones) {
    const t0 = Date.now()
    errors = []
    const rec = { id: zone.id, name: zone.name, views: [] }
    try {
      if (!existsSync(join(root, ...zone.model.split('/')))) rec.skipped = 'model file not installed'
      else {
        const view = await open(`zone=${zone.id}&census=1&scene_zoneWeather=false&scene_timeOfDay=${TIME}` +
          `&scene_generatorWater=false&scene_zoneEffects=false${EXTRA}`)
        if (!view || view.error) rec.skipped = 'did not load'
        else {
          const list = await bodies()
          if (!list || !list.length) rec.skipped = 'no water'
          else {
            rec.bodies = list
            const W = []
            for (const b of list) { await aim(b); await wait(800); W.push(await capture()) }
            await js(`window.__setScene({ generatorWater: true })`)
            await settle()
            rec.water = await js(`(window.__zoneMeshes || []).filter(m => m.userData.generator && m.visible).length`, -1)
            for (const [k, b] of list.entries()) {
              await aim(b); await wait(1200)
              const A = await capture()
              await wait(700)
              const A2 = await capture()
              const w = lumOf(W[k]), a = lumOf(A), a2 = lumOf(A2), wc = rgbOf(W[k]), ac = rgbOf(A)
              await fs.writeFile(join(outDir, 'img', `${zone.id}-w${k}.jpg`), strip([W[k], A]).toJPEG(80))
              let vio = 0
              for (let i = 0; i < a.length; i++) if (violet(ac, i) && !violet(wc, i)) vio++
              rec.views.push({
                view: 'w' + k, dir: b.dir, kind: b.kind, size: Math.round(b.size),
                bright: share(w, a, (x, y) => y - x > 60),
                violet: +(vio / a.length).toFixed(4),
                flicker: share(a, a2, (x, y) => Math.abs(x - y) > 48),
              })
            }
          }
        }
      }
    } catch (e) { rec.failed = String(e && e.stack || e) }
    rec.errors = [...new Set(errors)].slice(0, 10)
    rec.ms = Date.now() - t0
    await fs.appendFile(resultsPath, JSON.stringify(rec) + '\n')
    console.log(`${zone.id} ${zone.name}: ${rec.skipped || rec.views.map(v => `${v.view} ${v.dir.split('/').slice(-1)[0]} brt ${v.bright} vio ${v.violet} flk ${v.flicker}`).join(' | ')}` +
      `${rec.errors.length ? ' ERRORS ' + rec.errors.length : ''} (${(rec.ms / 1000).toFixed(0)}s)`)
  }
  app.exit(0)
})
dialog.showErrorBox = (t, c) => console.log('DIALOG: ' + t + ' - ' + c)
