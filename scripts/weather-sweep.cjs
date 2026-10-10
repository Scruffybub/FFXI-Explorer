/**
 * Loads every zone with Zone weather on and steps through each of its weathers,
 * looking for the faults Ryan has found by hand one zone at a time:
 *
 *  - stray weather or effect meshes drawn loose at the zone origin (Riverne's
 *    "bundle" of sky textures, 2026-10-04);
 *  - straight seams across the sky (the "stitches" of 2026-10-03 and Riverne's
 *    zigzag lines) — found by a straight-edge finder on sky-only captures;
 *  - sky layers whose texture does not resolve;
 *  - weathers that draw nothing at all, and weathers that look like another;
 *  - renderer errors.
 *
 *   npx electron scripts/weather-sweep.cjs <outDir> [shard/of] [zoneId...]
 *
 * Writes <outDir>/results.jsonl (one line per zone; a rerun skips zones already
 * there), an overview JPEG per zone and weather, and the sky captures it flags.
 * Needs the ?census=1 hooks (__setScene, __view, __sky, __wxp, __zoneMeshes).
 */
const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron')
const { join } = require('path')
const { promises: fs, readFileSync, existsSync } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const outDir = process.argv[2] || 'weather-sweep'
const shardArg = /^\d+\/\d+$/.test(process.argv[3] || '') ? process.argv[3] : null
const onlyIds = process.argv.slice(shardArg ? 4 : 3).map(Number).filter(Number.isFinite)
const TIME = Number(process.env.SWEEP_TIME || 12)
// Extra query for every load (e.g. &skyonly=cld1 to isolate one sky layer).
const EXTRA = process.env.SWEEP_EXTRA || ''
// A second sweep beside a running one needs its own profile, or the two
// fight over Chromium's cache and the newcomer never draws.
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

/**
 * Long straight sharp edges in a greyscale image (u16 W, u16 H, bytes). Cloud
 * textures are soft; a seam is a step of a few levels across one pixel that
 * runs straight for hundreds. Sobel on a 3x3 blur, a Hough vote along each
 * pixel's own gradient angle, then the longest well-filled run on each peak.
 * Kept only when sharp: the change within 1px of the line against the change
 * within 7px. Riverne's seams scored 0.8-1.1, cloud edges about 0.2.
 */
