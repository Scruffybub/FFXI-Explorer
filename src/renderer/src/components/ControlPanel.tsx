import { useState, useMemo } from 'react'
import type {
  LightingSettings, MusicSettings, PointLightSettings, PointLightSpec,
  PostSettings, SceneSettings,
} from '../lib/settings'
import { PRESETS } from '../lib/settings'
import type { MusicStatus } from '../lib/zoneMusic'

interface ControlPanelProps {
  lighting: LightingSettings
  post: PostSettings
  scene: SceneSettings
  pointLights: PointLightSettings
  selectedLightId: number | null
  placingLight: boolean
  /** Weather states the loaded zone carries geometry for; varies per zone. */
  weatherStates: string[]
  music: MusicSettings
  musicStatus: MusicStatus
  onMusic: (patch: Partial<MusicSettings>) => void
  onLighting: (patch: Partial<LightingSettings>) => void
  onPost: (patch: Partial<PostSettings>) => void
  onScene: (patch: Partial<SceneSettings>) => void
  onPointLights: (patch: Partial<PointLightSettings>) => void
  onUpdateLight: (id: number, patch: Partial<PointLightSpec>) => void
  onRemoveLight: (id: number) => void
  onSelectLight: (id: number | null) => void
  onTogglePlacing: () => void
  onPreset: (index: number) => void
  onReset: () => void
}

/**
 * Readable names for the weather-state tokens, which are FFXI's own truncated
 * eight-character field. Anything not listed falls back to the raw token rather
 * than being hidden — the vocabulary is not fully mapped and a zone showing
 * "squl" is more useful than a zone silently missing a state.
 */
const WEATHER_LABELS: Record<string, string> = {
  suny: 'Sunny',
  fine: 'Fine',
  clod: 'Cloudy',
  kumo: 'Cloud (kumo)',
  kumori: 'Overcast (kumori)',
  mist: 'Mist',
  fogd: 'Fog',
  wind: 'Wind',
  thdr: 'Thunder',
  kaminari: 'Lightning (kaminari)',
  dark: 'Dark',
  star: 'Stars',
  niji: 'Rainbow (niji)',
  even: 'Evening',
  yuhiumi: 'Sunset over sea',
  cldsea: 'Cloud sea',
  squl: 'Squall',
  ukfi: 'Storm (ukfi)',
  uksy: 'Storm sky (uksy)',
  strm: 'Storm',
  tenkyu: 'Celestial sphere',
  effect: 'Effects (mixed)',
  warp: 'Warp lights',
  bahakumo: 'Bahamut cloud',
}

/**
 * Says what the music is doing in words, including why it is not playing.
 * "Silent" and "cannot decode" are very different states and a blank panel
 * would make them look identical.
 */
function describeMusic(s: MusicStatus): string {
  switch (s.state) {
    case 'silent':
      return 'This zone has no music of its own — 151 of 298 are silent in FFXI’s own tables.'
    case 'loading':
      return `Loading track ${s.track}…`
    case 'playing':
      return `Track ${s.track} · ${Math.floor(s.seconds / 60)}:` +
        `${String(Math.round(s.seconds % 60)).padStart(2, '0')}` +
        (s.loops ? ' · looping' : '')
    case 'unsupported':
      return `Track ${s.track} is encrypted ATRAC3 (codec ${s.codec}), which is not ` +
        'decoded yet. 31 of the 74 zone tracks are in this format.'
    case 'missing':
      return `Track ${s.track} is not in this installation.`
    case 'error':
      return `Track ${s.track} failed: ${s.message}`
  }
}

function Section({
  title, children, defaultOpen = true,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="section">
      <button className="section-head" onClick={() => setOpen(o => !o)}>
        <span>{title}</span>
        <span className={`chev ${open ? 'open' : ''}`}>›</span>
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  )
}

