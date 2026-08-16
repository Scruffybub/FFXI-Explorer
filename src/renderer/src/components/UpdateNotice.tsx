import { useEffect, useState } from 'react'
import type { UpdateInfo } from '../../../preload/index'

/**
 * The "a new version is available" popup.
 *
 * Shown only when a check found something newer — there is deliberately no
 * "you are up to date" dialog on startup, because an app that interrupts you to
 * say nothing happened is worse than one that stays quiet.
 *
 * An installed build downloads the installer and runs it; a portable build
 * downloads the new exe and opens its folder, because a running portable
 * executable cannot replace itself.
 */

type Stage =
  | { name: 'offer' }
  | { name: 'downloading'; received: number; total: number }
  | { name: 'ready'; path: string; launched: boolean }
  | { name: 'failed'; message: string }

function formatMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/**
 * The release notes are markdown written for GitHub. Rendering them properly
 * would mean a markdown dependency for a box this size, so this takes the
 * opening prose and strips the handful of marks that actually show up.
 */
function summarise(notes: string, limit = 400): string {
  const text = notes
    .split(/\r?\n/)
    .filter(line => !/^\s*\|/.test(line))      // tables read as noise unrendered
    .join('\n')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > limit ? text.slice(0, limit).trimEnd() + '…' : text
}

export default function UpdateNotice({
  info, onDismiss, onDisableChecks,
}: {
  info: UpdateInfo
  onDismiss: () => void
  onDisableChecks: () => void
}) {
  const [stage, setStage] = useState<Stage>({ name: 'offer' })

  useEffect(() => window.updates.onProgress(p => {
    setStage(s => (s.name === 'downloading' ? { ...s, received: p.received, total: p.total } : s))
  }), [])

  const startDownload = async () => {
    if (!info.asset) return
    setStage({ name: 'downloading', received: 0, total: info.asset.size })
    const result = await window.updates.download(info.asset.url, info.asset.name, info.asset.size)
    if (result.status === 'error') {
      setStage({ name: 'failed', message: result.message })
      return
    }
    const { launched } = await window.updates.install(result.path)
    setStage({ name: 'ready', path: result.path, launched })
  }

  const pct = stage.name === 'downloading' && stage.total > 0
    ? Math.round((stage.received / stage.total) * 100)
    : 0

  return (
    <div className="modal-backdrop" onClick={stage.name === 'downloading' ? undefined : onDismiss}>
      <div className="modal update-notice" onClick={e => e.stopPropagation()}>
        <h2>FFXI Explorer {info.version} is available</h2>

        {stage.name === 'offer' && (
          <>
            {info.notes && <p className="update-notes">{summarise(info.notes)}</p>}
            <div className="update-actions">
              {info.asset ? (
                <button className="primary" onClick={startDownload}>
                  {info.portable
                    ? `Download (${formatMB(info.asset.size)})`
                    : `Download and install (${formatMB(info.asset.size)})`}
                </button>
              ) : (
                <button className="primary" onClick={() => window.updates.openPage(info.pageUrl)}>
                  Open the download page
                </button>
              )}
              <button onClick={() => window.updates.openPage(info.pageUrl)}>What's new</button>
              <button onClick={onDismiss}>Later</button>
            </div>
            {info.portable && info.asset && (
              <p className="note small">
                This is the portable build, which can't replace itself while it's
                running. The new copy downloads and its folder opens, so you can
                swap it in.
              </p>
            )}
            <button className="link-btn" onClick={onDisableChecks}>
              Stop checking on startup
            </button>
          </>
        )}

        {stage.name === 'downloading' && (
          <>
            <p className="note small">
              Downloading {formatMB(stage.received)}
              {stage.total > 0 && ` of ${formatMB(stage.total)}`}…
            </p>
            <div className="progress"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
          </>
        )}

        {stage.name === 'ready' && (
          <>
            <p className="note small">
              {stage.launched
                ? 'The installer is opening. This window will close so it can replace the app.'
                : 'Downloaded. Its folder is open — close FFXI Explorer and swap the new file in.'}
            </p>
            <div className="update-actions">
              <button className="primary" onClick={onDismiss}>Close</button>
            </div>
          </>
        )}

        {stage.name === 'failed' && (
          <>
            <p className="note small">The download failed: {stage.message}</p>
            <div className="update-actions">
              <button className="primary" onClick={() => window.updates.openPage(info.pageUrl)}>
                Download in a browser
              </button>
              <button onClick={onDismiss}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
