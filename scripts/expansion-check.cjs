/**
 * Verification harness: reads the expansion tag the sidebar actually renders
 * for every zone, and cross-checks it against rules derived independently from
 * the zone CSV. Reports the distribution and any row that disagrees.
 *
 *   npx electron scripts/expansion-check.cjs
 *
 * The point of reading the DOM rather than importing the module is that this
 * checks what the user sees, which is the rule this project keeps re-learning.
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

// The zone list only renders once an install is found, so this harness needs
// the same auto-detect smoke.cjs uses. Without it the sidebar is empty and the
// check passes vacuously.
const VALIDATION_ENTRIES = ['ROM', 'ROM2', 'VTABLE.DAT']

async function isValidFfxiDir(dir) {
  for (const entry of VALIDATION_ENTRIES) {
    try { await fs.stat(join(dir, entry)) } catch { return false }
  }
  return true
}

async function autoDetectFfxiPath() {
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnlineUS\\InstallFolder',
    'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnlineEU\\InstallFolder',
  ]
  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/v', '0001'])
      const m = stdout.match(/REG_SZ\s+(.+)/)
      if (m) {
        const dir = m[1].trim().replace(/[\\/]+$/, '')
        if (await isValidFfxiDir(dir)) return dir
      }
    } catch { /* next */ }
  }
  for (const dir of ['C:\\FFXI-Data', 'C:\\Program Files (x86)\\PlayOnline\\SquareEnix\\FINAL FANTASY XI']) {
    if (await isValidFfxiDir(dir)) return dir
  }
  return null
}

/** Archive → expected tag. Independent of the renderer's own table. */
const ARCHIVE_TAG = { ROM2: 'RoZ', ROM3: 'CoP', ROM4: 'ToAU', ROM5: 'WotG', ROM9: 'SoA' }

/** Ids the archive rule cannot answer: later content filed into the base ROM. */
const OVERRIDES = new Set([
  15, 45, 132, 215, 216, 217, 218, 253, 254, 255,
  280, 282, 284,
  183, 222, 285, 288, 289, 290, 291, 292, 293, 294, 295, 296, 297,
])

function splitCsvLine(line) {
  const fields = []
  let current = '', inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ } else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) { fields.push(current); current = '' } else current += ch
  }
  fields.push(current)
  return fields
}

app.whenReady().then(async () => {
  ipcMain.handle('ffxi:autoDetect', () => autoDetectFfxiPath())
  ipcMain.handle('ffxi:pickDirectory', () => ({ status: 'cancelled' }))
  ipcMain.handle('ffxi:readDat', async () => { throw new Error('no zone load in this harness') })
  ipcMain.handle('ffxi:fileExists', async () => false)

  const csv = await fs.readFile(join(__dirname, '../resources/zone-seed-data.csv'), 'utf8')
  const lines = csv.split(/\r?\n/).filter(l => l.trim())
  const header = splitCsvLine(lines[0])
  const iId = header.indexOf('ID'), iName = header.indexOf('NAME'), iModel = header.indexOf('MODEL')
  // Keyed "name|modelPath", not name alone: two pairs of zones share a name
  // (the Selbina and Mhaura ships, ids 220/227 and 221/228) and keying by name
  // silently collapses them, which reads as two missing rows.
  /** "name|modelPath" → { id, archive } straight from the CSV. */
  const fromCsv = new Map()
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i])
    const name = (f[iName] || '').trim()
    const model = (f[iModel] || '').trim()
    if (!name || name === 'unknown' || !model) continue
    fromCsv.set(`${name}|${model}`, { id: Number(f[iId]), archive: model.split('/')[0].toUpperCase() })
  }

  const win = new BrowserWindow({
    width: 1600, height: 900, show: false,
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
    },
  })
  await win.loadFile(join(__dirname, '../out/renderer/index.html'))
  await new Promise(r => setTimeout(r, 3000))

  const rows = JSON.parse(await win.webContents.executeJavaScript(`
    JSON.stringify([...document.querySelectorAll('.zone-list li')].map(li => ({
      name: li.querySelector('.zone-name')?.innerText ?? null,
      path: li.querySelector('.zone-path')?.innerText ?? null,
      tag: li.querySelector('.zone-expansion')?.innerText ?? null,
      title: li.querySelector('.zone-expansion')?.getAttribute('title') ?? null,
    })))
  `))

  console.log(`ROWS: ${rows.length} (CSV has ${fromCsv.size})`)

  const counts = {}
  const problems = []
  // An empty sidebar would otherwise pass every check below vacuously.
  if (rows.length !== fromCsv.size) {
    problems.push(`rendered ${rows.length} rows, expected ${fromCsv.size} — the list did not load`)
  }
  for (const row of rows) {
    if (!row.tag) { problems.push(`${row.name}: no expansion tag rendered`); continue }
    if (!row.title) { problems.push(`${row.name}: tag "${row.tag}" has no tooltip`) }
    counts[row.tag] = (counts[row.tag] || 0) + 1

    const csvRow = fromCsv.get(`${row.name}|${row.path}`)
    if (!csvRow) { problems.push(`${row.name}: not found in the CSV`); continue }

    // Rule 1: unless the id is a known override, the archive decides.
    if (!OVERRIDES.has(csvRow.id)) {
      const expected = ARCHIVE_TAG[csvRow.archive] ?? 'Base'
      if (row.tag !== expected) {
        problems.push(`${row.name} (${csvRow.archive}, id ${csvRow.id}): shows "${row.tag}", archive says "${expected}"`)
      }
    }
    // Rule 2: name signals that must hold whatever the archive says.
    if (/\[S\]$/.test(row.name) && row.tag !== 'WotG') {
      problems.push(`${row.name}: a [S] past zone must be WotG, shows "${row.tag}"`)
    }
    if (/^Abyssea - /.test(row.name) && row.tag !== 'Abyssea') {
      problems.push(`${row.name}: an Abyssea area must be Abyssea, shows "${row.tag}"`)
    }
  }

  console.log('DISTRIBUTION: ' + JSON.stringify(counts))
  console.log('TAG LABELS: ' + JSON.stringify(
    Object.fromEntries(rows.filter(r => r.tag).map(r => [r.tag, r.title]))))
  if (problems.length) console.log(`PROBLEMS (${problems.length}):\n` + problems.join('\n'))
  else console.log('No problems: every row tagged, and every tag agrees with the archive and name rules.')

  app.exit(problems.length ? 1 : 0)
})

dialog.showErrorBox = (title, content) => console.log('DIALOG: ' + title + ' — ' + content)
