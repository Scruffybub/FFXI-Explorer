/**
 * Vana'diel's calendar, as far as the sky needs it: the moon.
 *
 * Vana'diel time runs 25 times faster than Earth time, counted from the epoch
 * 2002-01-01 00:00 JST (Unix 1009810800), which is the start of year 886. The
 * moon cycles every 84 Vana'diel days: with d = (days since year 0 + 26) % 84,
 * the moon is full at d = 0, wanes to new at d = 42, then waxes back. Rule from
 * LandSandBoat's vana_time.h (moon::get_phase / get_direction; GPL, read as a
 * description of the game's behaviour, no code copied).
 *
 * The game's phase sprite ("moon    moonshap", the weather's `moon`
 * generator) is a sheet of 12 frames in cycle order: 0 new, 1-5 waxing, 6 full,
 * 7-11 waning — a frame every seven days.
 */

const EPOCH_S = 1009810800
const DAY_S = 86400
const YEAR_DAYS = 360

/** Days since Vana'diel year 0 at an Earth time. */
export function vanadielDays(at: Date = new Date()): number {
  return Math.floor(((at.getTime() / 1000 - EPOCH_S) * 25) / DAY_S) + 886 * YEAR_DAYS
}

export interface MoonPhase {
  /** 0..83, 0 = full, 42 = new. */
  cycleDay: number
  /** Illumination as the game reports it, 0..100. */
  percent: number
  waxing: boolean
  /** Frame of the phase sheet, 0..11. */
  frame: number
}

export function moonPhase(at: Date = new Date()): MoonPhase {
  const d = (((vanadielDays(at) + 26) % 84) + 84) % 84
  const percent = d >= 42 ? Math.round((100 * (d - 42)) / 42) : Math.round(100 * (1 - d / 42))
  const sinceNew = (d - 42 + 84) % 84
  return { cycleDay: d, percent, waxing: d > 42, frame: Math.round(sinceNew / 7) % 12 }
}

/** The 12 frames of the phase sheet, with the illumination each stands for. */
export const MOON_FRAMES: { name: string; percent: number }[] = [
  'New moon', 'Waxing crescent', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Waxing gibbous',
  'Full moon', 'Waning gibbous', 'Waning gibbous', 'Last quarter', 'Waning crescent', 'Waning crescent',
].map((name, f) => ({ name, percent: Math.round((100 * Math.min(f, 12 - f)) / 6) }))

/** The frame a setting asks for: -1 is today's moon in Vana'diel. */
export function moonFrameFor(setting: number, at: Date = new Date()): number {
  return setting >= 0 && setting < 12 ? setting : moonPhase(at).frame
}