function findLines(W, H, gray) {
  const B = new Float32Array(W * H)
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    let s = 0
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += gray[(y + j) * W + x + i]
    B[y * W + x] = s / 9
  }
  const R = new Float32Array(W * H), D = new Uint8Array(W * H), M = 4
  for (let y = M; y < H - M; y++) for (let x = M; x < W - M; x++) {
    const p = (j, i) => B[(y + j) * W + x + i]
    const gx = (p(-1, 1) + 2 * p(0, 1) + p(1, 1)) - (p(-1, -1) + 2 * p(0, -1) + p(1, -1))
    const gy = (p(1, -1) + 2 * p(1, 0) + p(1, 1)) - (p(-1, -1) + 2 * p(-1, 0) + p(-1, 1))
    R[y * W + x] = Math.hypot(gx, gy) / 8
    let a = Math.atan2(gy, gx); if (a < 0) a += Math.PI; if (a >= Math.PI) a -= Math.PI
    D[y * W + x] = Math.min(179, Math.floor((a / Math.PI) * 180))
  }
  const mags = []
  for (let i = 0; i < R.length; i += 7) mags.push(R[i])
  mags.sort((a, b) => b - a)
  const T = Math.max(0.9, mags[Math.floor(mags.length * 0.03)] || 0)
  const NT = 180, diag = Math.ceil(Math.hypot(W, H)), A = new Int32Array(NT * 2 * diag)
  const cosT = new Float32Array(NT), sinT = new Float32Array(NT)
  for (let t = 0; t < NT; t++) { cosT[t] = Math.cos((t * Math.PI) / NT); sinT[t] = Math.sin((t * Math.PI) / NT) }
  for (let y = M; y < H - M; y++) for (let x = M; x < W - M; x++) {
    const i = y * W + x
    if (R[i] <= T) continue
    for (let dt = -6; dt <= 6; dt++) {
      const t = (D[i] + dt + NT) % NT
      const r = Math.round(x * cosT[t] + y * sinT[t]) + diag
      if (r >= 0 && r < 2 * diag) A[t * 2 * diag + r]++
    }
  }
  const cands = []
  for (let i = 0; i < A.length; i++) if (A[i] >= 50) cands.push(i)
  cands.sort((a, b) => A[b] - A[a])
  const lines = [], used = []
  for (const i of cands.slice(0, 300)) {
    const t = Math.floor(i / (2 * diag)), r = (i % (2 * diag)) - diag
    if (used.some(([t2, r2]) => Math.min(Math.abs(t2 - t), NT - Math.abs(t2 - t)) < 5 && Math.abs(r2 - r) < 15)) continue
    used.push([t, r])
    const dx = -sinT[t], dy = cosT[t], x0 = r * cosT[t], y0 = r * sinT[t]
    let run = 0, best = 0, gap = 0, hits = 0, bestHits = 0, bestEnd = 0
    for (let s = -diag; s < diag; s++) {
      const x = x0 + dx * s, y = y0 + dy * s
      if (x < M || y < M || x >= W - M || y >= H - M) { run = 0; gap = 0; hits = 0; continue }
      let hit = false
      for (let o = -2; o <= 2 && !hit; o++) {
        const xx = Math.round(x + cosT[t] * o), yy = Math.round(y + sinT[t] * o)
        if (R[yy * W + xx] > T) hit = true
      }
      if (hit) { run += 1 + gap; gap = 0; hits++ } else if (++gap > 8) { run = 0; gap = 0; hits = 0 }
      if (run > best) { best = run; bestHits = hits; bestEnd = s }
    }
    if (best < 100 || bestHits / best <= 0.6) continue
    let near = 0, far = 0, n = 0
    for (let s = bestEnd - best; s <= bestEnd; s += 2) {
      const x = x0 + dx * s, y = y0 + dy * s
      let bn = 0, bf = 0
      for (let o = -2; o <= 2; o++) {
        const at = k => {
          const xx = Math.round(x + cosT[t] * (o + k)), yy = Math.round(y + sinT[t] * (o + k))
          return xx < 0 || yy < 0 || xx >= W || yy >= H ? NaN : gray[yy * W + xx]
        }
        const a = Math.abs(at(1) - at(-1))
        if (a > bn) bn = a, bf = Math.max(Math.abs(at(7) - at(-7)), Math.abs(at(7) - at(0)), Math.abs(at(-7) - at(0)))
      }
      if (Number.isFinite(bn) && Number.isFinite(bf)) { near += bn; far += bf; n++ }
    }
    const step = n ? near / n : 0, sharp = far > 0 ? near / far : 0
    if (step >= 2 && sharp >= 0.5) lines.push({ deg: t, r, len: best, step: +step.toFixed(1), sharp: +sharp.toFixed(2) })
    if (lines.length >= 6) break
  }
  return { T: +T.toFixed(2), lines }
}

