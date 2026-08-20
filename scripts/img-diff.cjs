/**
 * Numerical comparison of two captures. Eyes are unreliable for "did that
 * change anything?" — twice a reported difference measured under 8%, and three
 * "clearly different" renders once came back identical to three decimals.
 *
 *   npx electron scripts/img-diff.cjs a.png b.png [--full]
 *
 * Compares the viewport region only (x from 30% to 78% of width) so the side
 * panels, which never change, cannot dilute the number. --full compares
 * everything.
 */
const { app, nativeImage } = require('electron')
const { existsSync } = require('fs')

const [, , aPath, bPath, ...rest] = process.argv
const full = rest.includes('--full')

if (!aPath || !bPath || !existsSync(aPath) || !existsSync(bPath)) {
  console.log('usage: npx electron scripts/img-diff.cjs a.png b.png [--full]')
  process.exit(1)
}

app.whenReady().then(() => {
  const a = nativeImage.createFromPath(aPath)
  const b = nativeImage.createFromPath(bPath)
  const sa = a.getSize(), sb = b.getSize()
  if (sa.width !== sb.width || sa.height !== sb.height) {
    console.log(`SIZE MISMATCH: ${sa.width}x${sa.height} vs ${sb.width}x${sb.height}`)
    app.exit(1)
    return
  }

  const pa = a.getBitmap(), pb = b.getBitmap()
  const x0 = full ? 0 : Math.floor(sa.width * 0.30)
  const x1 = full ? sa.width : Math.floor(sa.width * 0.78)

  let sum = 0, n = 0, changed = 0, maxDiff = 0
  let darkA = 0, darkB = 0, blownA = 0, blownB = 0
  for (let y = 0; y < sa.height; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * sa.width + x) * 4
      // getBitmap is BGRA; channel order does not matter for a magnitude.
      const d = (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])) / 3
      sum += d; n++
      if (d > 2) changed++
      if (d > maxDiff) maxDiff = d
      const la = (pa[i] + pa[i + 1] + pa[i + 2]) / 3
      const lb = (pb[i] + pb[i + 1] + pb[i + 2]) / 3
      if (la < 16) darkA++
      if (lb < 16) darkB++
      if (la > 250) blownA++
      if (lb > 250) blownB++
    }
  }

  const pct = v => (100 * v / n).toFixed(2)
  console.log(`region ${x0}..${x1} of ${sa.width}x${sa.height}, ${n} px`)
  console.log(`mean abs difference : ${(sum / n).toFixed(3)} of 255`)
  console.log(`pixels changed >2   : ${pct(changed)}%   (max single-pixel ${maxDiff.toFixed(0)})`)
  console.log(`dark px (<16)       : A ${pct(darkA)}%  B ${pct(darkB)}%`)
  console.log(`blown px (>250)     : A ${pct(blownA)}%  B ${pct(blownB)}%`)
  app.exit(0)
})
