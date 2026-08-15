import { Label } from './Info'
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
  label, value, min, max, step, onChange, info,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  info?: string
}) {
  return (
    <label className="control">
      <span className="control-row">
        <Label text={label} info={info} />
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
              <Label
                text="Clip"
                info="FFXI splits one pose across several blocks — upper body, lower body, extras — so All together is the composed result the game shows. Individual clips are for inspecting one part. A character's animations come from separate files, where a set holds many unrelated motions, so those default to the first clip instead."
              />
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
              info="Playback rate for the clip. FFXI's stored frame rate is not always what the game plays back at, so this is worth nudging when a motion looks hurried."
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
            info="Even light from every direction, so nothing goes fully black. FFXI's textures already contain most of their shading, so these models take more ambient and less key light than a modern asset would."
          />
          <Slider
            label="Key light" value={settings.keyIntensity} min={0} max={5} step={0.05}
            onChange={v => onChange({ keyIntensity: v })}
            info="The main directional light, which gives the model its form and its shadow side. Heavy key light doubles up with the shading already painted into the texture."
          />
          <Slider
            label="Fill light" value={settings.fillIntensity} min={0} max={3} step={0.05}
            onChange={v => onChange({ fillIntensity: v })}
            info="A softer light from the opposite side, lifting the shadows the key light leaves behind."
          />
          <Slider
            label="Key angle" value={settings.keyAzimuth} min={-180} max={180} step={1}
            onChange={v => onChange({ keyAzimuth: v })}
            info="Swings the key light around the model, in degrees. Useful for finding an angle that shows off a piece of armour rather than flattening it."
          />
          <Slider
            label="Roughness" value={settings.roughness} min={0} max={1} step={0.01}
            onChange={v => onChange({ roughness: v })}
            info="Surface finish: 1 is cloth-matte, 0 is polished metal. FFXI stores no material data, so this applies to the whole model at once."
          />
        </div>
      </div>

      <div className="section">
        <div className="section-head static">DISPLAY</div>
        <div className="section-body">
          <label className="control">
            <Label
              text="Tone mapping"
              info="How high dynamic range is squeezed into a displayable image. ACES is filmic and contrasty, AgX gentler on bright colour, Neutral closest to the raw texture values."
            />
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
            info="Overall brightness going into tone mapping, like a camera's exposure. Raising it lifts the darks rather than clipping the brights."
          />
          <label className="control color">
            <Label
              text="Background"
              info="The backdrop behind the model. A mid grey judges colour most honestly; black and white both flatter it."
            />
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
            <Label
              text="Ground plane"
              info="A floor under the model, which gives its feet somewhere to sit and catches its shadow. Off leaves it floating against the background."
            />
          </label>
          <label className="control toggle">
            <input
              type="checkbox" checked={settings.wireframe}
              onChange={e => onChange({ wireframe: e.target.checked })}
            />
            <Label
              text="Wireframe"
              info="Draw the model as edges only, which is the quickest way to see how its mesh is built and where the seams between equipment pieces fall."
            />
          </label>
        </div>
      </div>
    </div>
  )
}
