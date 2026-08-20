/**
 * What a mesh samples, texel by texel — the probe HANDOFF §0 asks for.
 *
 *   npx electron scripts/uv-alpha-dump.cjs <zone> <textureSubstring> [triangles]
 *   npx electron scripts/uv-alpha-dump.cjs 107 gateston 12 --prefab=128
 *
 * --prefab=N dumps that exact prefab instead of the largest drawn one, which
 * is how you look at a specific suspect rather than the main body of a model.
 *
 * Reports, per matching prefab: blend flag, UV bounds, and for the largest one
 * a triangle-by-triangle dump of UVs with the RGBA it reads at each vertex and
 * at the centroid.
 *
 * **RGB is dumped next to alpha on purpose.** "Alpha is 0 here" and "this texel
 * is transparent" are only the same claim if the renderer consults alpha at
 * all. Stone-coloured RGB under alpha 0 means the channel is a mask, not
 * opacity — which is §5a's thesis, and the thing this dump can settle.
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { join } = require('path')
const { promises: fs } = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

// Positional args, with --flags filtered out first: passing --prefab= as the
// fifth token made waitMs NaN, setTimeout fired immediately and the page had no
// __zoneData yet. The failure looked exactly like a zone that would not load.
const pos = process.argv.slice(2).filter(a => !a.startsWith('--'))
const zoneId = pos[0] || '107'
const needle = (pos[1] || 'gateston').toLowerCase()
const triLimit = Number(pos[2] || 12)
const prefabArg = (process.argv.find(a => a.startsWith('--prefab=')) || '').split('=')[1]
const wantPrefab = prefabArg === undefined ? -1 : Number(prefabArg)
const waitMs = Number(pos[3] || 14000)
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

process.on('unhandledRejection', e => { console.log('PAGE ERROR: ' + (e && e.message || e)); app.exit(1) })

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

  await win.loadFile(join(__dirname, '../out/renderer/index.html'), {
    search: `zone=${zoneId}&census=1`,
  })
  await new Promise(r => setTimeout(r, waitMs))

  const raw = await win.webContents.executeJavaScript(`
    (() => {
      const z = window.__zoneData;
      if (!z) return null;
      const needle = "${needle}";
      const hits = [];
      for (let i = 0; i < z.prefabs.length; i++) {
        const p = z.prefabs[i];
        if (!(p.textureName || "").toLowerCase().includes(needle)) continue;
        hits.push(i);
      }
      if (!hits.length) return JSON.stringify({ hits: [] });

      const referenced = new Set(z.instances.map(i => i.meshIndex));
      const summary = hits.map(i => {
        const p = z.prefabs[i];
        let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
        for (let k = 0; k + 1 < p.uvs.length; k += 2) {
          const u = p.uvs[k], v = p.uvs[k + 1];
          if (u < u0) u0 = u; if (u > u1) u1 = u;
          if (v < v0) v0 = v; if (v > v1) v1 = v;
        }
        const t = z.textures[p.materialIndex];
        let rSum = 0, gSum = 0, bSum = 0, aSum = 0, n = 0, dark = 0;
        if (t) {
          for (let k = 0; k + 2 < p.indices.length; k += 3) {
            let cu = 0, cv = 0;
            for (let j = 0; j < 3; j++) {
              cu += p.uvs[p.indices[k + j] * 2];
              cv += p.uvs[p.indices[k + j] * 2 + 1];
            }
            cu /= 3; cv /= 3;
            cu -= Math.floor(cu); cv -= Math.floor(cv);
            const x = Math.min(t.width - 1, Math.max(0, Math.round(cu * (t.width - 1))));
            const y = Math.min(t.height - 1, Math.max(0, Math.round(cv * (t.height - 1))));
            const d = (y * t.width + x) * 4;
            rSum += t.rgba[d]; gSum += t.rgba[d + 1]; bSum += t.rgba[d + 2]; aSum += t.rgba[d + 3];
            if (t.rgba[d] + t.rgba[d + 1] + t.rgba[d + 2] < 60) dark++;
            n++;
          }
        }
        // Vertex colour matters as much as the texel: the zone materials
        // multiply by it, and FFXI stores very dark values in places (the pond
        // bed measures 0.07). A mesh reading mid-grey texels still draws black
        // if its vertex colour is near zero.
        let vr = 0, va = 0, vn = 0;
        for (let k = 0; k + 3 < p.colors.length; k += 4) {
          vr += (p.colors[k] + p.colors[k + 1] + p.colors[k + 2]) / 3;
          va += p.colors[k + 3];
          vn++;
        }
        return {
          vcol: vn ? +(vr / vn).toFixed(3) : -1,
          valpha: vn ? +(va / vn).toFixed(3) : -1,
          i, verts: p.vertices.length / 3, tris: p.indices.length / 3,
          blend: p.blending >>> 0, drawn: referenced.has(i),
          uv: [u0, v0, u1, v1],
          meanRGB: n ? Math.round((rSum + gSum + bSum) / (3 * n)) : -1,
          meanA: n ? Math.round(aSum / n) : -1,
          darkShare: n ? dark / n : 0,
        };
      });

      // The biggest drawn one is the arch body rather than a decoration,
      // unless a specific prefab was asked for.
      const want = ${wantPrefab};
      const target = (want >= 0 ? summary.find(o => o.i === want) : null)
        || summary.filter(o => o.drawn).sort((a, b) => b.tris - a.tris)[0]
        || summary[0];
      const p = z.prefabs[target.i];
      const tex = z.textures[p.materialIndex];
      const sample = (u, v) => {
        const uu = u - Math.floor(u), vv = v - Math.floor(v);
        const x = Math.min(tex.width - 1, Math.max(0, Math.round(uu * (tex.width - 1))));
        const y = Math.min(tex.height - 1, Math.max(0, Math.round(vv * (tex.height - 1))));
        const d = (y * tex.width + x) * 4;
        return { x, y, r: tex.rgba[d], g: tex.rgba[d + 1], b: tex.rgba[d + 2], a: tex.rgba[d + 3] };
      };

      // What mode 6 sees: the extremes over the whole UV bounding rect, and
      // over the texels the triangles actually land on. If the rect holds a
      // live texel while every centroid is dead, that gap IS mode 6's failure.
      const rect = (() => {
        const cu0 = Math.max(0, Math.min(1, target.uv[0])), cu1 = Math.max(0, Math.min(1, target.uv[2]));
        const cv0 = Math.max(0, Math.min(1, target.uv[1])), cv1 = Math.max(0, Math.min(1, target.uv[3]));
        const x0 = Math.floor(cu0 * (tex.width - 1)), x1 = Math.ceil(cu1 * (tex.width - 1));
        const y0 = Math.floor(cv0 * (tex.height - 1)), y1 = Math.ceil(cv1 * (tex.height - 1));
        let maxA = 0, liveTexels = 0, n = 0, maxRGB = 0;
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const d = (y * tex.width + x) * 4;
            const av = tex.rgba[d + 3];
            if (av > maxA) maxA = av;
            if (av > 0) liveTexels++;
            const rgb = tex.rgba[d] + tex.rgba[d + 1] + tex.rgba[d + 2];
            if (rgb > maxRGB) maxRGB = rgb;
            n++;
          }
        }
        return { x0, y0, x1, y1, maxA, liveTexels, n, maxRGB };
      })();

      const tris = [];
      let zeroAlpha = 0, zeroAlphaLit = 0, total = 0;
      for (let t = 0; t + 2 < p.indices.length; t += 3) {
        const vs = [0, 1, 2].map(k => {
          const vi = p.indices[t + k];
          return { u: p.uvs[vi * 2], v: p.uvs[vi * 2 + 1] };
        });
        const cu = (vs[0].u + vs[1].u + vs[2].u) / 3;
        const cv = (vs[0].v + vs[1].v + vs[2].v) / 3;
        const cs = sample(cu, cv);
        total++;
        if (cs.a === 0) {
          zeroAlpha++;
          // Alpha 0 over a texel that is not black is a mask, not a hole.
          if (cs.r + cs.g + cs.b > 60) zeroAlphaLit++;
        }
        if (tris.length < ${triLimit}) {
          tris.push({
            t: t / 3,
            uv: vs.map(s => [+s.u.toFixed(4), +s.v.toFixed(4)]),
            vertSamples: vs.map(s => sample(s.u, s.v)),
            centroid: [+cu.toFixed(4), +cv.toFixed(4)],
            centroidSample: cs,
          });
        }
      }

      return JSON.stringify({
        hits: summary,
        target: target.i,
        texture: { name: (z.textureNames && z.textureNames[p.materialIndex]) || "?",
                   w: tex.width, h: tex.height, format: tex.format,
                   profile: tex.alphaProfile },
        stats: { total, zeroAlpha, zeroAlphaLit },
        rect,
        tris,
      });
    })()
  `)

  if (!raw) { console.log(`zone ${zoneId}: no __zoneData`); app.exit(1); return }
  const d = JSON.parse(raw)
  if (!d.hits.length) { console.log(`no prefab matches "${needle}"`); app.exit(1); return }

  console.log(`\n=== "${needle}" in zone ${zoneId}: ${d.hits.length} prefabs ===`)
  d.hits.forEach(o => console.log(
    `  #${String(o.i).padStart(3)}  ${String(o.tris).padStart(5)} tris  ` +
    `blend 0x${o.blend.toString(16).padStart(4, "0")}  ${o.drawn ? "drawn " : "unplaced"}  ` +
    `uv[${o.uv[0].toFixed(2)},${o.uv[2].toFixed(2)}]x[${o.uv[1].toFixed(2)},${o.uv[3].toFixed(2)}]  ` +
    `meanRGB ${String(o.meanRGB).padStart(3)}  meanA ${String(o.meanA).padStart(3)}  ` +
    `dark ${(100 * o.darkShare).toFixed(0).padStart(3)}%  ` +
    `vcol ${String(o.vcol).padStart(5)}  valpha ${String(o.valpha).padStart(5)}`))

  const t = d.texture
  console.log(`\n--- prefab #${d.target} on ${t.name} (${t.w}x${t.h}, ${t.format}, ` +
    `class ${t.profile ? t.profile.cls : "?"}) ---`)
  const r = d.rect
  console.log(`UV rect texels ${r.x0},${r.y0}..${r.x1},${r.y1} (${r.n}): ` +
    `max alpha ${r.maxA}, ${r.liveTexels} live (${(100 * r.liveTexels / r.n).toFixed(2)}%), ` +
    `brightest RGB sum ${r.maxRGB}`)
  console.log(`triangles ${d.stats.total}, centroid alpha==0 on ${d.stats.zeroAlpha} ` +
    `(${(100 * d.stats.zeroAlpha / d.stats.total).toFixed(1)}%), ` +
    `of which ${d.stats.zeroAlphaLit} read a NON-BLACK colour ` +
    `(${d.stats.zeroAlpha ? (100 * d.stats.zeroAlphaLit / d.stats.zeroAlpha).toFixed(1) : "0"}% of them)`)

  console.log(`\n  tri  centroid uv        texel     RGBA at centroid      alpha at the 3 vertices`)
  d.tris.forEach(r => {
    const cs = r.centroidSample
    console.log(
      `  ${String(r.t).padStart(4)}  ` +
      `${r.centroid[0].toFixed(3)},${r.centroid[1].toFixed(3)}   ` +
      `${String(cs.x).padStart(3)},${String(cs.y).padStart(3)}   ` +
      `rgba(${String(cs.r).padStart(3)},${String(cs.g).padStart(3)},${String(cs.b).padStart(3)},${String(cs.a).padStart(3)})   ` +
      r.vertSamples.map(s => String(s.a).padStart(3)).join(" "))
  })
  app.exit(0)
})

dialog.showErrorBox = (t, c) => console.log('DIALOG: ' + t + ' - ' + c)
