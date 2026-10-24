import rawSpells from '../../../../resources/spell-effects.json'

/**
 * Spells and the effect file each plays, for the spell effect browser.
 *
 * The client never says which effect a spell uses — the server sends it with
 * the cast — so the numbers come from LandSandBoat's sql/spell_list.sql
 * (GPL-3.0; ids, names and categories only, extracted 2026-10-24 and credited
 * in THIRD-PARTY-NOTICES). The effect's file is number 0xAF0 + `effect` in the
 * install's own file tables (xim SpellAnimationTable): Cure, effect 1, is
 * ROM/10/9.DAT, its folder `care`.
 */
export interface SpellEntry {
  id: number
  name: string
  /** The effect number: file 0xAF0 + this. */
  effect: number
  /** Magic skill, as LandSandBoat names it: healing, elemental, ninjutsu... */
  skill: string
  element: string
  /** Valid targets, a bit field (1 self, 4 enemy, ...). */
  targets: number
}

/** First file number of the spell effects. */
export const SPELL_EFFECT_BASE = 0xaf0

export const SPELLS: SpellEntry[] = (rawSpells as SpellEntry[])
  .filter(s => s.name && s.effect > 0)

/** Skills in the order a player meets them, then the rest. */
const ORDER = ['healing', 'enhancing', 'enfeebling', 'divine', 'elemental', 'dark', 'singing', 'ninjutsu', 'summoning', 'blue', 'geomancy']
export const SPELL_SKILLS: string[] = [...new Set(SPELLS.map(s => s.skill))]
  .sort((a, b) => ((ORDER.indexOf(a) + 1) || 99) - ((ORDER.indexOf(b) + 1) || 99))

/** Offensive: castable on an enemy and not on yourself. */
export const offensive = (s: SpellEntry) => (s.targets & 4) !== 0 && (s.targets & 1) === 0
