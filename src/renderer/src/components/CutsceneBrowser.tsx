import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { listMovies, MoviePlayer, type MovieEntry } from '../lib/moviePlayer'
import { ZONES, type ZoneEntry } from '../lib/zoneList'
import EventReader from './EventReader'

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const EVENT_ZONES = ZONES.filter(z => z.events)

/**
 * Models -> Cutscenes. Movies: the install's pre-rendered movie, played with
 * its soundtrack (lib/moviePlayer). Events: each zone's scripts read as
 * steps (EventReader); see HANDOFF "Cutscene player".
 */
export default function CutsceneBrowser({ ffxiPath, head }: { ffxiPath: string; head: ReactNode }) {
  const [mode, setMode] = useState<'movies' | 'events'>('movies')
  const [movies, setMovies] = useState<MovieEntry[] | null>(null)
  const [chosen, setChosen] = useState<MovieEntry | null>(null)
  const [zone, setZone] = useState<ZoneEntry | null>(null)
  const [search, setSearch] = useState('')
  useEffect(() => { void listMovies(ffxiPath).then(m => { setMovies(m); if (m.length === 1) setChosen(m[0]) }) }, [ffxiPath])
  const zones = useMemo(() => {
    const q = search.trim().toLowerCase()
    return EVENT_ZONES.filter(z => !q || z.name.toLowerCase().includes(q) || String(z.id) === q)
  }, [search])

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-head">
          {head}
          <div className="mode-switch">
            <button className={mode === 'movies' ? 'active' : ''} onClick={() => setMode('movies')}>Movies</button>
            <button className={mode === 'events' ? 'active' : ''} onClick={() => setMode('events')}>Events</button>
          </div>
          {mode === 'events' && <input className="search" placeholder="Search zones..." value={search} onChange={e => setSearch(e.target.value)} />}
        </div>
        {mode === 'movies' ? (
          <ul className="zone-list">
            {!movies && <li className="empty">Reading the install…</li>}
            {movies?.length === 0 && <li className="empty">No movies in this install's mov folder.</li>}
            {movies?.map(m => (
              <li key={m.video}>
                <button className={chosen === m ? 'active' : ''} onClick={() => setChosen(m)}>
                  <span className="zone-name">{m.name}</span>
                  <span className="zone-path">{m.video}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="zone-list">
            {zones.map(z => (
              <li key={z.id}>
                <button className={zone === z ? 'active' : ''} onClick={() => setZone(z)}>
                  <span className="zone-name">{z.name}</span>
                  <span className="zone-path">{z.events}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      {mode === 'movies' ? (
        <main className="viewport sound-view">
          {chosen ? <MovieView key={chosen.video} root={ffxiPath} movie={chosen} /> : (
            <div className="placeholder"><h2>Pick a movie</h2></div>
          )}
        </main>
      ) : (
        <main className="viewport sound-view event-main">
          {zone ? <EventReader root={ffxiPath} zone={zone} /> : (
            <div className="placeholder"><h2>Pick a zone</h2><p>Read its NPCs' conversations and its cutscenes, step by step.</p></div>
          )}
        </main>
      )}
    </>
  )
}

function MovieView({ root, movie }: { root: string; movie: MovieEntry }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const player = useRef<MoviePlayer | null>(null)
  const [ready, setReady] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const [volume, setVolume] = useState(0.7)

  useEffect(() => {
    if (!canvas.current) return
    const p = new MoviePlayer(root, movie, canvas.current)
    player.current = p
    p.onState = () => setTick(t => t + 1)
    p.open(setProgress).then(() => { p.setVolume(volume); setReady(true) }, err => setError(String(err)))
    if (new URLSearchParams(window.location.search).has('census')) (window as unknown as Record<string, unknown>).__movie = p
    return () => { p.dispose(); player.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, movie])
  useEffect(() => { player.current?.setVolume(volume) }, [volume])

  const p = player.current
  return (
    <div className="sound-player movie-player">
      <h2>{movie.name}</h2>
      <div className="movie-frame">
        <canvas ref={canvas} width={512} height={336} onClick={() => (p?.playing ? p.pause() : p?.play())} />
        {!ready && !error && <div className="movie-loading">Preparing the movie… {Math.round(progress * 100)}%</div>}
      </div>
      {error && <p className="error-text">{error}</p>}
      {ready && p && (
        <div className="sound-controls">
          <button className="place-btn" onClick={() => (p.playing ? p.pause() : p.play())}>{p.playing ? 'Pause' : 'Play'}</button>
          <input
            className="movie-seek" type="range" min={0} max={p.duration} step={0.1} value={p.time}
            onChange={e => void p.seek(Number(e.target.value))}
          />
          <span className="sound-time">{fmt(p.time)} / {fmt(p.duration)}</span>
          <label className="sound-volume">
            <span>Volume</span>
            <input type="range" min={0} max={1} step={0.05} value={volume} onChange={e => setVolume(Number(e.target.value))} />
          </label>
        </div>
      )}
    </div>
  )
}
