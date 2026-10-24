import { animationOptions } from './characterModel'
import rawAbilities from '../../../../resources/ability-effects.json'
import rawMobSkills from '../../../../resources/mob-skill-effects.json'
import rawSkillLists from '../../../../resources/mob-skill-lists.json'

/**
 * Weapon skills, job abilities and dances for the effect browser, per race.
 *
 * Unlike spells, these need no outside table: the animation list (Vanalytics'
 * animation-paths.json, by race) already names each one with its file, and
 * each file is the whole package — its `main` routine, its generators and
 * the caster's own motions for it (Fast Blade, ROM/76/30 for a Hume male:
 * b00? b02?; Savage Blade: ws1?). The game's own route is a per-race base in
 * FFXiMain.dll plus a LandSandBoat id (xim AbilityTable); the list spares us
 * both.
 */
export interface SkillEntry {
  name: string
  /** Weapon type, or Ability / Dancer. */
  category: string
  path: string
}

/** The categories that are skills a character uses; the rest are emotes and motions. */
export const SKILL_CATEGORIES = [
  'Hand-to-Hand', 'Dagger', 'Sword', 'G. Sword', 'Axe', 'G. Axe', 'Scythe', 'Polearm',
  'Katana', 'G. Katana', 'Club', 'Staff', 'Archery', 'Marksmanship', 'Ability', 'Dancer',
]

export function skillOptions(race: number): SkillEntry[] {
  return animationOptions(race)
    .filter(e => SKILL_CATEGORIES.includes(e.category) && e.paths.length > 0)
    .map(e => ({ name: e.name, category: e.category, path: e.paths[0] }))
}

/**
 * Job abilities (Mighty Strikes, Provoke..) and monster moves, by the numbers
 * LandSandBoat's abilities.sql and mob_skills.sql give (GPL-3.0; ids and
 * names only, scripts/build-skill-effects.cjs, credited in
 * THIRD-PARTY-NOTICES). Their effect files are found the way xim does
 * (AbilityTable, MobSkillInfoTable).
 */
export interface NumberedSkill {
  id: number
  name: string
  /** A job ability's job (WAR, MNK..); none for monster moves. */
  job?: string
  animation: number
}

export const JOB_ABILITIES = rawAbilities as NumberedSkill[]
export const MONSTER_MOVES = rawMobSkills as NumberedSkill[]

/** A job ability's effect file number: 0x113C + its animation. */
export const abilityFileId = (a: NumberedSkill) => 0x113c + a.animation

/**
 * A monster move's effect file number: its animation plus a base by range.
 * About 84% resolve in a current install; the rest point at empty slots.
 */
export function monsterMoveFileId(m: NumberedSkill): number {
  const a = m.animation
  return a + (a < 0x200 ? 0x0f3c : a < 0x600 ? 0xc1ef : a < 0x800 ? 0xe739 : 0x14b07)
}

const SKILL_LISTS = rawSkillLists as Record<string, number[]>
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
const LIST_BY_NORM = new Map(Object.keys(SKILL_LISTS).map(k => [norm(k), k]))

/**
 * The moves a creature's family has (LandSandBoat mob_skill_lists), matched
 * by name: the catalogue name without its number and any "(S)", then its
 * last word ("Lesser Bird" → Bird), then the longest list name it starts
 * with ("Antican" → Antica). 116 of the catalogue's 152 creature families
 * match exactly or by prefix; null when nothing does.
 */
export function movesForCreature(name: string): { family: string; ids: Set<number> } | null {
  const base = name.replace(/\s*\([^)]*\)/g, '').replace(/(\s+\d+)+$/, '').trim()
  const words = base.split(/\s+/)
  const tries = [norm(base), norm(words[words.length - 1])]
  let key = tries.map(t => LIST_BY_NORM.get(t)).find(Boolean)
  if (!key) {
    const b = norm(base)
    const prefixes = [...LIST_BY_NORM.keys()].filter(k => k.length >= 4 && b.startsWith(k)).sort((x, y) => y.length - x.length)
    key = prefixes.length ? LIST_BY_NORM.get(prefixes[0]) : undefined
  }
  return key ? { family: key, ids: new Set(SKILL_LISTS[key]) } : null
}