function grayOf(img) {
  const { width: W, height: H } = img.getSize(), b = img.toBitmap()
  const g = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) g[i] = Math.round(0.299 * b[i * 4 + 2] + 0.587 * b[i * 4 + 1] + 0.114 * b[i * 4])
  return { W, H, g }
}
/** Mean absolute difference of two same-size small images, in levels. */
function meanDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / a.length
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

  // Shown off-screen: a hidden window is throttled to ~1 fps, and weather
  // clocks, fades and particles then barely move between captures.
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
  // Diagnostic: SWEEP_LOG=<regex> prints matching renderer console lines.
  const logMatch = process.env.SWEEP_LOG ? new RegExp(process.env.SWEEP_LOG) : null
  if (logMatch) win.webContents.on('console-message', (_e, _l, msg) => { if (logMatch.test(msg)) console.log('LOG ' + msg.slice(0, 4000)) })
  win.webContents.on('render-process-gone', (_e, d) => errors.push('RENDERER GONE ' + JSON.stringify(d)))

  const js = (code, fallback = null) => win.webContents.executeJavaScript(code).catch(e => (fallback ?? { error: String(e) }))
  const canvasRect = async () => {
    const r = await js(`(() => { const c = document.querySelector('canvas'); if (!c) return null; const b = c.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } })()`)
    return r && r.width ? r : null
  }
  /** Loads a zone page and waits for the scene; returns its framing, or null. */
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
  const metrics = state => js(`(() => {
    const z = window.__zoneData, sky = window.__sky || [], kinds = {}
    for (const l of sky) kinds[l.kind] = (kinds[l.kind] || 0) + 1
    const missing = new Set()
    for (const l of sky) for (const pi of l.spawn.prefabIndices) {
      const p = z.prefabs[pi]
      const want = p ? (p.textureName || '').trim() : ''
      // Missing, or quietly swapped for the zone's terrain texture by ZoneFile.
      if (want && (!z.textures[p.materialIndex] || (z.textureNames && (z.textureNames[p.materialIndex] || '').trim() !== want)))
        missing.add(l.spawn.generator + '(' + want + ')')
    }
    // Generator meshes that every generator places away from the zone origin:
    // drawn at the origin, they are in the wrong place.
    const away = new Map()
    for (const sp of z.spawns || []) {
      const off = Math.hypot(...sp.position) > 1 || sp.attach !== 0 || sp.followCamera
      for (const i of sp.prefabIndices) away.set(i, (away.has(i) ? away.get(i) : true) && off)
    }
    const targets = new Set([...away].filter(([, v]) => v).map(([i]) => i))
    const stray = (window.__zoneMeshes || []).filter(m => m.visible && m.userData.unrefPrefab !== undefined &&
      (targets.has(m.userData.unrefPrefab) || z.prefabs[m.userData.unrefPrefab]?.weatherState))
      .map(m => {
        const i = m.userData.unrefPrefab, p = z.prefabs[i]
        m.geometry.computeBoundingBox()
        const b = m.geometry.boundingBox, c = [], d = []
        for (const k of ['x', 'y', 'z']) { c.push(Math.round((b.min[k] + b.max[k]) / 2)); d.push(Math.round(b.max[k] - b.min[k])) }
        // Where the generators that use it would put it.
        const at = (z.spawns || []).filter(sp => sp.prefabIndices.includes(i))
          .map(sp => sp.generator + '@' + sp.position.map(v => Math.round(v)).join(',') + '/attach' + sp.attach)
        return i + ' ' + (((p.textureName || '').trim()) || '(blank)') + ' ' + (p.meshName || '') + ' centre ' + c.join(',') +
          ' size ' + d.join('x') + ' ' + [...new Set(at)].slice(0, 3).join(' ')
      })
    return {
      state: ${JSON.stringify(state)},
      layers: kinds, generators: new Set(sky.map(l => l.spawn.generator)).size,
      names: [...new Set(sky.map(l => l.spawn.generator + ":" + l.kind + ":" + l.spawn.dir))],
      particles: (window.__wxp || []).map(s => s.spawn.generator),
      missingTex: [...missing], stray,
    }
  })()`)

  for (const zone of zones) {
    const t0 = Date.now()
    errors = []
    const rec = { id: zone.id, name: zone.name, states: [] }
    try {
      if (!existsSync(join(root, ...zone.model.split('/')))) { rec.skipped = 'model file not installed' }
      else {
        const view = await open(`zone=${zone.id}&census=1&scene_zoneWeather=true&scene_timeOfDay=${TIME}${EXTRA}`)
        if (!view || view.error) rec.skipped = 'did not load'
        else {
          // Diagnostic: SWEEP_EVAL (a file of page-side JS) is run once loaded; its result is printed.
          if (process.env.SWEEP_EVAL) {
            rec.eval = await js(readFileSync(process.env.SWEEP_EVAL, 'utf8'))
            const text = JSON.stringify(rec.eval)
            console.log('EVAL ' + (text.length > 2000 ? text.length + ' chars (in results.jsonl)' : text))
          }
          const want = (process.env.SWEEP_STATES || '').split(',').filter(Boolean)
          const states = (await js(`[...new Set((window.__zoneData.environment || []).map(r => r.state))].sort()`))
            .filter(st => !want.length || want.includes(st))
          rec.weathers = states
          const smalls = {}
          // Overview, in each weather.
          for (const st of states) {
            await js(`window.__setScene({ weatherState: ${JSON.stringify(st)} })`)
            await wait(3000)
            const m = await metrics(st)
            const rect = await canvasRect()
            const img = await win.webContents.capturePage(rect || undefined)
            const small = img.resize({ width: 480 })
            await fs.writeFile(join(outDir, 'img', `${zone.id}-${st}-over.jpg`), small.toJPEG(80))
            smalls[st] = grayOf(img.resize({ width: 96 })).g
            m.sameAs = Object.keys(smalls).filter(o => o !== st && meanDiff(smalls[o], smalls[st]) < 0.6)
            rec.states.push(m)
          }
          // Sky only, from the middle of the zone looking up, two ways round.
          if (states.length) {
            const c = view.center
            const sky = await open(`zone=${zone.id}&census=1&scene_zoneWeather=true&scene_timeOfDay=${TIME}` +
              `&scene_weatherState=${encodeURIComponent(states[0])}&campos=${c.map(v => v.toFixed(1)).join(',')}&pitch=45&yaw=0${EXTRA}`)
            if (sky && !sky.error) {
              if (process.env.SWEEP_EVAL_SKY) console.log('EVALSKY ' + JSON.stringify(await js(readFileSync(process.env.SWEEP_EVAL_SKY, 'utf8'))))
              for (const st of states) {
                await js(`window.__setScene({ weatherState: ${JSON.stringify(st)} })`)
                await wait(2500)
                const m = rec.states.find(s => s.state === st)
                m.seams = []
                for (const yaw of [0, 180]) {
                  await js(`(() => { for (const m of window.__zoneMeshes || []) m.visible = false; window.__aimCamera && window.__aimCamera(${yaw}, 45) })()`)
                  await wait(400)
                  const rect = await canvasRect()
                  if (!rect) continue
                  // Clear of the corner buttons and the zone label.
                  const inner = { x: rect.x + 10, y: rect.y + 70, width: rect.width - 20, height: rect.height - 170 }
                  const img = await win.webContents.capturePage(inner)
                  const { W, H, g } = grayOf(img)
                  const found = findLines(W, H, g)
                  if (found.lines.length || process.env.SWEEP_SAVEALL) {
                    m.seams.push({ yaw, ...found })
                    await fs.writeFile(join(outDir, 'img', `${zone.id}-${st}-sky${yaw}.jpg`), img.toJPEG(90))
                  }
                }
              }
            }
          }
        }
      }
    } catch (e) { rec.failed = String(e && e.stack || e) }
    rec.errors = [...new Set(errors)].slice(0, 10)
    rec.ms = Date.now() - t0
    await fs.appendFile(resultsPath, JSON.stringify(rec) + '\n')
    const flags = rec.states.filter(s => s.stray.length || s.missingTex.length || (s.seams && s.seams.length)).map(s => s.state)
    console.log(`${zone.id} ${zone.name}: ${rec.skipped || (rec.weathers || []).length + ' weathers'}` +
      `${flags.length ? ' FLAGS ' + flags.join(',') : ''}${rec.errors.length ? ' ERRORS ' + rec.errors.length : ''} (${(rec.ms / 1000).toFixed(0)}s)`)
  }
  app.exit(0)
})
dialog.showErrorBox = (t, c) => console.log('DIALOG: ' + t + ' - ' + c)
