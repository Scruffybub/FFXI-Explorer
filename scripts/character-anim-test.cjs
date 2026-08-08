/**
 * Equips a character, picks an animation set, and measures whether the mesh
 * actually deforms — the same motion check used for NPC animation.
 *
 *   npx electron scripts/character-anim-test.cjs <animOptionIndex> <outFile>
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const animPick = Number(process.argv[2] || 3)
const outFile = process.argv[3] || join(process.cwd(), 'char-anim.png')

async function isValidFfxiDir(dir) {
  for (const e of ['ROM', 'ROM2', 'VTABLE.DAT']) {
    try { await fs.stat(join(dir, e)) } catch { return false }
  }
  return true
}
async function detect() {
  try {
    const { stdout } = await execFileAsync('reg',
      ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnlineUS\\InstallFolder', '/v', '0001'])
    const m = stdout.match(/REG_SZ\s+(.+)/)
    if (m) {
      const d = m[1].trim().replace(/[\\/]+$/, '')
      if (await isValidFfxiDir(d)) return d
    }
  } catch { /* fall through */ }
  return 'C:\\FFXI-Data'
}

const SAMPLE = `
(() => {
  const s = window.__modelScene;
  if (!s) return JSON.stringify({ error: 'no scene' });
  const out = [];
  s.traverse(function (o) {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    if (!p) return;
    const take = [];
    for (let k = 0; k < Math.min(40, p.count); k++) {
      take.push(p.getX(k), p.getY(k), p.getZ(k));
    }
    out.push(take);
  });
  return JSON.stringify(out);
})()
`

function selectNth(which, n) {
  return `
    (() => {
      const els = [...document.querySelectorAll('.builder select')];
      const el = els[${which}];
      if (!el) return 'missing';
      const opts = [...el.options].filter(o => o.value !== '');
      const pick = opts[Math.min(${n}, opts.length - 1)];
      if (!pick) return 'empty';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, pick.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return pick.text.slice(0, 46);
    })()
  `
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
    width: 1400, height: 900, show: true, backgroundColor: '#0b0d12',
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
    },
  })
  const logs = []
  win.webContents.on('console-message', (_e, _l, msg) => logs.push(msg))

  await win.loadFile(join(__dirname, '../out/renderer/index.html'), { search: 'modeldebug=1' })
  await new Promise(r => setTimeout(r, 4000))

  await win.webContents.executeJavaScript(`
    (() => { const b=[...document.querySelectorAll('.view-switch button')]
      .find(x=>x.textContent.trim()==='Models'); if(b)b.click(); return true; })()
  `)
  await new Promise(r => setTimeout(r, 600))
  await win.webContents.executeJavaScript(`
    (() => { const b=[...document.querySelectorAll('.mode-switch button')]
      .find(x=>x.textContent.trim()==='Character'); if(b)b.click(); return true; })()
  `)
  await new Promise(r => setTimeout(r, 2500))

  // Equip body + legs + feet so there is a torso to deform.
  for (const slot of [3, 5, 6]) {
    console.log(`slot ${slot}: ` + await win.webContents.executeJavaScript(selectNth(slot, 0)))
    await new Promise(r => setTimeout(r, 1200))
  }

  // The animation select is the last one in the builder.
  const animLabel = await win.webContents.executeJavaScript(`
    (() => {
      const els = [...document.querySelectorAll('.builder select')];
      const el = els[els.length - 1];
      const opts = [...el.options].filter(o => o.value !== '');
      const pick = opts[Math.min(${animPick}, opts.length - 1)];
      if (!pick) return 'none';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, pick.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return pick.text + ' | total options: ' + opts.length;
    })()
  `)
  console.log('animation: ' + animLabel)
  await new Promise(r => setTimeout(r, 5000))

  const a = JSON.parse(await win.webContents.executeJavaScript(SAMPLE))
  await new Promise(r => setTimeout(r, 900))
  const b = JSON.parse(await win.webContents.executeJavaScript(SAMPLE))

  let maxDelta = 0, total = 0, n = 0, nan = 0
  for (let m = 0; m < Math.min(a.length, b.length); m++) {
    for (let i = 0; i < Math.min(a[m].length, b[m].length); i += 3) {
      const dx = b[m][i] - a[m][i], dy = b[m][i+1] - a[m][i+1], dz = b[m][i+2] - a[m][i+2]
      if (!isFinite(dx) || !isFinite(dy) || !isFinite(dz)) { nan++; continue }
      const d = Math.hypot(dx, dy, dz)
      if (d > maxDelta) maxDelta = d
      total += d; n++
    }
  }
  console.log(`MOTION: meshes=${a.length} sampled=${n} maxDelta=${maxDelta.toFixed(4)} ` +
    `meanDelta=${(total / Math.max(n,1)).toFixed(4)} nonFinite=${nan}`)

  const state = await win.webContents.executeJavaScript(`
    (() => { const h=document.querySelector('.hud');
      return h ? h.innerText.replace(/\\n/g,' | ') : 'no hud'; })()
  `)
  console.log('HUD: ' + state)

  const image = await win.webContents.capturePage()
  await fs.writeFile(outFile, image.toPNG())
  console.log('SCREENSHOT: ' + outFile)
  app.exit(0)
})
