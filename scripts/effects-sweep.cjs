/**
 * Loads every zone at night and looks for what Zone effects does wrong — the
 * faults Ryan found by eye in Bastok (2026-10-10): water layers that turned
 * white or lavender, or flashed through colours, once effects were on.
 *
 * Per zone, Effect distance Everywhere, two views — the default overview and
 * a close look at the busiest cluster of effects — and in each, five captures:
 * water and effects off (W); Generator water on (A), again 0.7 s later (A2);
 * Zone effects on as well (B), again a second later (C).
 *
 *   wBright   share brightened by > 60 levels by Generator water (W->A):
 *             water should darken or keep the ground's tone; Bastok's fountain
 *             went milk-white this way (?untex=white reproduces it).
 *   wFlicker  share that moves by > 48 levels A->A2: a water layer flashing.
 *   changed   share of the picture whose brightness moves by > 48 levels A->B.
 *             Lamps and flames light small spots; a wash over a canal is wide.
 *   bright    share brightened by > 60 levels A->B: lamps light small spots.
 *   flicker   share that moves by > 48 levels B->C. Particles move; a sheet
 *             that flashes moves everywhere at once.
 *   fps       frames per second with the effects on, over two seconds.
 *
 *   npx electron scripts/effects-sweep.cjs <outDir> [shard/of] [zoneId...]
 *
 * Writes <outDir>/results.jsonl (one line per zone; a rerun skips zones already
 * there) and, per view, W|A|B side by side in <outDir>/img. Needs ?census=1
 * (__setScene, __view, __zoneData, __zfx, __camTo).
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
const TIME = Number(process.env.SWEEP_TIME || 0)
const EXTRA = process.env.SWEEP_EXTRA || ''
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
  // The busiest cluster of the zone's own auto-run effects: the generator
  // with the most others within 40 units, seen from 12 up and 30 across
  // (higher put the camera above indoor ceilings).
  const hotspot = () => js(`(() => {
    const z = window.__zoneData
    const fx = (z.spawns || []).filter(sp => sp.emission.autoRun && sp.attach === 0 && !sp.followCamera &&
      !/(^|\\/)weat(\\/|$)/.test(sp.dir) && (sp.link === 'mesh' || sp.link === 'sprite') && Math.hypot(...sp.position) > 1)
    if (!fx.length) return null
    const P = fx.map(sp => [sp.position[0], -sp.position[1], -sp.position[2]])
    let best = 0, bi = 0
    const step = Math.max(1, Math.floor(P.length / 400))
    for (let i = 0; i < P.length; i += step) {
      let n = 0
      for (const q of P) if (Math.hypot(q[0] - P[i][0], q[1] - P[i][1], q[2] - P[i][2]) < 40) n++
      if (n > best) { best = n; bi = i }
    }
    return { at: P[bi], n: best, gen: fx[bi].generator, dir: fx[bi].dir }
  })()`)
  const fps = () => js(`new Promise(r => { const t0 = performance.now(); let n = 0
    const tick = now => { n++; if (now - t0 < 2000) requestAnimationFrame(tick); else r(+(n / (now - t0) * 1000).toFixed(1)) }
    requestAnimationFrame(tick) })`)

  /** W, A, A2, B, C for the current camera. */
  const measure = async (zoneId, name) => {
    await js(`window.__setScene({ zoneEffects: false, generatorWater: false })`)
    await wait(2500)
    const W = await capture()
    await js(`window.__setScene({ generatorWater: true })`)
    // Turning Generator water on rebuilds the zone; Dynamis - Valkurm took
    // over four seconds, and a fixed wait captured it half built. Wait for
    // the mesh count to hold still for 1.5 s, after at least 3 s (at most 20 s).
    await wait(3000)
    let last = -1, still = 0
    for (let t = 0; t < 34 && still < 3; t++) {
      await wait(500)
      const n = await js(`(window.__zoneMeshes || []).length`, -1)
      still = n === last ? still + 1 : 0
      last = n
    }
    await wait(1500)
    const A = await capture()
    await wait(700)
    const A2 = await capture()
    await js(`window.__setScene({ zoneEffects: true })`)
    await wait(3000)
    const B = await capture()
    const rate = await fps()
    await wait(500)
    const C = await capture()
    const w = lumOf(W), a = lumOf(A), a2 = lumOf(A2), b = lumOf(B), c = lumOf(C)
    await fs.writeFile(join(outDir, 'img', `${zoneId}-${name}.jpg`), strip([W, A, B]).toJPEG(80))
    const fx = await js(`(() => { const s = window.__zfx || []; return { systems: s.length,
      meshes: s.filter(x => x.spawn.link === 'mesh').length, drawn: s.reduce((n, x) => n + x.mesh.count, 0) } })()`)
    return {
      view: name,
      wBright: share(w, a, (x, y) => y - x > 60),
      wFlicker: share(a, a2, (x, y) => Math.abs(x - y) > 48),
      changed: share(a, b, (x, y) => Math.abs(x - y) > 48),
      bright: share(a, b, (x, y) => y - x > 60),
      flicker: share(b, c, (x, y) => Math.abs(x - y) > 48),
      fps: rate, ...fx,
    }
  }

  for (const zone of zones) {
    const t0 = Date.now()
    errors = []
    const rec = { id: zone.id, name: zone.name, views: [] }
    try {
      if (!existsSync(join(root, ...zone.model.split('/')))) rec.skipped = 'model file not installed'
      else {
        const view = await open(`zone=${zone.id}&census=1&scene_zoneWeather=false&scene_timeOfDay=${TIME}` +
          `&scene_generatorWater=true&scene_zoneEffects=false&scene_effectRange=0${EXTRA}`)
        if (!view || view.error) rec.skipped = 'did not load'
        else {
          rec.views.push(await measure(zone.id, 'over'))
          const h = await hotspot()
          if (h && h.at) {
            rec.hotspot = h
            await js(`window.__setScene({ zoneEffects: false }); window.__camTo([${h.at[0] + 22}, ${h.at[1] + 12}, ${h.at[2] + 22}], [${h.at.join(',')}])`)
            rec.views.push(await measure(zone.id, 'hot'))
          }
        }
      }
    } catch (e) { rec.failed = String(e && e.stack || e) }
    rec.errors = [...new Set(errors)].slice(0, 10)
    rec.ms = Date.now() - t0
    await fs.appendFile(resultsPath, JSON.stringify(rec) + '\n')
    console.log(`${zone.id} ${zone.name}: ${rec.skipped || rec.views.map(v => `${v.view} wB ${v.wBright} wF ${v.wFlicker} chg ${v.changed} brt ${v.bright} flk ${v.flicker} ${v.fps}fps`).join(' | ')}` +
      `${rec.errors.length ? ' ERRORS ' + rec.errors.length : ''} (${(rec.ms / 1000).toFixed(0)}s)`)
  }
  app.exit(0)
})
dialog.showErrorBox = (t, c) => console.log('DIALOG: ' + t + ' - ' + c)
