import type { ModelSettings, ToneMappingMode } from '../lib/settings'
import type { ParsedAnimation } from '../lib/ffxi-dat'

/**
 * The model viewer's right-hand panel: playback and studio lighting.
 *
 * Mirrors the zone panel's layout and controls so the two feel like one app,
 * but carries only settings that mean something for a single model on a
 * backdrop.
 */

const TONE_OPTIONS: { value: ToneMappingMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'linear', label: 'Linear' },
  { value: 'reinhard', label: 'Reinhard' },
  { value: 'cineon', label: 'Cineon' },
  { value: 'aces', label: 'ACES Filmic' },
  { value: 'agx', label: 'AgX' },
  { value: 'neutral', label: 'Neutral' },
]

function Slider({
  label, value, min, max, step, onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <label className="control">
      <span className="control-row">
        {label}
        <span className="value">{value.toFixed(2)}</span>
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
      />
    </label>
  )
}

export default function ModelPanel({
  settings, onChange,
  animations, clipIndex, onClipChange,
  playing, onPlayingChange, speed, onSpeedChange,
}: {
  settings: ModelSettings
  onChange: (patch: Partial<ModelSettings>) => void
  animations: ParsedAnimation[]
  clipIndex: number | null
  onClipChange: (i: number | null) => void
  playing: boolean
  onPlayingChange: (v: boolean) => void
  speed: number
  onSpeedChange: (v: number) => void
}) {
  return (
    <div className="panel">
      {animations.length > 0 && (
        <div className="section">
          <div className="section-head static">ANIMATION</div>
          <div className="section-body">
            <label className="control">
              <span>Clip</span>
              <select
                value={clipIndex === null ? 'all' : String(clipIndex)}
                onChange={e => onClipChange(e.target.value === 'all' ? null : Number(e.target.value))}
              >
                {/* FFXI splits a pose across blocks — upper body, lower body,
                    extras — so playing them together is the composed result the
                    game shows. Individual clips are for inspecting one part. */}
                <option value="all">All together ({animations.length})</option>
                {animations.map((a, i) => (
                  <option key={i} value={i}>
                    Clip {i + 1} — {a.frameCount}f, {a.bones.length} bones
                  </option>
                ))}
              </select>
            </label>

            <div className="anim-buttons">
              <button onClick={() => onPlayingChange(!playing)}>
                {playing ? 'Pause' : 'Play'}
              </button>
            </div>

            <Slider
              label="Speed" value={speed} min={0.1} max={3} step={0.1}
              onChange={onSpeedChange}
            />
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-head static">LIGHTING</div>
        <div className="section-body">
          <Slider
            label="Ambient" value={settings.ambientIntensity} min={0} max={3} step={0.05}
            onChange={v => onChange({ ambientIntensity: v })}
          />
          <Slider
            label="Key light" value={settings.keyIntensity} min={0} max={5} step={0.05}
            onChange={v => onChange({ keyIntensity: v })}
          />
          <Slider
            label="Fill light" value={settings.fillIntensity} min={0} max={3} step={0.05}
            onChange={v => onChange({ fillIntensity: v })}
          />
          <Slider
            label="Key angle" value={settings.keyAzimuth} min={-180} max={180} step={1}
            onChange={v => onChange({ keyAzimuth: v })}
          />
          <Slider
            label="Roughness" value={settings.roughness} min={0} max={1} step={0.01}
            onChange={v => onChange({ roughness: v })}
          />
          <p className="note small">
            FFXI's art is lit flat by the game, so its textures already contain
            most of the shading. Heavy key light tends to double it up.
          </p>
        </div>
      </div>

      <div className="section">
        <div className="section-head static">DISPLAY</div>
        <div className="section-body">
          <label className="control">
            <span>Tone mapping</span>
            <select
              value={settings.toneMapping}
              onChange={e => onChange({ toneMapping: e.target.value as ToneMappingMode })}
            >
              {TONE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <Slider
            label="Exposure" value={settings.exposure} min={0.1} max={3} step={0.05}
            onChange={v => onChange({ exposure: v })}
          />
          <label className="control color">
            <span>Background</span>
            <input
              type="color" value={settings.background}
              onChange={e => onChange({ background: e.target.value })}
            />
          </label>
          <label className="control toggle">
            <input
              type="checkbox" checked={settings.showGround}
              onChange={e => onChange({ showGround: e.target.checked })}
            />
            <span>Ground plane</span>
          </label>
          <label className="control toggle">
            <input
              type="checkbox" checked={settings.wireframe}
              onChange={e => onChange({ wireframe: e.target.checked })}
            />
            <span>Wireframe</span>
          </label>
        </div>
      </div>
    </div>
  )
}
