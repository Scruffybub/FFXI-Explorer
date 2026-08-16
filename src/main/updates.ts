import { app, shell } from 'electron'
import { createWriteStream, promises as fs } from 'fs'
import { join } from 'path'
import { get as httpsGet } from 'https'
import { spawn } from 'child_process'
import type { IncomingMessage } from 'http'
import { isNewer } from './version'

/**
 * Update check against the project's GitHub releases.
 *
 * Deliberately hand-rolled rather than electron-updater. The packaged app ships
 * `out/**` and `package.json` only — `node_modules` is not packaged — so a main
 * process dependency would have to be bundled into the main chunk to exist at
 * runtime, and electron-updater cannot install a *portable* build at all. This
 * covers both artifacts with the standard library and about a hundred lines.
 *
 * Failure is always silent. An update check that interrupts startup with an
 * error box because GitHub was unreachable is worse than no update check.
 */

const REPO = 'Scruffybub/FFXI-Explorer'
const API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

/** Hosts a release asset may be fetched from. GitHub redirects downloads to a CDN. */
const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

export interface UpdateInfo {
  version: string
  /** Release title, falling back to the tag. */
  name: string
  /** Release notes, as markdown. Trimmed — the popup shows a summary. */
  notes: string
  pageUrl: string
  /** The asset matching how this copy was installed, if the release carries one. */
  asset: { name: string; url: string; size: number } | null
  /** Portable builds cannot replace themselves while running. */
  portable: boolean
}

/**
 * A portable build sets this; an installed one does not. It decides both which
 * asset to offer and whether the download can install itself.
 */
function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE)
}

function requestJson(url: string, redirectsLeft = 3): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_HOSTS.has(new URL(url).host)) return reject(new Error('host not allowed'))
    const req = httpsGet(url, {
      headers: {
        // GitHub rejects API requests without one.
        'User-Agent': `FFXI-Explorer/${app.getVersion()}`,
        Accept: 'application/vnd.github+json',
      },
      timeout: 8000,
    }, (res: IncomingMessage) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'))
        return resolve(requestJson(new URL(res.headers.location, url).toString(), redirectsLeft - 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        // 404 is the normal answer while the repository is private or has no
        // release yet, so it is not worth shouting about.
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c as Buffer))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (err) { reject(err) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
  })
}

/** Resolves to an update if the latest release is newer than this build, else null. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  let release: {
    tag_name?: string
    name?: string
    body?: string
    html_url?: string
    draft?: boolean
    prerelease?: boolean
    assets?: { name?: string; browser_download_url?: string; size?: number }[]
  }
  try {
    release = await requestJson(API) as typeof release
  } catch (err) {
    console.log('[UPDATE] check failed: ' + (err as Error).message)
    return null
  }

  const tag = release.tag_name ?? ''
  if (!tag || release.draft) return null
  if (!isNewer(tag, app.getVersion())) {
    console.log(`[UPDATE] ${tag} is not newer than ${app.getVersion()}`)
    return null
  }

  const portable = isPortable()
  const wanted = portable ? '-portable.exe' : '-setup.exe'
  const match = (release.assets ?? []).find(a => (a.name ?? '').toLowerCase().endsWith(wanted))

  console.log(`[UPDATE] ${tag} available (running ${app.getVersion()}), ` +
    `asset ${match?.name ?? 'none'}, portable=${portable}`)

  return {
    version: tag.replace(/^v/i, ''),
    name: release.name || tag,
    notes: (release.body ?? '').trim(),
    pageUrl: release.html_url || RELEASES_PAGE,
    asset: match?.browser_download_url
      ? { name: match.name ?? 'update.exe', url: match.browser_download_url, size: match.size ?? 0 }
      : null,
    portable,
  }
}

/**
 * Download an asset to a temp folder, reporting progress. Resolves to the path.
 *
 * The size is checked against what the release advertised: a truncated download
 * that still "succeeds" would otherwise be handed to the user as an installer.
 */
export function downloadUpdate(
  url: string,
  name: string,
  expectedSize: number,
  onProgress: (received: number, total: number) => void,
  redirectsLeft = 5,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_HOSTS.has(new URL(url).host)) return reject(new Error('host not allowed'))
    const target = join(app.getPath('temp'), name)

    const req = httpsGet(url, {
      headers: { 'User-Agent': `FFXI-Explorer/${app.getVersion()}` },
      timeout: 30000,
    }, (res: IncomingMessage) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'))
        return resolve(downloadUpdate(
          new URL(res.headers.location, url).toString(),
          name, expectedSize, onProgress, redirectsLeft - 1,
        ))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode}`))
      }

      const total = Number(res.headers['content-length'] ?? expectedSize) || expectedSize
      let received = 0
      const file = createWriteStream(target)
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        onProgress(received, total)
      })
      res.pipe(file)
      file.on('finish', () => {
        file.close(async () => {
          try {
            const { size } = await fs.stat(target)
            if (expectedSize > 0 && size !== expectedSize) {
              await fs.unlink(target).catch(() => {})
              return reject(new Error(`downloaded ${size} bytes, expected ${expectedSize}`))
            }
            console.log(`[UPDATE] downloaded ${target} (${size} bytes)`)
            resolve(target)
          } catch (err) {
            reject(err)
          }
        })
      })
      file.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
  })
}

/**
 * Hand the downloaded file over.
 *
 * An installed build launches the installer and quits so it can replace the
 * files it is holding open. A portable build cannot replace itself while it is
 * running, so it opens the folder and leaves the swap to the user — pretending
 * otherwise would leave them with a half-updated copy.
 */
export async function installUpdate(filePath: string): Promise<{ launched: boolean }> {
  if (isPortable()) {
    shell.showItemInFolder(filePath)
    return { launched: false }
  }
  const child = spawn(filePath, [], { detached: true, stdio: 'ignore' })
  child.unref()
  setTimeout(() => app.quit(), 800)
  return { launched: true }
}

export { RELEASES_PAGE }
