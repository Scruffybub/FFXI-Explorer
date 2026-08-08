import {
  RACES, SLOTS, equipOptions, faceOptions,
  type CharacterSpec,
} from '../lib/characterModel'

/**
 * Sidebar controls for assembling a player character: race, face, and one
 * dropdown per visible equipment slot.
 *
 * Model indices are shown alongside each entry because that is the only handle
 * FFXI gives these — the DATs carry no names, and mapping index to item name
 * needs the item database, which this app does not have.
 */
export default function CharacterBuilder({
  spec, onChange, onClear,
}: {
  spec: CharacterSpec
  onChange: (patch: Partial<CharacterSpec>) => void
  onClear: () => void
}) {
  const faces = faceOptions(spec.race)

  return (
    <div className="builder">
      <label className="control">
        <span>Race</span>
        <select
          value={spec.race}
          onChange={e => {
            // Model indices are per race, so a change has to reset the outfit —
            // index 40 on a Galka is not the same piece as on a Tarutaru.
            onChange({ race: Number(e.target.value), face: 0, equipment: {} })
          }}
        >
          {RACES.map(r => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      </label>

      <label className="control">
        <span>Face</span>
        <select
          value={spec.face ?? ''}
          onChange={e => onChange({ face: e.target.value === '' ? null : Number(e.target.value) })}
        >
          <option value="">None</option>
          {faces.map((f, i) => (
            <option key={f.path} value={i}>{f.name}</option>
          ))}
        </select>
      </label>

      {SLOTS.map(slot => {
        const options = equipOptions(spec.race, slot.id)
        const value = spec.equipment[slot.id]
        return (
          <label className="control" key={slot.id}>
            <span className="control-row">
              {slot.label}
              <span className="value">{options.length}</span>
            </span>
            <select
              value={value ?? ''}
              onChange={e => onChange({
                equipment: {
                  ...spec.equipment,
                  [slot.id]: e.target.value === '' ? null : Number(e.target.value),
                },
              })}
            >
              <option value="">None</option>
              {options.map(o => (
                <option key={o.index} value={o.index}>
                  {o.index} — {o.path}
                </option>
              ))}
            </select>
          </label>
        )
      })}

      <button className="clear-equip" onClick={onClear}>Strip equipment</button>
    </div>
  )
}