function Slider({
  label, value, min, max, step, onChange, format,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  return (
    <label className="control">
      <div className="control-row">
        <span>{label}</span>
        <span className="value">{format ? format(value) : value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
      />
    </label>
  )
}

function Toggle({
  label, checked, onChange, hint,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  hint?: string
}) {
  return (
    <label className="control toggle" title={hint}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

function ColorPick({
  label, value, onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="control color">
      <span>{label}</span>
      <input type="color" value={value} onChange={e => onChange(e.target.value)} />
    </label>
  )
}

function formatHour(h: number): string {
  const hour = Math.floor(h)
  const min = Math.round((h - hour) * 60)
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

export default function ControlPanel({
  lighting, post, scene, pointLights, selectedLightId, placingLight, weatherStates,
  music, musicStatus, onMusic,
  onLighting, onPost, onScene, onPointLights, onUpdateLight, onRemoveLight,
  onSelectLight, onTogglePlacing, onPreset, onReset,
}: ControlPanelProps) {
  const lit = lighting.mode === 'lit'
  const selected = pointLights.lights.find(l => l.id === selectedLightId) ?? null

  // Anchor the height slider's range to where the light was when it was
  // selected. Deriving the range from its live position made the range move
  // with the thumb, so a small drag ran away.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const heightAnchor = useMemo(() => selected?.position[1] ?? 0, [selected?.id])

  return (
    <div className="panel">
      <div className="panel-top">
        <div className="mode-switch">
          <button
            className={scene.cameraMode === 'orbit' ? 'active' : ''}
            onClick={() => onScene({ cameraMode: 'orbit' })}
          >
            Orbit
          </button>
          <button
            className={scene.cameraMode === 'fly' ? 'active' : ''}
            onClick={() => onScene({ cameraMode: 'fly' })}
          >
            Fly
          </button>
          <button
            className={scene.cameraMode === 'walk' ? 'active' : ''}
            onClick={() => onScene({ cameraMode: 'walk' })}
          >
            Walk
          </button>
        </div>
        {scene.cameraMode === 'fly' && (
          <p className="note small">
            Click the view to capture the mouse. WASD to move, E/Space up, Q/Shift down,
            scroll to change speed, Esc to release.
          </p>
        )}
        {scene.cameraMode === 'walk' && (
          <>
            <p className="note small">
              Click the view to capture the mouse. WASD to walk, Shift to run,
              Esc to release. You stand on FFXI's own collision mesh, so walls
              block you and the ground is where the game puts it.
            </p>
            <Slider
              label="Eye height" value={scene.walkEyeHeight} min={0.5} max={4} step={0.1}
              onChange={v => onScene({ walkEyeHeight: v })}
            />
            <Slider
              label="Walk speed" value={scene.walkSpeed} min={0.5} max={20} step={0.5}
              onChange={v => onScene({ walkSpeed: v })}
            />
            <Slider
              label="Run multiplier" value={scene.walkRunMultiplier} min={1} max={6} step={0.1}
              onChange={v => onScene({ walkRunMultiplier: v })}
            />
            <Slider
              label="Step height" value={scene.walkStepHeight} min={0} max={2} step={0.05}
              onChange={v => onScene({ walkStepHeight: v })}
            />
            <Slider
              label="Slope limit" value={scene.walkSlopeLimit} min={10} max={85} step={1}
              onChange={v => onScene({ walkSlopeLimit: v })}
            />
            <Toggle
              label="Noclip"
              checked={scene.walkNoclip}
              onChange={v => onScene({ walkNoclip: v })}
              hint="Detach from the ground and move freely. Space rises."
            />
            <Toggle
              label="Third person"
              checked={scene.walkThirdPerson}
              onChange={v => onScene({ walkThirdPerson: v })}
              hint="Watch your character from behind. Build it in Models → Character."
            />
            {scene.walkThirdPerson && (
              <>
                <Slider
                  label="Camera distance" value={scene.walkCameraDistance}
                  min={1} max={20} step={0.5}
                  onChange={v => onScene({ walkCameraDistance: v })}
                />
                <Slider
                  label="Camera height" value={scene.walkCameraHeight}
                  min={-2} max={5} step={0.1}
                  onChange={v => onScene({ walkCameraHeight: v })}
                />
                <p className="note small">
                  The character is whatever you built in Models → Character. It
                  only animates while moving — there is no idle clip identified
                  yet, and a walk cycle playing on the spot looks worse than a
                  held pose.
                </p>
              </>
            )}
          </>
        )}
      </div>

      <Section title="Presets">
        <div className="presets">
          {PRESETS.map((p, i) => (
            <button key={p.name} className="preset" title={p.description} onClick={() => onPreset(i)}>
              {p.name}
            </button>
          ))}
        </div>
        <button className="reset" onClick={onReset}>Reset to defaults</button>
      </Section>

      <Section title="Lighting">
        <div className="mode-switch">
          <button
            className={!lit ? 'active' : ''}
            onClick={() => onLighting({ mode: 'baked' })}
            title="FFXI's original baked vertex lighting — no light sources"
          >
            Original
          </button>
          <button
            className={lit ? 'active' : ''}
            onClick={() => onLighting({ mode: 'lit' })}
            title="Dynamic lights and shadows using the DAT normals"
          >
            Dynamic
          </button>
        </div>

        {!lit && (
          <>
            <Toggle
              label="Sun shading (as in game)"
              checked={lighting.gameSun}
              onChange={v => onLighting({ gameSun: v })}
              hint="The game's own fixed-function lighting: a directional sun shades terrain by facing, on top of the baked vertex colours."
            />
            {lighting.gameSun && (
              <>
                <Slider
                  label="Sun strength" value={lighting.gameSunIntensity} min={0} max={2} step={0.02}
                  onChange={v => onLighting({ gameSunIntensity: v })}
                />
                <Slider
                  label="Ambient" value={lighting.gameAmbient} min={0} max={2} step={0.02}
                  onChange={v => onLighting({ gameAmbient: v })}
                />
                <p className="note small">
                  Reproduces how the game lights terrain: surfaces facing the sun
                  brighten, faces turned away darken. The sun follows the time of
                  day. Cast shadows need <strong>Dynamic</strong> mode.
                </p>
              </>
            )}
            {!lighting.gameSun && (
              <p className="note small">
                Baked vertex colours only — flatter than the game, which also
                applied a per-vertex directional sun.
              </p>
            )}
          </>
        )}

        {lit && (
          <>
            <Slider
              label="Keep baked shading"
              value={lighting.bakedInfluence} min={0} max={1} step={0.01}
              onChange={v => onLighting({ bakedInfluence: v })}
            />
            <p className="note small">
              How much of the original painted-on shading to keep. Lower values give
              cleaner dynamic shadows; higher keeps more of the original art.
            </p>

            <Slider
              label="Sun intensity" value={lighting.sunIntensity} min={0} max={8} step={0.05}
              onChange={v => onLighting({ sunIntensity: v })}
            />
            <ColorPick label="Sun colour" value={lighting.sunColor} onChange={v => onLighting({ sunColor: v })} />

            <Toggle
              label="Sun follows time of day"
              checked={lighting.sunFollowsTimeOfDay}
              onChange={v => onLighting({ sunFollowsTimeOfDay: v })}
            />
            {!lighting.sunFollowsTimeOfDay && (
              <>
                <Slider
                  label="Sun elevation" value={lighting.sunElevation} min={1} max={89} step={1}
                  onChange={v => onLighting({ sunElevation: v })}
                  format={v => `${v.toFixed(0)}°`}
                />
                <Slider
                  label="Sun direction" value={lighting.sunAzimuth} min={0} max={360} step={1}
                  onChange={v => onLighting({ sunAzimuth: v })}
                  format={v => `${v.toFixed(0)}°`}
                />
              </>
            )}

            <Slider
              label="Ambient intensity" value={lighting.ambientIntensity} min={0} max={3} step={0.02}
              onChange={v => onLighting({ ambientIntensity: v })}
            />
            <ColorPick label="Sky bounce" value={lighting.skyColor} onChange={v => onLighting({ skyColor: v })} />
            <ColorPick label="Ground bounce" value={lighting.groundColor} onChange={v => onLighting({ groundColor: v })} />

            <Toggle
              label="Sky lighting (IBL)" checked={lighting.skyIBL}
              onChange={v => onLighting({ skyIBL: v })}
              hint="Lights surfaces with the sky itself instead of a flat ambient term."
            />
            {lighting.skyIBL && (
              <>
                <Slider
                  label="Sky light strength" value={lighting.iblIntensity} min={0} max={3} step={0.05}
                  onChange={v => onLighting({ iblIntensity: v })}
                />
                <p className="note small">
                  Captures the procedural sky into an environment map, so surfaces
                  pick up colour from the direction they face. Pairs well with a
                  lower ambient intensity.
                </p>
              </>
            )}

            <Slider
              label="Roughness" value={lighting.roughness} min={0} max={1} step={0.01}
              onChange={v => onLighting({ roughness: v })}
            />
            <Slider
              label="Metalness" value={lighting.metalness} min={0} max={1} step={0.01}
              onChange={v => onLighting({ metalness: v })}
            />
          </>
        )}
      </Section>

      {lit && (
        <Section title="Point lights">
          <p className="note small">
            FFXI's zone files contain no light data, so torches and braziers are
            placed by hand. Turn on placement below and click a surface in the view.
          </p>

          <button
            className={`place-btn ${placingLight ? 'active' : ''}`}
            onClick={onTogglePlacing}
          >
            {placingLight ? 'Click a surface to place… (click here to stop)' : 'Place a light'}
          </button>

          {pointLights.lights.length > 0 && (
            <ul className="light-list">
              {pointLights.lights.map((l, i) => (
                <li key={l.id}>
                  <button
                    className={selectedLightId === l.id ? 'active' : ''}
                    onClick={() => onSelectLight(selectedLightId === l.id ? null : l.id)}
                  >
                    <span className="swatch" style={{ background: l.color }} />
                    <span>Light {i + 1}</span>
                  </button>
                  <button className="remove" onClick={() => onRemoveLight(l.id)} title="Remove">×</button>
                </li>
              ))}
            </ul>
          )}

          {selected && (
            <div className="light-editor">
              <Slider
                label="Intensity" value={selected.intensity} min={0} max={200} step={1}
                onChange={v => onUpdateLight(selected.id, { intensity: v })}
                format={v => v.toFixed(0)}
              />
              <ColorPick
                label="Colour" value={selected.color}
                onChange={v => onUpdateLight(selected.id, { color: v })}
              />
              <Slider
                label="Range" value={selected.distance} min={5} max={600} step={5}
                onChange={v => onUpdateLight(selected.id, { distance: v })}
                format={v => v.toFixed(0)}
              />
              <Slider
                label="Falloff" value={selected.decay} min={0} max={3} step={0.05}
                onChange={v => onUpdateLight(selected.id, { decay: v })}
              />
              <Slider
                label="Flicker" value={selected.flicker} min={0} max={1} step={0.01}
                onChange={v => onUpdateLight(selected.id, { flicker: v })}
              />
              <Toggle
                label="Casts shadows" checked={selected.castShadow}
                onChange={v => onUpdateLight(selected.id, { castShadow: v })}
                hint="Point-light shadows render six faces per light and are expensive."
              />
              <Slider
                label="Raise / lower"
                value={selected.position[1]}
                min={heightAnchor - 25} max={heightAnchor + 25} step={0.1}
                onChange={v => onUpdateLight(selected.id, {
                  position: [selected.position[0], v, selected.position[2]],
                })}
                format={v => `${(v - heightAnchor >= 0 ? '+' : '')}${(v - heightAnchor).toFixed(1)}`}
              />
            </div>
          )}

          <Toggle
            label="Show light markers" checked={pointLights.showGizmos}
            onChange={v => onPointLights({ showGizmos: v })}
          />

          <Toggle
            label="Headlamp (follows camera)" checked={pointLights.headlamp}
            onChange={v => onPointLights({ headlamp: v })}
            hint="A light attached to the camera, for exploring dark interiors."
          />
          {pointLights.headlamp && (
            <>
              <Slider
                label="Headlamp intensity" value={pointLights.headlampIntensity}
                min={0} max={200} step={1}
                onChange={v => onPointLights({ headlampIntensity: v })}
                format={v => v.toFixed(0)}
              />
              <Slider
                label="Headlamp range" value={pointLights.headlampDistance}
                min={10} max={800} step={10}
                onChange={v => onPointLights({ headlampDistance: v })}
                format={v => v.toFixed(0)}
              />
              <ColorPick
                label="Headlamp colour" value={pointLights.headlampColor}
                onChange={v => onPointLights({ headlampColor: v })}
              />
            </>
          )}

          {pointLights.lights.length > 0 && (
            <button className="reset" onClick={() => onPointLights({ lights: [] })}>
              Remove all lights
            </button>
          )}
        </Section>
      )}

      {lit && (
        <Section title="Shadows">
          <Toggle label="Cast shadows" checked={lighting.shadows} onChange={v => onLighting({ shadows: v })} />
          {lighting.shadows && (
            <>
              <label className="control">
                <div className="control-row"><span>Resolution</span></div>
                <select
                  value={lighting.shadowMapSize}
                  onChange={e => onLighting({ shadowMapSize: Number(e.target.value) })}
                >
                  <option value={512}>512 — fastest</option>
                  <option value={1024}>1024</option>
                  <option value={2048}>2048 — balanced</option>
                  <option value={4096}>4096 — sharpest</option>
                </select>
              </label>
              <Slider
                label="Shadow range" value={lighting.shadowRadius} min={50} max={1200} step={10}
                onChange={v => onLighting({ shadowRadius: v })}
                format={v => `${v.toFixed(0)}`}
              />
              <p className="note small">
                The area around the camera that receives shadows. Smaller covers less
                ground but resolves finer detail.
              </p>
              <Slider
                label="Softness" value={lighting.shadowSoftness} min={0} max={16} step={0.5}
                onChange={v => onLighting({ shadowSoftness: v })}
              />
              <Slider
                label="Bias" value={lighting.shadowBias} min={-0.005} max={0} step={0.0001}
                onChange={v => onLighting({ shadowBias: v })}
                format={v => v.toFixed(4)}
              />
              <Slider
                label="Normal bias" value={lighting.shadowNormalBias} min={0} max={4} step={0.05}
                onChange={v => onLighting({ shadowNormalBias: v })}
              />
              <p className="note small">
                Raise the bias values if you see stripe patterns or shadows detaching
                from what casts them.
              </p>
            </>
          )}
        </Section>
      )}

      <Section title="Post-processing">
        <Toggle label="Enable post-processing" checked={post.enabled} onChange={v => onPost({ enabled: v })} />
        {post.enabled && (
          <>
            <label className="control">
              <div className="control-row"><span>Tone mapping</span></div>
              <select
                value={post.toneMapping}
                onChange={e => onPost({ toneMapping: e.target.value as PostSettings['toneMapping'] })}
              >
                <option value="aces">ACES Filmic</option>
                <option value="agx">AgX</option>
                <option value="neutral">Khronos Neutral</option>
                <option value="reinhard">Reinhard</option>
                <option value="cineon">Cineon</option>
                <option value="linear">Linear</option>
                <option value="none">None</option>
              </select>
            </label>
            <Slider
              label="Exposure" value={post.exposure} min={0.1} max={3} step={0.01}
              onChange={v => onPost({ exposure: v })}
            />

            <Toggle label="Anti-aliasing (SMAA)" checked={post.smaa} onChange={v => onPost({ smaa: v })} />

            <Toggle
              label="Ambient occlusion" checked={post.ao} onChange={v => onPost({ ao: v })}
              hint="Contact shadows in creases and corners. Disabled automatically on very large zones."
            />
            {post.ao && (
              <>
                <Slider label="AO strength" value={post.aoIntensity} min={0} max={4} step={0.05}
                  onChange={v => onPost({ aoIntensity: v })} />
                <Slider label="AO radius" value={post.aoRadius} min={0.2} max={8} step={0.1}
                  onChange={v => onPost({ aoRadius: v })} />
              </>
            )}

            <Toggle label="Bloom" checked={post.bloom} onChange={v => onPost({ bloom: v })} />
            {post.bloom && (
              <>
                <Slider label="Bloom strength" value={post.bloomIntensity} min={0} max={2} step={0.01}
                  onChange={v => onPost({ bloomIntensity: v })} />
                <Slider label="Bloom threshold" value={post.bloomThreshold} min={0} max={1} step={0.01}
                  onChange={v => onPost({ bloomThreshold: v })} />
              </>
            )}

            <Toggle label="Depth of field" checked={post.depthOfField} onChange={v => onPost({ depthOfField: v })} />
            {post.depthOfField && (
              <>
                <Toggle
                  label="Focus on view centre" checked={post.dofAutofocus}
                  onChange={v => onPost({ dofAutofocus: v })}
                  hint="Focuses on whatever is at the middle of the view, like a camera."
                />
                {!post.dofAutofocus && (
                  <Slider label="Focus distance" value={post.dofFocusDistance} min={20} max={20000} step={20}
                    onChange={v => onPost({ dofFocusDistance: v })} format={v => `${v.toFixed(0)} u`} />
                )}
                <Slider label="Focus range" value={post.dofFocalLength} min={50} max={12000} step={50}
                  onChange={v => onPost({ dofFocalLength: v })} format={v => `${v.toFixed(0)} u`} />
                <Slider label="Blur amount" value={post.dofBokehScale} min={0} max={12} step={0.1}
                  onChange={v => onPost({ dofBokehScale: v })} />
                <p className="note small">
                  Distances are in world units, and zones are large — several
                  thousand units across is normal. A wider focus range keeps more
                  of the scene sharp either side of the focal plane. Depth of
                  field switches the renderer to standard depth precision, which
                  can introduce z-fighting on very large zones.
                </p>
              </>
            )}

            <Toggle label="Colour grading" checked={post.colorGrade} onChange={v => onPost({ colorGrade: v })} />
            {post.colorGrade && (
              <>
                <Slider label="Saturation" value={post.saturation} min={-1} max={1} step={0.01}
                  onChange={v => onPost({ saturation: v })} />
                <Slider label="Contrast" value={post.contrast} min={-0.5} max={0.5} step={0.01}
                  onChange={v => onPost({ contrast: v })} />
                <Slider label="Brightness" value={post.brightness} min={-0.5} max={0.5} step={0.01}
                  onChange={v => onPost({ brightness: v })} />
              </>
            )}

            <Toggle label="Vignette" checked={post.vignette} onChange={v => onPost({ vignette: v })} />
            {post.vignette && (
              <Slider label="Vignette darkness" value={post.vignetteDarkness} min={0} max={1.5} step={0.01}
                onChange={v => onPost({ vignetteDarkness: v })} />
            )}
          </>
        )}
      </Section>

      <Section title="Music">
        <Toggle
          label="Zone music"
          checked={music.enabled}
          onChange={v => onMusic({ enabled: v })}
          hint="Plays the track FFXI assigns to this zone, read straight from the install."
        />
        {music.enabled && (
          <>
            <Slider
              label="Volume" value={music.volume} min={0} max={1} step={0.01}
              onChange={v => onMusic({ volume: v })}
            />
            <p className="note small">{describeMusic(musicStatus)}</p>
          </>
        )}
      </Section>

      <Section title="Weather">
        {weatherStates.length === 0 ? (
          <p className="note small">This zone carries no weather geometry.</p>
        ) : (
          <>
            <div className="control-row"><span>State</span></div>
            <select
              value={scene.weatherState}
              onChange={e => onScene({ weatherState: e.target.value })}
            >
              <option value="">None</option>
              {weatherStates.map(s => (
                <option key={s} value={s}>{WEATHER_LABELS[s] ?? s}</option>
              ))}
            </select>
            <p className="note small">
              FFXI stores one set of geometry per weather state and never places
              any of it — the client picks a state at runtime, so nothing here is
              drawn until you choose one. Only one at a time: drawing them all
              together is what made the old weather toggle look like nonsense.
            </p>
            <Toggle
              label="Follow camera"
              checked={scene.weatherFollowsCamera}
              onChange={v => onScene({ weatherFollowsCamera: v })}
              hint="The domes are about 241 units across against zones of 1400, so left at the zone origin they read as a patch on the ground. Centring them on the viewer is our choice, not FFXI's data."
            />
          </>
        )}
      </Section>

      <Section title="Scene">
        <Slider
          label="Time of day" value={scene.timeOfDay} min={0} max={23.99} step={0.05}
          onChange={v => onScene({ timeOfDay: v })} format={formatHour}
        />
        <Slider
          label="Fog density" value={scene.fogDensity} min={0} max={8} step={0.02}
          onChange={v => onScene({ fogDensity: v })}
        />
        <Slider
          label="Water tint" value={scene.waterTint} min={0} max={1} step={0.01}
          onChange={v => onScene({ waterTint: v })}
        />
        <p className="note small">
          How much of the baked vertex shading tints water. FFXI stores very dark
          values here, so a low setting keeps rivers from going black.
        </p>
        <Toggle label="Show sky" checked={scene.showSky} onChange={v => onScene({ showSky: v })} />
        {!scene.showSky && (
          <>
            <ColorPick
              label="Background"
              value={scene.backgroundColor}
              onChange={v => onScene({ backgroundColor: v })}
            />
            <Toggle
              label="Background follows time"
              checked={scene.backgroundFollowsTime}
              onChange={v => onScene({ backgroundFollowsTime: v })}
              hint="Darken the backdrop with the time-of-day slider instead of holding the picked colour."
            />
          </>
        )}
        <Toggle label="Wireframe" checked={scene.wireframe} onChange={v => onScene({ wireframe: v })} />
        <Toggle
          label="Show collision"
          checked={scene.showCollision}
          onChange={v => onScene({ showCollision: v })}
        />
        <p className="note small">
          Draws the collision mesh FFXI actually uses for movement. It is not the
          same as the visible geometry — it carries invisible walls and leaves out
          decoration — so it will not match the art everywhere.
        </p>
      </Section>
    </div>
  )
}
