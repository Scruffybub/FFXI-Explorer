import { useState, useMemo } from 'react'
import { Label } from './Info'
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
      return `Track ${s.track} uses codec ${s.codec}, which this build cannot decode. ` +
        'Codec 0 (PS-ADPCM) and codec 3 (ATRAC3) both play.'
    case 'missing':
      return `Track ${s.track} is not in this installation.`
    case 'error':
      return `Track ${s.track} failed: ${s.message}`
  }
}

function Section({
  title, children, defaultOpen = true, info,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
  info?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="section">
      <button className="section-head" onClick={() => setOpen(o => !o)}>
        <Label text={title} info={info} />
        <span className={`chev ${open ? 'open' : ''}`}>›</span>
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  )
}

function Slider({
  label, value, min, max, step, onChange, format, info,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
  info?: string
}) {
  return (
    <label className="control">
      <div className="control-row">
        <Label text={label} info={info} />
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
  label, checked, onChange, info,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  info?: string
}) {
  return (
    <label className="control toggle">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <Label text={label} info={info} />
    </label>
  )
}

function ColorPick({
  label, value, onChange, info,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  info?: string
}) {
  return (
    <label className="control color">
      <Label text={label} info={info} />
      <input type="color" value={value} onChange={e => onChange(e.target.value)} />
    </label>
  )
}

