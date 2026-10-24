import { animationOptions } from './characterModel'

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
