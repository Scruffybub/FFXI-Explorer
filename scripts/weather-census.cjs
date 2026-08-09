/**
 * Dumps every unreferenced prefab in a set of zones, with its full texture
 * string, material index, whether that material resolves, and its size.
 *
 *   npx electron scripts/weather-census.cjs <out.json> 12
 *   npx electron scripts/weather-census.cjs <out.json> "Misareaux Coast" "Riverne - Site #A01"
 *
 * A bare number samples that many zones evenly across the list; anything else
 * is treated as an exact zone name. Results are written to <out.json> so the
 * analysis can be redone without paying for another sweep — a zone load is
 * about nine seconds and a broad run is twenty minutes.
 *
 * Why unreferenced: FFXI parks weather domes and effect geometry in the zone
 * file with no MZB instance record, which is consistent with the client
 * picking what to show at runtime rather than the file placing it.
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const outPath = process.argv[2] || 'census.json'
const rest = process.argv.slice(3)
const sampleCount = rest.length === 1 && /^\d+$/.test(rest[0]) ? Number(rest[0]) : null
const wantNames = sampleCount ? null : rest
const waitMs = Number(process.env.WAIT_MS || 9000)

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

  let logs = []
  win.webContents.on('console-message', (_e, _l, msg) => logs.push(msg))

  await win.loadFile(join(__dirname, '../out/renderer/index.html'), { search: '?census=1' })
  await new Promise(r => setTimeout(r, 3500))

  const names = await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.zone-list li button .zone-name')).map(n => n.textContent)`,
  )
  if (!names.length) { console.log('no zone list — did the install detect?'); app.exit(1); return }

  let targets = []
  if (sampleCount) {
    const step = Math.max(1, Math.floor(names.length / sampleCount))
    for (let n = 0; n < sampleCount; n++) {
      const nm = names[n * step]
      if (nm) targets.push(nm)
    }
  } else {
    for (const want of wantNames) {
      if (names.includes(want)) targets.push(want)
      else console.log(`!! no zone named "${want}"`)
    }
  }
  console.log(`census over ${targets.length} of ${names.length} zones\n`)

  const results = []
  for (const name of targets) {
    logs = []
    const ok = await win.webContents.executeJavaScript(`
      (() => {
        const bs = Array.from(document.querySelectorAll('.zone-list li button'));
        const b = bs.find(b => b.querySelector('.zone-name').textContent === ${JSON.stringify(name)});
        if (!b) return false;
        b.click();
        return true;
      })()
    `)
    if (!ok) { console.log(`${name}: button vanished`); continue }
    await new Promise(r => setTimeout(r, waitMs))

    const line = logs.find(l => l.includes('[CENSUS]'))
    if (!line) { console.log(`${name}: no census (failed to load?)`); continue }
    // The line opens with the "[CENSUS]" tag, so the payload starts at the
    // first bracket *after* that tag, not the first bracket in the line.
    let list = []
    const start = line.indexOf('[', line.indexOf(']'))
    try { list = JSON.parse(line.slice(start, line.lastIndexOf(']') + 1)) }
    catch (e) { console.log(`${name}: census unparseable — ${e.message}`); continue }

    results.push({ zone: name, prefabs: list })
    const noTex = list.filter(o => !o.texOk).length
    console.log(`${name}: ${list.length} unreferenced, ${noTex} with no texture`)
    for (const o of list.slice(0, 8)) {
      console.log(`    #${String(o.i).padStart(3)} ${JSON.stringify(o.name).padEnd(22)} ` +
        `mat=${String(o.mat).padStart(3)} tex=${o.texOk ? `${o.tw}x${o.th}` : 'MISSING'} ` +
        `blend=0x${(o.blend >>> 0).toString(16)} ${o.w}x${o.h}x${o.d} ${o.skip ? 'SKIPPED' : ''}`)
    }
  }

  await fs.writeFile(outPath, JSON.stringify(results, null, 2))
  console.log(`\nwrote ${outPath} — ${results.length} zones`)
  app.exit(0)
})

dialog.showErrorBox = (t, c) => console.log('DIALOG: ' + t + ' - ' + c)