/** A labelled dropdown, so selects carry an info icon like everything else. */
function SelectField({
  label, value, onChange, info, children,
}: {
  label: string
  value: string | number
  onChange: (v: string) => void
  info?: string
  children: React.ReactNode
}) {
  return (
    <label className="control">
      <div className="control-row"><Label text={label} info={info} /></div>
      <select value={value} onChange={e => onChange(e.target.value)}>{children}</select>
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
              info="How far the camera sits above the ground you are standing on, in world units. FFXI's scale is roughly one unit per metre, so around 1.7 is eye level for a Hume."
            />
            <Slider
              label="Walk speed" value={scene.walkSpeed} min={0.5} max={20} step={0.5}
              onChange={v => onScene({ walkSpeed: v })}
              info="Ground speed in world units per second. Movement is time-based rather than per-frame, so this is the same speed on any monitor."
            />
            <Slider
              label="Run multiplier" value={scene.walkRunMultiplier} min={1} max={6} step={0.1}
              onChange={v => onScene({ walkRunMultiplier: v })}
              info="How much faster you move while Shift is held. Zones are large, so a high multiplier is often the difference between exploring and trudging."
            />
            <Slider
              label="Step height" value={scene.walkStepHeight} min={0} max={2} step={0.05}
              onChange={v => onScene({ walkStepHeight: v })}
              info="Ledges up to this height are climbed without a jump. FFXI's collision is full of small lips at path edges and doorways; too low a value catches on them."
            />
            <Slider
              label="Slope limit" value={scene.walkSlopeLimit} min={10} max={85} step={1}
              onChange={v => onScene({ walkSlopeLimit: v })}
              info="The steepest ground you can stand on, in degrees from horizontal. Anything steeper is treated as a wall to slide along rather than a floor."
            />
            <Toggle
              label="Noclip"
              checked={scene.walkNoclip}
              onChange={v => onScene({ walkNoclip: v })}
              info="Detach from the ground and move freely, ignoring collision entirely. Space rises. Useful for reaching somewhere the collision mesh will not let you walk."
            />
            <Toggle
              label="Third person"
              checked={scene.walkThirdPerson}
              onChange={v => onScene({ walkThirdPerson: v })}
              info="Watch your character from behind instead of through its eyes. The character is whatever you built in Models → Character."
            />
            {scene.walkThirdPerson && (
              <>
                <Slider
                  label="Camera distance" value={scene.walkCameraDistance}
                  min={1} max={20} step={0.5}
                  onChange={v => onScene({ walkCameraDistance: v })}
                  info="How far behind the character the camera orbits. The character keeps walking where it was walking when you swing the view around it."
                />
                <Slider
                  label="Camera height" value={scene.walkCameraHeight}
                  min={-2} max={5} step={0.1}
                  onChange={v => onScene({ walkCameraHeight: v })}
                  info="How far above the head the camera sits. Negative values drop it below, for a low hero angle."
                />
                <p className="note small">
                  The character only animates while moving — there is no idle clip
                  identified yet, and a walk cycle playing on the spot looks worse
                  than a held pose.
                </p>
              </>
            )}
          </>
        )}
      </div>

      <Section
        title="Presets"
        info="Complete looks, applied over the defaults rather than over your current settings — so picking one never leaves a stray value behind from the last. Camera mode and wireframe are preserved."
      >
        <div className="presets">
          {PRESETS.map((p, i) => (
            <button key={p.name} className="preset" title={p.description} onClick={() => onPreset(i)}>
              {p.name}
            </button>
          ))}
        </div>
        <button className="reset" onClick={onReset}>Reset to defaults</button>
      </Section>

      <Section
        title="Lighting"
        info="Original reproduces FFXI's own 2002 look: shading painted into the vertices with no light sources at all. Dynamic lights the same geometry using the per-vertex normals the DAT files carry, which the game itself never used this way."
      >
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
              info="The game's own fixed-function rig: one directional sun plus ambient, shading terrain by which way it faces, with the baked vertex colours multiplied on top. Off gives baked colours alone, which is flatter than the game ever looked. Cast shadows need Dynamic mode."
            />
            {lighting.gameSun && (
              <>
                <Slider
                  label="Sun strength" value={lighting.gameSunIntensity} min={0} max={2} step={0.02}
                  onChange={v => onLighting({ gameSunIntensity: v })}
                  info="How hard the directional sun shades surfaces by facing. The default of 0.68 was tuned against in-game screenshots; the sun follows the time of day."
                />
                <Slider
                  label="Ambient" value={lighting.gameAmbient} min={0} max={2} step={0.02}
                  onChange={v => onLighting({ gameAmbient: v })}
                  info="The flat fill light that keeps surfaces facing away from the sun from going black. Raising it flattens the terrain shading, lowering it deepens it."
                />
              </>
            )}
          </>
        )}

        {lit && (
          <>
            <Slider
              label="Keep baked shading"
              value={lighting.bakedInfluence} min={0} max={1} step={0.01}
              onChange={v => onLighting({ bakedInfluence: v })}
              info="How much of FFXI's original painted-on shading survives under the dynamic lights. Lower gives cleaner new shadows; higher keeps more of the original art, at the cost of shadows reading twice."
            />

            <Slider
              label="Sun intensity" value={lighting.sunIntensity} min={0} max={8} step={0.05}
              onChange={v => onLighting({ sunIntensity: v })}
              info="Brightness of the single directional light that stands in for the sun. This is the light that casts the scene's shadows."
            />
            <ColorPick
              label="Sun colour" value={lighting.sunColor}
              onChange={v => onLighting({ sunColor: v })}
              info="Colour of that sunlight. Warm values read as late afternoon, cool ones as overcast or moonlight."
            />

            <Toggle
              label="Sun follows time of day"
              checked={lighting.sunFollowsTimeOfDay}
              onChange={v => onLighting({ sunFollowsTimeOfDay: v })}
              info="Drive the sun's position from the Time of day slider in Scene. Turn it off to aim the sun by hand with the two angle sliders."
            />
            {!lighting.sunFollowsTimeOfDay && (
              <>
                <Slider
                  label="Sun elevation" value={lighting.sunElevation} min={1} max={89} step={1}
                  onChange={v => onLighting({ sunElevation: v })}
                  format={v => `${v.toFixed(0)}°`}
                  info="How high the sun sits above the horizon. Low angles give long raking shadows; overhead gives short ones and flat ground."
                />
                <Slider
                  label="Sun direction" value={lighting.sunAzimuth} min={0} max={360} step={1}
                  onChange={v => onLighting({ sunAzimuth: v })}
                  format={v => `${v.toFixed(0)}°`}
                  info="Which compass direction the sun shines from, so you can throw shadows across the shot the way you want them."
                />
              </>
            )}

            <Slider
              label="Ambient intensity" value={lighting.ambientIntensity} min={0} max={3} step={0.02}
              onChange={v => onLighting({ ambientIntensity: v })}
              info="Strength of the two-tone fill light that stops shadowed faces going black. Lower it when Sky lighting is on, or the two stack."
            />
            <ColorPick
              label="Sky bounce" value={lighting.skyColor}
              onChange={v => onLighting({ skyColor: v })}
              info="The fill colour arriving from above — what the sky contributes to surfaces facing up."
            />
            <ColorPick
              label="Ground bounce" value={lighting.groundColor}
              onChange={v => onLighting({ groundColor: v })}
              info="The fill colour arriving from below, as though bounced off the ground. Earthy values sit well under FFXI's terrain."
            />

            <Toggle
              label="Sky lighting (IBL)" checked={lighting.skyIBL}
              onChange={v => onLighting({ skyIBL: v })}
              info="Light surfaces with the procedural sky itself rather than a flat ambient term, so they pick up colour from the direction they face. Pairs well with a lower ambient intensity."
            />
            {lighting.skyIBL && (
              <Slider
                label="Sky light strength" value={lighting.iblIntensity} min={0} max={3} step={0.05}
                onChange={v => onLighting({ iblIntensity: v })}
                info="How strongly that captured sky lights the scene. The capture follows the time of day, so dusk tints everything without touching a colour picker."
              />
            )}

            <Slider
              label="Roughness" value={lighting.roughness} min={0} max={1} step={0.01}
              onChange={v => onLighting({ roughness: v })}
              info="Surface finish for every zone material: 1 is chalky and matte, 0 is polished. FFXI's textures carry no material data, so this is one value for the whole world."
            />
            <Slider
              label="Metalness" value={lighting.metalness} min={0} max={1} step={0.01}
              onChange={v => onLighting({ metalness: v })}
              info="How metallic those surfaces behave. Terrain wants this near zero; raising it darkens the diffuse and makes highlights take the light's colour."
            />
          </>
        )}
      </Section>

      {lit && (
        <Section
          title="Point lights"
          info="FFXI's zone files contain no light data at all, so torches and braziers are placed by hand. Turn on placement and click a surface in the view to drop one. Lights are lost when you leave the zone."
        >
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
                info="Brightness of this light. Values run high because falloff is physical: a torch that reads well a few units away needs far more than 1."
              />
              <ColorPick
                label="Colour" value={selected.color}
                onChange={v => onUpdateLight(selected.id, { color: v })}
                info="Colour of this light. Warm orange reads as firelight; the default is a torch."
              />
              <Slider
                label="Range" value={selected.distance} min={5} max={600} step={5}
                onChange={v => onUpdateLight(selected.id, { distance: v })}
                format={v => v.toFixed(0)}
                info="How far the light reaches, in world units, before it stops contributing entirely. Shorter ranges are cheaper and keep the light local."
              />
              <Slider
                label="Falloff" value={selected.decay} min={0} max={3} step={0.05}
                onChange={v => onUpdateLight(selected.id, { decay: v })}
                info="How quickly brightness drops with distance. 2 is physically correct inverse-square; lower values carry further and look more like game lighting."
              />
              <Slider
                label="Flicker" value={selected.flicker} min={0} max={1} step={0.01}
                onChange={v => onUpdateLight(selected.id, { flicker: v })}
                info="Gentle animated wobble in brightness, for torches and braziers. 0 is a steady lamp."
              />
              <Toggle
                label="Casts shadows" checked={selected.castShadow}
                onChange={v => onUpdateLight(selected.id, { castShadow: v })}
                info="Let this light throw shadows. A point light renders six shadow faces, one per cube direction, so this is expensive — turn it on for the one light that matters."
              />
              <Slider
                label="Raise / lower"
                value={selected.position[1]}
                min={heightAnchor - 25} max={heightAnchor + 25} step={0.1}
                onChange={v => onUpdateLight(selected.id, {
                  position: [selected.position[0], v, selected.position[2]],
                })}
                format={v => `${(v - heightAnchor >= 0 ? '+' : '')}${(v - heightAnchor).toFixed(1)}`}
                info="Move the light up or down from where you clicked. The range is anchored to its position at selection, so the slider does not run away as you drag."
              />
            </div>
          )}

          <Toggle
            label="Show light markers" checked={pointLights.showGizmos}
            onChange={v => onPointLights({ showGizmos: v })}
            info="Draw a small marker at each light so it can be found and clicked. Turn off for a clean screenshot."
          />

          <Toggle
            label="Headlamp (follows camera)" checked={pointLights.headlamp}
            onChange={v => onPointLights({ headlamp: v })}
            info="A light attached to the camera, for exploring dark interiors without placing anything."
          />
          {pointLights.headlamp && (
            <>
              <Slider
                label="Headlamp intensity" value={pointLights.headlampIntensity}
                min={0} max={200} step={1}
                onChange={v => onPointLights({ headlampIntensity: v })}
                format={v => v.toFixed(0)}
                info="Brightness of the camera light."
              />
              <Slider
                label="Headlamp range" value={pointLights.headlampDistance}
                min={10} max={800} step={10}
                onChange={v => onPointLights({ headlampDistance: v })}
                format={v => v.toFixed(0)}
                info="How far ahead the camera light reaches. Large interiors want a long range; a short one keeps the pool of light close."
              />
              <ColorPick
                label="Headlamp colour" value={pointLights.headlampColor}
                onChange={v => onPointLights({ headlampColor: v })}
                info="Colour of the camera light. A neutral warm white shows the art most honestly."
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
        <Section
          title="Shadows"
          info="Shadows cast by the sun light. FFXI had none of this — its shading is painted into the vertices — so everything here is an addition to the original art."
        >
          <Toggle
            label="Cast shadows" checked={lighting.shadows}
            onChange={v => onLighting({ shadows: v })}
            info="Turn sun shadows on. They cost a second render of the scene from the sun's point of view each frame."
          />
          {lighting.shadows && (
            <>
              <SelectField
                label="Resolution"
                value={lighting.shadowMapSize}
                onChange={v => onLighting({ shadowMapSize: Number(v) })}
                info="Pixels across the shadow map. Higher resolves finer detail over the same ground, and costs more; 4096 is the way to sharpen shadows without shrinking the range."
              >
                <option value={512}>512 — fastest</option>
                <option value={1024}>1024</option>
                <option value={2048}>2048 — balanced</option>
                <option value={4096}>4096 — sharpest</option>
              </SelectField>
              <Slider
                label="Shadow range" value={lighting.shadowRadius} min={50} max={1200} step={10}
                onChange={v => onLighting({ shadowRadius: v })}
                format={v => `${v.toFixed(0)}`}
                info="The area around the camera that receives shadows, in world units. Smaller covers less ground but spends the same map on it, so shadows read sharper."
              />
              <Slider
                label="Softness" value={lighting.shadowSoftness} min={0} max={16} step={0.5}
                onChange={v => onLighting({ shadowSoftness: v })}
                info="Blurs the shadow edge. This is a uniform softness rather than real contact hardening — the edge does not tighten where objects meet the ground."
              />
              <Slider
                label="Bias" value={lighting.shadowBias} min={-0.005} max={0} step={0.0001}
                onChange={v => onLighting({ shadowBias: v })}
                format={v => v.toFixed(4)}
                info="Nudges the depth comparison to stop a surface shadowing itself. Raise it if you see stripe patterns; too much and shadows detach from what casts them."
              />
              <Slider
                label="Normal bias" value={lighting.shadowNormalBias} min={0} max={4} step={0.05}
                onChange={v => onLighting({ shadowNormalBias: v })}
                info="The same correction, applied along the surface normal instead. Usually the better one to reach for first on FFXI's large sloping terrain."
              />
            </>
          )}
        </Section>
      )}

      <Section
        title="Post-processing"
        info="Effects applied to the finished frame, after the scene is rendered. All of it is modern addition — none of these existed in FFXI's DX8 renderer."
      >
        <Toggle
          label="Enable post-processing" checked={post.enabled}
          onChange={v => onPost({ enabled: v })}
          info="Master switch for everything in this section. Off renders the raw frame, which is the fastest the viewer gets."
        />
        {post.enabled && (
          <>
            <SelectField
              label="Tone mapping"
              value={post.toneMapping}
              onChange={v => onPost({ toneMapping: v as PostSettings['toneMapping'] })}
              info="How high dynamic range is squeezed into a displayable image. ACES is filmic and contrasty, AgX gentler on bright colour, Neutral closest to the raw values. None can blow out."
            >
              <option value="aces">ACES Filmic</option>
              <option value="agx">AgX</option>
              <option value="neutral">Khronos Neutral</option>
              <option value="reinhard">Reinhard</option>
              <option value="cineon">Cineon</option>
              <option value="linear">Linear</option>
              <option value="none">None</option>
            </SelectField>
            <Slider
              label="Exposure" value={post.exposure} min={0.1} max={3} step={0.01}
              onChange={v => onPost({ exposure: v })}
              info="Overall brightness going into tone mapping, like a camera's exposure. Raising it lifts shadows and rolls highlights off rather than clipping them."
            />

            <Toggle
              label="Anti-aliasing (SMAA)" checked={post.smaa}
              onChange={v => onPost({ smaa: v })}
              info="Smooths jagged edges as a post pass. FFXI's terrain is full of long diagonal silhouettes, which is exactly what stair-steps without it."
            />

            <Toggle
              label="Ambient occlusion" checked={post.ao} onChange={v => onPost({ ao: v })}
              info="Darkens creases, corners and contact points where light would struggle to reach. Its cost is screen-space, so it barely depends on how complex the zone is."
            />
            {post.ao && (
              <>
                <Slider
                  label="AO strength" value={post.aoIntensity} min={0} max={4} step={0.05}
                  onChange={v => onPost({ aoIntensity: v })}
                  info="How dark those contact shadows go. Past about 2 it reads as dirt rather than shadow."
                />
                <Slider
                  label="AO radius" value={post.aoRadius} min={0.2} max={8} step={0.1}
                  onChange={v => onPost({ aoRadius: v })}
                  info="How far the effect looks for nearby geometry, in world units. Small values catch fine detail; large ones shade whole recesses."
                />
              </>
            )}

            <Toggle
              label="Bloom" checked={post.bloom} onChange={v => onPost({ bloom: v })}
              info="Bleeds light out of the brightest parts of the frame. If a whole frame ever goes white, this is the amplifier — turn it off to confirm, then look for a NaN in the geometry."
            />
            {post.bloom && (
              <>
                <Slider
                  label="Bloom strength" value={post.bloomIntensity} min={0} max={2} step={0.01}
                  onChange={v => onPost({ bloomIntensity: v })}
                  info="How much of that glow is mixed back into the frame."
                />
                <Slider
                  label="Bloom threshold" value={post.bloomThreshold} min={0} max={1} step={0.01}
                  onChange={v => onPost({ bloomThreshold: v })}
                  info="How bright a pixel must be before it glows at all. Low values bloom the whole image into haze; high ones catch only speculars and sky."
                />
              </>
            )}

            <Toggle
              label="Depth of field" checked={post.depthOfField}
              onChange={v => onPost({ depthOfField: v })}
              info="Blurs what is not at the focal distance, like a real lens. It switches the renderer to standard depth precision, which can introduce z-fighting on very large zones."
            />
            {post.depthOfField && (
              <>
                <Toggle
                  label="Focus on view centre" checked={post.dofAutofocus}
                  onChange={v => onPost({ dofAutofocus: v })}
                  info="Focus on whatever sits at the middle of the view and follow it as you move, the way a camera's autofocus would."
                />
                {!post.dofAutofocus && (
                  <Slider
                    label="Focus distance" value={post.dofFocusDistance} min={20} max={20000} step={20}
                    onChange={v => onPost({ dofFocusDistance: v })} format={v => `${v.toFixed(0)} u`}
                    info="Distance to the focal plane in world units. Zones are large — several thousand units across is normal — so this is a coarse dial, not a fine one."
                  />
                )}
                <Slider
                  label="Focus range" value={post.dofFocalLength} min={50} max={12000} step={50}
                  onChange={v => onPost({ dofFocalLength: v })} format={v => `${v.toFixed(0)} u`}
                  info="How much stays sharp either side of the focal plane. Wider keeps more of the scene in focus; narrow gives the miniature look."
                />
                <Slider
                  label="Blur amount" value={post.dofBokehScale} min={0} max={12} step={0.1}
                  onChange={v => onPost({ dofBokehScale: v })}
                  info="How strongly out-of-focus areas are blurred."
                />
              </>
            )}

            <Toggle
              label="Colour grading" checked={post.colorGrade}
              onChange={v => onPost({ colorGrade: v })}
              info="Saturation, contrast and brightness applied to the final image — the quickest way to move the whole look without touching the lighting."
            />
            {post.colorGrade && (
              <>
                <Slider
                  label="Saturation" value={post.saturation} min={-1} max={1} step={0.01}
                  onChange={v => onPost({ saturation: v })}
                  info="Colour intensity. -1 is greyscale; FFXI's art is already fairly muted, so a little goes a long way."
                />
                <Slider
                  label="Contrast" value={post.contrast} min={-0.5} max={0.5} step={0.01}
                  onChange={v => onPost({ contrast: v })}
                  info="Spread between darks and lights. Raising it deepens shadows at the cost of detail inside them."
                />
                <Slider
                  label="Brightness" value={post.brightness} min={-0.5} max={0.5} step={0.01}
                  onChange={v => onPost({ brightness: v })}
                  info="Lifts or lowers the whole image after grading. Exposure is usually the better dial; this one flattens as it lifts."
                />
              </>
            )}

            <Toggle
              label="Vignette" checked={post.vignette} onChange={v => onPost({ vignette: v })}
              info="Darkens the corners of the frame to draw the eye to the middle."
            />
            {post.vignette && (
              <Slider
                label="Vignette darkness" value={post.vignetteDarkness} min={0} max={1.5} step={0.01}
                onChange={v => onPost({ vignetteDarkness: v })}
                info="How dark those corners go."
              />
            )}
          </>
        )}
      </Section>

      <Section
        title="Map view"
        info="A top-down orthographic capture, for making a map of a zone. Use Screenshot to save what you frame here."
      >
        <Toggle
          label="Top-down map (orthographic)"
          checked={scene.mapView}
          onChange={v => onScene({ mapView: v })}
          info="Removes perspective entirely and looks straight down. A normal camera splays walls outward from the centre of frame, so only the middle of a bird's-eye shot is true; an orthographic one is true everywhere. It takes the camera over completely, so no other camera control applies."
        />
        {scene.mapView && (
          <>
            <Slider
              label="Zoom" value={scene.mapZoom} min={0.1} max={2} step={0.01}
              onChange={v => onScene({ mapZoom: v })}
              info="Fraction of the zone's own extent to frame — 1.00 fits the whole zone. The frustum is sized in world units, so a map captured at one window size matches one captured at another."
            />
            <Slider
              label="Rotation" value={scene.mapRotation} min={0} max={360} step={1}
              onChange={v => onScene({ mapRotation: v })}
              format={v => `${Math.round(v)}°`}
              info="Spin the plan around the vertical axis, to line the zone up the way you want it on the page."
            />
            <p className="note small">
              Turning off <strong>Show sky</strong> and picking a flat background
              gives a cleaner plate to trace over.
            </p>
          </>
        )}
      </Section>

      <Section
        title="Music"
        info="The zone's own background music, decoded from the BGW files in your installation. 148 of 298 zones have an ambient track; the rest are genuinely silent in FFXI's own data."
      >
        <Toggle
          label="Zone music"
          checked={music.enabled}
          onChange={v => onMusic({ enabled: v })}
          info="Play the track FFXI assigns to this zone, read straight from the install. Off by default — a viewer that starts playing the moment it opens a zone is startling."
        />
        {music.enabled && (
          <>
            <Slider
              label="Volume" value={music.volume} min={0} max={1} step={0.01}
              onChange={v => onMusic({ volume: v })}
              info="Output level. It rides the gain node, so dragging this does not restart the track."
            />
            <p className="note small">{describeMusic(musicStatus)}</p>
          </>
        )}
      </Section>

      <Section
        title="Weather"
        info="Every zone carries a set of sky and weather meshes that the client swaps between at runtime. FFXI ships no placement for any of it, so where these sit is the viewer's choice, not the game's data."
      >
        {weatherStates.length === 0 ? (
          <p className="note small">This zone carries no weather geometry.</p>
        ) : (
          <>
            <SelectField
              label="State"
              value={scene.weatherState}
              onChange={v => onScene({ weatherState: v })}
              info="Which weather state to draw. Nothing is drawn until you choose one, and only one at a time: drawing them all together is what made the old weather toggle look like nonsense."
            >
              <option value="">None</option>
              {weatherStates.map(s => (
                <option key={s} value={s}>{WEATHER_LABELS[s] ?? s}</option>
              ))}
            </SelectField>
            <Toggle
              label="Follow camera"
              checked={scene.weatherFollowsCamera}
              onChange={v => onScene({ weatherFollowsCamera: v })}
              info="Centre the weather geometry on the viewer instead of leaving it at the zone origin. The domes are about 241 units across against zones of 1400, so left where they sit they read as a patch on the ground. This only takes effect in Walk mode."
            />
          </>
        )}
      </Section>

      <Section
        title="Scene"
        info="The world itself — time, atmosphere, and what gets drawn — as opposed to how it is lit or graded."
      >
        <Slider
          label="Time of day" value={scene.timeOfDay} min={0} max={23.99} step={0.05}
          onChange={v => onScene({ timeOfDay: v })} format={formatHour}
          info="Drives the sky colour, and the sun's position whenever it is set to follow the time. This is the viewer's own clock, not FFXI's Vana'diel time."
        />
        <Slider
          label="Fog density" value={scene.fogDensity} min={0} max={8} step={0.02}
          onChange={v => onScene({ fogDensity: v })}
          info="Haze with distance, which is most of what gives a zone its sense of scale. It is suppressed automatically while Map view is on — your setting is kept and comes back when you leave it."
        />
        <Slider
          label="Water tint" value={scene.waterTint} min={0} max={1} step={0.01}
          onChange={v => onScene({ waterTint: v })}
          info="How much of the baked vertex shading tints water surfaces. FFXI stores very dark values there, so a low setting is what keeps rivers from going black."
        />
        {/* Stored as the sample count (1, 2, 4… 16) so `scene_anisotropy=8`
            reads naturally, but driven by a power-of-two slider. */}
        <Slider
          label="Anisotropic filtering"
          value={Math.log2(scene.anisotropy)} min={0} max={4} step={1}
          onChange={v => onScene({ anisotropy: 2 ** v })}
          format={v => (v === 0 ? 'Off' : `${2 ** v}×`)}
          info="Keeps ground textures sharp where they meet the view at a shallow angle, instead of blurring a few metres out. FFXI had none of this, so Off is what the game actually looked like."
        />
        <Toggle
          label="Show sky" checked={scene.showSky}
          onChange={v => onScene({ showSky: v })}
          info="Draw the procedural sky dome. Off replaces it with a flat colour, which is cleaner for map captures and for cutting a zone out of its background."
        />
        {!scene.showSky && (
          <>
            <ColorPick
              label="Background"
              value={scene.backgroundColor}
              onChange={v => onScene({ backgroundColor: v })}
              info="The flat backdrop used in place of the sky."
            />
            <Toggle
              label="Background follows time"
              checked={scene.backgroundFollowsTime}
              onChange={v => onScene({ backgroundFollowsTime: v })}
              info="Darken that backdrop with the time-of-day slider instead of holding the picked colour exactly."
            />
          </>
        )}
        <Toggle
          label="Blend terrain overlays"
          checked={scene.overlayBlend}
          onChange={v => onScene({ overlayBlend: v })}
          info="FFXI lays an overlay layer over base ground and fades it in with a per-vertex weight. Dropping that weight draws every overlay at full strength, which is what the pale mismatched squares in the Gustabergs are. Off for now: the fix is real but incomplete, and some squares survive it."
        />
        <Toggle
          label="Wireframe" checked={scene.wireframe}
          onChange={v => onScene({ wireframe: v })}
          info="Draw every zone mesh as edges only. Useful for seeing how the terrain is actually built, and how much of a zone is instanced repeats."
        />
        <Toggle
          label="Show collision"
          checked={scene.showCollision}
          onChange={v => onScene({ showCollision: v })}
          info="Draw the collision mesh FFXI actually uses for movement, in green. It is not the visible geometry — it carries invisible walls and leaves out decoration — so it will not match the art everywhere. This is exactly what Walk mode stands on."
        />
      </Section>
    </div>
  )
}
