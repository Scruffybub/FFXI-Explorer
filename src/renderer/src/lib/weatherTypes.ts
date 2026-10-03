import rawZoneWeather from '../../../../resources/zone-weather.json'

/**
 * FFXI's twenty weather states, in the client's own order, with the
 * <zone>/weat/<dir>/ directory each is drawn from.
 *
 * The order is the server's weather number (0 none … 19 darkness) and the
 * directories are the client's table (XIClient WeatherCondition.cpp, as cited by
 * kuluu-ffxi weather.rs). A few zones use a second table with `1`-suffixed
 * directories (sun1, clo1…) — `alt` lists those. A weather whose directory the
 * zone does not ship is drawn by the game as sunshine.
 */
export interface WeatherType {
  id: number
  dir: string
  alt: string[]
  name: string
  element: string | null
}

export const WEATHER_TYPES: WeatherType[] = [
  { id: 0, dir: 'fine', alt: [], name: 'Fair', element: null },
  { id: 1, dir: 'suny', alt: ['sun1'], name: 'Sunshine', element: null },
  { id: 2, dir: 'clod', alt: ['clo1'], name: 'Clouds', element: null },
  { id: 3, dir: 'mist', alt: ['mis1'], name: 'Fog', element: null },
  { id: 4, dir: 'dryw', alt: ['dry1'], name: 'Hot Spell', element: 'Fire' },
  { id: 5, dir: 'heat', alt: [], name: 'Heat Wave', element: 'Fire' },
  { id: 6, dir: 'rain', alt: ['rai1'], name: 'Rain', element: 'Water' },
  { id: 7, dir: 'squl', alt: ['squ1'], name: 'Squall', element: 'Water' },
  { id: 8, dir: 'dust', alt: ['dus1'], name: 'Dust Storm', element: 'Earth' },
  { id: 9, dir: 'sand', alt: [], name: 'Sand Storm', element: 'Earth' },
  { id: 10, dir: 'wind', alt: ['win1'], name: 'Wind', element: 'Wind' },
  { id: 11, dir: 'stom', alt: [], name: 'Gales', element: 'Wind' },
  { id: 12, dir: 'snow', alt: [], name: 'Snow', element: 'Ice' },
  { id: 13, dir: 'bliz', alt: [], name: 'Blizzards', element: 'Ice' },
  { id: 14, dir: 'thdr', alt: ['thd1'], name: 'Thunder', element: 'Lightning' },
  { id: 15, dir: 'bolt', alt: [], name: 'Thunderstorms', element: 'Lightning' },
  { id: 16, dir: 'aura', alt: ['aur1'], name: 'Auroras', element: 'Light' },
  { id: 17, dir: 'ligt', alt: ['ligh'], name: 'Stellar Glare', element: 'Light' },
  { id: 18, dir: 'fogd', alt: ['fog1'], name: 'Gloom', element: 'Dark' },
  { id: 19, dir: 'dark', alt: [], name: 'Darkness', element: 'Dark' },
]

/**
 * The weather each zone normally gets, most typical first — ids only. Built by
 * scripts/build-zone-weather.cjs from LandSandBoat's zone weather table (read as
 * data; no frequencies are kept) plus morning fog where the zone ships fog art
 * and is not a city.
 */
const ZONE_WEATHER = rawZoneWeather as Record<string, number[]>

export function nativeWeather(zoneId: number | undefined): number[] {
  return zoneId === undefined ? [] : ZONE_WEATHER[String(zoneId)] ?? []
}

/** The directory this zone draws a weather from, if it ships one. */
export function weatherDir(type: WeatherType, available: string[]): string | null {
  if (available.includes(type.dir)) return type.dir
  return type.alt.find(a => available.includes(a)) ?? null
}

/**
 * The zone's most typical weather it can draw: its first native weather with
 * art, else sunshine, else fair, else whatever it has. '' if it has none.
 */
export function typicalWeather(zoneId: number | undefined, available: string[]): string {
  for (const id of nativeWeather(zoneId)) {
    const dir = weatherDir(WEATHER_TYPES[id], available)
    if (dir) return dir
  }
  return weatherDir(WEATHER_TYPES[1], available) ?? weatherDir(WEATHER_TYPES[0], available) ?? available[0] ?? ''
}
