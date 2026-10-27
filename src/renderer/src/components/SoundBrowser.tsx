import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DecodedAudio } from '../lib/bgw'
import { decodeSound, listEffects, listMusic, type SoundEntry } from '../lib/soundLibrary'
import { arrange, encodeAudio, type ExportFormat } from '../lib/audioExport'

const FORMATS: { id: ExportFormat; label: string; ext: string; kind: string }[] = [
  { id: 'wav', label: 'WAV (exact, largest)', ext: 'wav', kind: 'WAV audio' },
  { id: 'flac', label: 'FLAC (exact, about half)', ext: 'flac', kind: 'FLAC audio' },
  { id: 'opus', label: 'Ogg Opus (small)', ext: 'ogg', kind: 'Ogg Opus audio' },
]

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/**
 * Models -> Sounds (lib/soundLibrary, lib/audioExport): the game's music and
 * sound effects, to play and to export as WAV, FLAC or Ogg Opus.
 */
export default function SoundBrowser({ ffxiPath, head }: { ffxiPath: string; head: ReactNode }) {
  const [kind, setKind] = useState<'music' | 'effect'>('music')
  const [music, setMusic] = useState<SoundEntry[] | null>(null)
  const [effects, setEffects] = useState<SoundEntry[] | null>(null)
  const [search, setSearch] = useState('')
  const [folder, setFolder] = useState<number | null>(null)
  const [chosen, setChosen] = useState<SoundEntry | null>(null)
  const [audio, setAudio] = useState<DecodedAudio | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loop, setLoop] = useState(true)
  const [volume, setVolume] = useState(0.6)
  const [format, setFormat] = useState<ExportFormat>('flac')
  const [loopTwice, setLoopTwice] = useState(true)
  const [note, setNote] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => { void listMusic(ffxiPath).then(setMusic) }, [ffxiPath])
  useEffect(() => {
    if (kind === 'effect' && !effects) void listEffects(ffxiPath).then(setEffects)
  }, [kind, effects, ffxiPath])

  const folders = useMemo(() => [...new Set((effects ?? []).map(e => e.folder!))], [effects])
  const list = useMemo(() => {
    const all = kind === 'music' ? music ?? [] : effects ?? []
    const q = search.trim().toLowerCase()
    return all.filter(e => (kind === 'music' || folder === null || e.folder === folder) && (!q || e.label.toLowerCase().includes(q) || String(e.id).includes(q)))
  }, [kind, music, effects, search, folder])

  // ── Playback: one AudioBufferSourceNode at a time, restarted to seek. ──
  const ctx = useRef<AudioContext | null>(null)
  const gain = useRef<GainNode | null>(null)
  const source = useRef<AudioBufferSourceNode | null>(null)
  const buffer = useRef<AudioBuffer | null>(null)
  const startedAt = useRef(0)   // ctx time the current play began
  const offset = useRef(0)      // seconds into the sound it began at
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)

  const ensure = () => {
    if (!ctx.current) {
      ctx.current = new AudioContext()
      gain.current = ctx.current.createGain()
      gain.current.connect(ctx.current.destination)
    }
    gain.current!.gain.value = volume
    return ctx.current
  }
  useEffect(() => { if (gain.current) gain.current.gain.value = volume }, [volume])
  useEffect(() => () => { source.current?.stop(); void ctx.current?.close() }, [])

  /** Where playback is, seconds, folding loops back into the sound. */
  const now = useCallback(() => {
    const b = buffer.current, c = ctx.current
    if (!b || !c || !source.current) return offset.current
    let t = offset.current + (c.currentTime - startedAt.current)
    const ls = source.current.loop ? source.current.loopStart : 0
    if (source.current.loop && t > b.duration) t = ls + ((t - ls) % (b.duration - ls))
    return Math.min(t, b.duration)
  }, [])

  const stopSource = () => {
    if (source.current) { source.current.onended = null; try { source.current.stop() } catch { /* stopped */ } source.current.disconnect(); source.current = null }
  }
  const startAt = useCallback((at: number) => {
    const b = buffer.current
    if (!b || !audio) return
    const c = ensure()
    if (c.state === 'suspended') void c.resume()
    stopSource()
    const s = c.createBufferSource()
    s.buffer = b
    if (loop) {
      s.loop = true
      s.loopStart = audio.loopStartSample !== null ? audio.loopStartSample / audio.sampleRate : 0
      s.loopEnd = b.duration
    }
    s.connect(gain.current!)
    s.onended = () => { if (source.current === s) { source.current = null; setPlaying(false); offset.current = 0; setPosition(0) } }
    s.start(0, Math.max(0, Math.min(at, b.duration - 0.01)))
    source.current = s
    startedAt.current = c.currentTime
    offset.current = at
    setPlaying(true)
  }, [audio, loop])
  const pause = () => { offset.current = now(); stopSource(); setPlaying(false) }
  const stopAll = () => { stopSource(); offset.current = 0; setPosition(0); setPlaying(false) }

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => { setPosition(now()); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, now])

  const choose = useCallback(async (e: SoundEntry) => {
    stopSource(); setPlaying(false); offset.current = 0; setPosition(0)
    setChosen(e); setAudio(null); setError(null); setNote(null)
    const r = await decodeSound(ffxiPath, e)
    if (typeof r === 'string') { setError(r); return }
    const c = ensure()
    const b = c.createBuffer(r.channels.length, r.channels[0].length, r.sampleRate)
    r.channels.forEach((ch, i) => b.copyToChannel(ch as Float32Array<ArrayBuffer>, i))
    buffer.current = b
    setAudio(r)
    setLoop(e.kind === 'music')
  }, [ffxiPath])
  // A new choice plays once it has decoded.
  const autoplay = useRef<SoundEntry | null>(null)
  useEffect(() => { if (audio && chosen && autoplay.current !== chosen) { autoplay.current = chosen; startAt(0) } }, [audio, chosen, startAt])

  // ── Waveform: min and max per pixel column, drawn once per sound. ──
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = canvas.current
    if (!cv || !audio) return
    const w = cv.width = cv.clientWidth * devicePixelRatio, h = cv.height = cv.clientHeight * devicePixelRatio
    const g = cv.getContext('2d')!
    g.clearRect(0, 0, w, h)
    const data = audio.channels[0], per = Math.max(1, Math.floor(data.length / w))
    g.fillStyle = getComputedStyle(cv).color
    for (let x = 0; x < w; x++) {
      let lo = 1, hi = -1
      for (let i = x * per, end = Math.min(data.length, i + per); i < end; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v }
      if (hi < lo) continue
      g.fillRect(x, ((1 - hi) / 2) * h, 1, Math.max(1, ((hi - lo) / 2) * h))
    }
  }, [audio])

  const duration = audio ? audio.channels[0].length / audio.sampleRate : 0
  const loopAt = audio?.loopStartSample != null ? audio.loopStartSample / audio.sampleRate : null

  const exportSound = async () => {
    if (!audio || !chosen) return
    setExporting(true); setNote(null)
    try {
      const f = FORMATS.find(x => x.id === format)!
      const bytes = await encodeAudio(arrange(audio, chosen.kind === 'music' && loopTwice), format)
      const name = (chosen.kind === 'music' ? `ffxi-music-${String(chosen.id).padStart(3, '0')}` : `ffxi-sound-${chosen.id}`) + '.' + f.ext
      const saved = await window.ffxi.saveFile(bytes, name, f.kind, f.ext)
      if (saved) setNote('Saved ' + saved.split(/[\\/]/).pop())
    } catch (err) {
      setNote('Export failed: ' + String(err))
    } finally {
      setExporting(false)
    }
  }

  // ?census=1: export without the save dialog, for harness checks.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('census')) return
    const w = window as unknown as Record<string, unknown>
    w.__soundChoose = async (kindName: 'music' | 'effect', id: number) => {
      const all = kindName === 'music' ? music ?? [] : effects ?? await listEffects(ffxiPath)
      const e = all.find(x => x.id === id)
      if (e) await choose(e)
      return e?.label ?? null
    }
    w.__soundExport = async (f: ExportFormat, twice: boolean) => {
      if (!audio || !chosen) return null
      const arranged = arrange(audio, chosen.kind === 'music' && twice)
      const bytes = await encodeAudio(arranged, f)
      return { bytes, samples: arranged.channels[0].length, sampleRate: arranged.sampleRate, channels: arranged.channels.length, arranged }
    }
  }, [music, effects, ffxiPath, choose, audio, chosen])

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-head">
          {head}
          <div className="mode-switch">
            <button className={kind === 'music' ? 'active' : ''} onClick={() => { setKind('music'); setSearch('') }}>Music</button>
            <button className={kind === 'effect' ? 'active' : ''} onClick={() => { setKind('effect'); setSearch('') }}>Sound effects</button>
          </div>
          <input className="search" placeholder={kind === 'music' ? 'Search music or zones...' : 'Search by number...'} value={search} onChange={e => setSearch(e.target.value)} />
          {kind === 'effect' && folders.length > 0 && (
            <select className="category-select" value={folder ?? ''} onChange={e => setFolder(e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">All folders ({effects?.length ?? 0})</option>
              {folders.map(f => <option key={f} value={f}>{f * 1000}–{f * 1000 + 999}</option>)}
            </select>
          )}
        </div>
        <ul className="zone-list">
          {(kind === 'music' ? !music : !effects) && <li className="empty">Reading the install…</li>}
          {list.slice(0, 2000).map(e => (
            <li key={e.kind + e.id}>
              <button className={chosen === e ? 'active' : ''} onClick={() => void choose(e)}>
                <span className="zone-name">{e.label}</span>
                <span className="zone-path">{e.path}</span>
              </button>
            </li>
          ))}
          {list.length > 2000 && <li className="empty">{list.length - 2000} more: pick a folder or search.</li>}
        </ul>
      </aside>

      <main className="viewport sound-view">
        {!chosen && (
          <div className="placeholder">
            <h2>Pick a sound</h2>
            <p>{music ? `${music.length} music tracks` : 'Music'} and the game's sound effects, played and exported from your install.</p>
          </div>
        )}
        {chosen && (
          <div className="sound-player">
            <h2>{chosen.label}</h2>
            <p className="note small">{chosen.path}</p>
            {error && <p className="error-text">{error}</p>}
            {!audio && !error && <p className="note">Decoding…</p>}
            {audio && (
              <>
                <p className="note small">
                  {fmt(duration)} · {audio.sampleRate.toLocaleString()} Hz · {audio.channels.length === 1 ? 'mono' : 'stereo'}
                  {loopAt === null ? '' : loopAt < 0.05 ? ' · loops from the start' : ` · loops from ${fmt(loopAt)}`}
                </p>
                <div
                  className="sound-wave"
                  onClick={e => {
                    const r = e.currentTarget.getBoundingClientRect()
                    startAt(((e.clientX - r.left) / r.width) * duration)
                  }}
                  title="Click to play from there"
                >
                  <canvas ref={canvas} />
                  {loopAt !== null && <div className="sound-loop" style={{ left: `${(loopAt / duration) * 100}%` }} title="Loop point" />}
                  <div className="sound-head" style={{ left: `${(position / duration) * 100}%` }} />
                </div>
                <div className="sound-controls">
                  <button className="place-btn" onClick={() => (playing ? pause() : startAt(offset.current))}>{playing ? 'Pause' : 'Play'}</button>
                  <button className="place-btn" onClick={stopAll}>Stop</button>
                  <span className="sound-time">{fmt(position)} / {fmt(duration)}</span>
                  <label className="toggle-row">
                    <input type="checkbox" checked={loop} onChange={e => { setLoop(e.target.checked); if (playing) setTimeout(() => startAt(now()), 0) }} />
                    <span>Loop</span>
                  </label>
                  <label className="sound-volume">
                    <span>Volume</span>
                    <input type="range" min={0} max={1} step={0.05} value={volume} onChange={e => setVolume(Number(e.target.value))} />
                  </label>
                </div>
                <div className="sound-export">
                  <select className="category-select" value={format} onChange={e => setFormat(e.target.value as ExportFormat)}>
                    {FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                  {chosen.kind === 'music' && loopAt !== null && (
                    <label className="toggle-row" title="Write the intro, the loop twice, then fade out over 10 seconds, the usual way game music is saved. Off writes the file once, as it is.">
                      <input type="checkbox" checked={loopTwice} onChange={e => setLoopTwice(e.target.checked)} />
                      <span>Loop twice, then fade out</span>
                    </label>
                  )}
                  <button className="place-btn" disabled={exporting} onClick={() => void exportSound()}>{exporting ? 'Exporting…' : 'Export'}</button>
                  {note && <span className="note small">{note}</span>}
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </>
  )
}
