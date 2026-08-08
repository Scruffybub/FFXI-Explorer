/**
 * Loads a model in the model viewer, dumps the resulting three.js scene graph,
 * and screenshots it.
 *
 *   npx electron scripts/model-test.cjs <modelName> <outFile>
 *
 * Matches the first model whose name contains <modelName>, case-insensitive.
 * The scene dump is the useful part when a model does not appear: it says
 * whether the meshes exist, where they are, and what the camera can see.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const wanted = (process.argv[2] || 'Rarab').toLowerCase()
const outFile = process.argv[3] || join(process.cwd(), 'model.png')

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

const SCENE_DUMP = `
(() => {
  const s = window.__modelScene, c = window.__modelCam;
  if (!s) return JSON.stringify({ error: 'no scene exposed' });
  const meshes = [];
  s.traverse(function (o) {
    if (!o.isMesh) return;
    const g = o.geometry, m = o.material;
    o.updateWorldMatrix(true, false);
    const e = o.matrixWorld.elements;
    if (!g.boundingSphere) g.computeBoundingSphere();
    meshes.push({
      visible: o.visible,
      culled: o.frustumCulled,
      verts: g.attributes.position ? g.attributes.position.count : 0,
      idx: g.index ? g.index.count : 0,
      attrs: Object.keys(g.attributes).join('+'),
      bsRadius: g.boundingSphere ? +g.boundingSphere.radius.toFixed(3) : null,
      bsCenter: g.boundingSphere ? [
        +g.boundingSphere.center.x.toFixed(2),
        +g.boundingSphere.center.y.toFixed(2),
        +g.boundingSphere.center.z.toFixed(2)
      ] : null,
      idxRange: (function () {
        if (!g.index) return null;
        const a = g.index.array;
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k < a.length; k++) {
          if (a[k] < lo) lo = a[k];
          if (a[k] > hi) hi = a[k];
        }
        return [lo, hi];
      })(),
      firstVerts: (function () {
        const p = g.attributes.position;
        if (!p) return null;
        const out = [];
        for (let k = 0; k < Math.min(3, p.count); k++) {
          out.push([+p.getX(k).toFixed(2), +p.getY(k).toFixed(2), +p.getZ(k).toFixed(2)]);
        }
        return out;
      })(),
      worldPos: [+e[12].toFixed(2), +e[13].toFixed(2), +e[14].toFixed(2)],
      mat: m.type,
      matVisible: m.visible,
      opacity: m.opacity,
      alphaTest: m.alphaTest,
      hasMap: !!m.map
    });
  });
  const gl = window.__modelGl;
  const info = gl ? {
    drawCalls: gl.info.render.calls,
    triangles: gl.info.render.triangles,
    programs: gl.info.programs ? gl.info.programs.length : null,
    geometries: gl.info.memory.geometries,
    textures: gl.info.memory.textures,
    contextLost: gl.getContext().isContextLost()
  } : null;

  const canvases = [...document.querySelectorAll('canvas')].map(function (c) {
    const r = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    return {
      buffer: c.width + 'x' + c.height,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      isLive: gl ? c === gl.domElement : null
    };
  });

  return JSON.stringify({
    canvases: canvases,
    renderInfo: info,
    sceneChildren: s.children.length,
    camPos: c ? [+c.position.x.toFixed(2), +c.position.y.toFixed(2), +c.position.z.toFixed(2)] : null,
    camNear: c ? c.near : null,
    camFar: c ? c.far : null,
    meshCount: meshes.length,
    meshes: meshes.slice(0, 4)
  });
})()
`

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

  await win.loadFile(join(__dirname, '../out/renderer/index.html'), {
    search: process.env.MODEL_QUERY || 'modeldebug=1',
  })
  await new Promise(r => setTimeout(r, 4000))

  const switched = await win.webContents.executeJavaScript(`
    (() => {
      const b = [...document.querySelectorAll('.view-switch button')]
        .find(x => x.textContent.trim() === 'Models');
      if (!b) return false;
      b.click();
      return true;
    })()
  `)
  console.log('switched to models: ' + switched)
  await new Promise(r => setTimeout(r, 800))

  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('.search');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(wanted)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `)
  await new Promise(r => setTimeout(r, 800))

  const picked = await win.webContents.executeJavaScript(`
    (() => {
      const first = document.querySelector('.zone-list li button');
      if (!first) return null;
      const name = first.querySelector('.zone-name').textContent;
      first.click();
      return name;
    })()
  `)
  console.log('picked: ' + picked)
  await new Promise(r => setTimeout(r, 6000))

  console.log('SCENE: ' + await win.webContents.executeJavaScript(SCENE_DUMP))

  const image = await win.webContents.capturePage()
  await fs.writeFile(outFile, image.toPNG())
  console.log('SCREENSHOT: ' + outFile)

  for (const l of logs.filter(l => /error|warn|Model|THREE/i.test(l)).slice(0, 10)) {
    console.log('LOG: ' + l)
  }
  app.exit(0)
})
