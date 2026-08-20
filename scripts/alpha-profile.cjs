/**
 * Census of what every zone texture's alpha channel is for.
 *
 *   npx electron scripts/alpha-profile.cjs [zoneIds] [waitMs]
 *   npx electron scripts/alpha-profile.cjs 107,100,130
 *
 * Reads `alphaProfile` straight off `window.__zoneData` — the same values the
 * renderer picks materials from — so this measures the shipping classification
 * rather than a copy of it that can drift.
 *
 * The classification lives in `TextureParser.computeAlphaProfile`; the
 * thresholds and where they came from are documented there. Breakdown is by
 * decode format because the two paths behave completely differently: indexed
 * plates are a clean 0/255 split, DXT3 carries the dithered opaque pair.
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const zoneIds = (process.argv[2] || '107,100,130').split(',').map(s => s.trim()).filter(Boolean)
const waitMs = Number(process.argv[3] || 9000)

async function isValidFfxiDir(dir) {
  for (const e of ['ROM', 'ROM2', 'VTABLE.DAT']) {
    try { await fs.stat(join(dir, e)) } catch { return false }
  }
  return true
}
async function detect() {
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

app.whenReady().then(async () => {
  ipcMain.handle('ffxi:autoDetect', () => detect())
  ipcMain.handle('ffxi:pickDirectory', () => ({ status: 'cancelled' }))
  ipcMain.handle('ffxi:readDat', (_e, root, rel) =>
    fs.readFile(join(root, ...rel.replace(/\\/g, '/').split('/'))))
  ipcMain.handle('ffxi:fileExists', async (_e, root, rel) => {
    try { await fs.stat(join(root, ...rel.replace(/\\/g, '/').split('/'))); return true }
    catch { return false }
  })

  const win = new BrowserWindow({
    width: 1200, height: 800, show: false, backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
    },
  })
  win.webContents.on('render-process-gone', (_e, d) => console.log('RENDERER GONE:', JSON.stringify(d)))

  const totals = {}

  for (const zone of zoneIds) {
    // census=1 is what exposes __zoneData; without it there is nothing to read.
    await win.loadFile(join(__dirname, '../out/renderer/index.html'), {
      search: `zone=${zone}&census=1${process.env.EXTRA_QUERY || ''}`,
    })
    await new Promise(r => setTimeout(r, waitMs))

    const raw = await win.webContents.executeJavaScript(`
      (() => {
        const z = window.__zoneData;
        if (!z) return null;
        const blends = new Map(), uses = new Map(), drawn = new Map();
        const referenced = new Set(z.instances.map(i => i.meshIndex));
        for (let pi = 0; pi < z.prefabs.length; pi++) {
          const p = z.prefabs[pi];
          if (p.materialIndex < 0) continue;
          if (!blends.has(p.materialIndex)) blends.set(p.materialIndex, new Set());
          blends.get(p.materialIndex).add(p.blending >>> 0);
          uses.set(p.materialIndex, (uses.get(p.materialIndex) || 0) + 1);
          if (referenced.has(pi)) drawn.set(p.materialIndex, (drawn.get(p.materialIndex) || 0) + 1);
        }
        return JSON.stringify(z.textures.map((t, i) => ({
          i,
          name: (z.textureNames && z.textureNames[i]) || ('#' + i),
          format: t.format || '?',
          w: t.width, h: t.height,
          uses: uses.get(i) || 0,
          drawn: drawn.get(i) || 0,
          blends: Array.from(blends.get(i) || []).sort((a, b) => a - b),
          p: t.alphaProfile || null,
        })));
      })()
    `)

    if (!raw) { console.log(`zone ${zone}: no __zoneData (failed to load?)`); continue }
    const rows = JSON.parse(raw)
    const missing = rows.filter(r => !r.p)
    // A texture with no profile means a decode path skipped the factory. That
    // is a bug, not a curiosity: the renderer would fall back to guessing.
    if (missing.length) {
      console.log(`zone ${zone}: ${missing.length} textures WITHOUT a profile — ` +
        missing.slice(0, 8).map(r => r.name).join(', '))
    }

    const byFormat = {}
    for (const r of rows) {
      if (!r.p) continue
      const g = byFormat[r.format] ??= { solid: 0, cutout: 0, translucent: 0 }
      g[r.p.cls]++
      const t = totals[r.p.cls] ??= 0
      totals[r.p.cls] = t + 1
    }

    console.log(`\n=== zone ${zone} — ${rows.length} textures ===`)
    const pct = v => (100 * v).toFixed(1).padStart(5)
    rows
      .filter(r => r.p)
      .sort((a, b) => a.p.cls.localeCompare(b.p.cls) || a.name.localeCompare(b.name))
      .forEach(r => console.log(
        `  ${r.name.padEnd(12)} ${r.format.padEnd(9)} ${(r.w + 'x' + r.h).padEnd(9)} ` +
        `${r.p.cls.padEnd(11)} clear ${pct(r.p.clear)}%  partial ${pct(r.p.partial)}%  opaque ${pct(r.p.opaque)}%  ` +
        `meshes ${String(r.uses).padStart(3)}  drawn ${String(r.drawn).padStart(3)}  blend ${r.blends.map(b => '0x' + b.toString(16)).join(',') || '-'}`))
    const liveTranslucent = rows.filter(r => r.p && r.p.cls === 'translucent' && r.drawn > 0)
    console.log(`  ** translucent AND drawn: ${liveTranslucent.length}` +
      (liveTranslucent.length ? ' — ' + liveTranslucent.map(r => `${r.name} (${r.drawn})`).join(', ') : ''))
    for (const [f, g] of Object.entries(byFormat)) {
      console.log(`  -- ${f.padEnd(9)} ${g.solid} solid, ${g.cutout} cutout, ${g.translucent} translucent`)
    }
  }

  console.log(`\n[SUMMARY] across ${zoneIds.length} zones: ` +
    Object.entries(totals).map(([k, v]) => `${v} ${k}`).join(', '))
  app.exit(0)
})

dialog.showErrorBox = (t, c) => console.log('DIALOG: ' + t + ' - ' + c)
