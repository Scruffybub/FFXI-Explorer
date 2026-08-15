import type { ZoneEntry } from './zoneList'

/**
 * Which expansion a zone shipped with.
 *
 * This is *derived from the install*, not from a hand-written zone list. FFXI
 * shipped each expansion's data in its own ROM archive, and the zone table's
 * model path names the archive it lives in:
 *
 *   ROM   base game        ROM3  Chains of Promathia    ROM5  Wings of the Goddess
 *   ROM2  Rise of the Zilart   ROM4  Treasures of Aht Urhgan   ROM9  Seekers of Adoulin
 *
 * The split is exact across all 285 zones we ship: ROM2 holds precisely the
 * Zilart set (Sky, the jungles, Altepa, Norg, Kazham, Dynamis), ROM3 the
 * Promathia set (Tavnazia, Promyvion, Sea, Limbus), ROM4 ids 46-79 (the whole
 * Aht Urhgan continent), ROM5 the Wings set including every [S] past zone, and
 * ROM9 the Adoulin set.
 *
 * Content added by later version updates has no archive of its own — it was
 * appended to the base ROM under high directory numbers (ROM/240 upward), so
 * the archive rule alone would call it base game. Those are listed by id below.
 *
 * Two known soft spots, both flagged to Ryan rather than guessed at:
 *  - `LATER_UPDATE` is deliberately coarse. Escha, Reisenjima, Provenance,
 *    Legion and Dynamis Divergence each arrived in a different year's update
 *    and none of them belong to an expansion; naming a specific one would be
 *    guesswork where the archive number gives no answer.
 *  - Diorama Abdhaljs-Ghelsba and Abdhaljs Isle-Purgonorgo sit in ROM3 and so
 *    read as Promathia. That is where the data puts them; they are event and
 *    battlefield copies whose *use* is much later than their archive.
 */
export interface Expansion {
  /** Short tag for the sidebar badge. */
  tag: string
  /** Full name with year, shown on hover. */
  label: string
}

const BASE: Expansion = { tag: 'Base', label: 'Final Fantasy XI (2002)' }
const ROZ: Expansion = { tag: 'RoZ', label: 'Rise of the Zilart (2003)' }
const COP: Expansion = { tag: 'CoP', label: 'Chains of Promathia (2004)' }
const TOAU: Expansion = { tag: 'ToAU', label: 'Treasures of Aht Urhgan (2006)' }
const WOTG: Expansion = { tag: 'WotG', label: 'Wings of the Goddess (2007)' }
const ABYSSEA: Expansion = { tag: 'Abyssea', label: 'Abyssea add-ons (2010)' }
const SOA: Expansion = { tag: 'SoA', label: 'Seekers of Adoulin (2013)' }
const LATER_UPDATE: Expansion = { tag: 'Update', label: 'Added by a later version update' }

/** Model-path archive → expansion. Anything else is the base game. */
const BY_ARCHIVE: Record<string, Expansion> = {
  ROM2: ROZ,
  ROM3: COP,
  ROM4: TOAU,
  ROM5: WOTG,
  ROM9: SOA,
}

/**
 * Zones the archive rule gets wrong, because later content was filed into the
 * base ROM. Keyed by zone id.
 */
const BY_ID: Record<number, Expansion> = {
  // The nine Abyssea areas plus their Empyreal Paradox, ROM/240, /254 and /258.
  15: ABYSSEA, 45: ABYSSEA, 132: ABYSSEA, 215: ABYSSEA, 216: ABYSSEA,
  217: ABYSSEA, 218: ABYSSEA, 253: ABYSSEA, 254: ABYSSEA, 255: ABYSSEA,
  // Adoulin content filed outside ROM9.
  280: SOA,   // Mog Garden
  282: SOA,   // Mount Kamihr
  284: SOA,   // Celennia Memorial Library
  // Update content: Legion (ROM/1, so the archive says base game), Voidwatch's
  // Provenance, Vagary's Feretory, Escha, Reisenjima, Dynamis Divergence.
  183: LATER_UPDATE, 222: LATER_UPDATE, 285: LATER_UPDATE,
  288: LATER_UPDATE, 289: LATER_UPDATE, 290: LATER_UPDATE,
  291: LATER_UPDATE, 292: LATER_UPDATE, 293: LATER_UPDATE,
  294: LATER_UPDATE, 295: LATER_UPDATE, 296: LATER_UPDATE, 297: LATER_UPDATE,
}

/** The expansion a zone shipped with. Every zone resolves to one. */
export function expansionFor(zone: ZoneEntry): Expansion {
  const byId = BY_ID[zone.id]
  if (byId) return byId
  const archive = zone.modelPath.split('/')[0].toUpperCase()
  return BY_ARCHIVE[archive] ?? BASE
}
