import * as THREE from 'three'

/**
 * Child generators started by weather particles (GeneratorSpawn.children):
 * WeatherParticles posts one when a parent particle is born or expires, and
 * SkyLayers plays the matching child there. Riverne's thunder works this way —
 * the invisible timekeepers `nul1`/`nul2` start the bolts (`thd1`, `thd2`) and
 * their glows (`fit1`..`fit3`).
 *
 * A plain list rather than React state: both sides run in useFrame, and a post
 * is read on the next frame or two at most.
 */
export interface ChildEvent {
  /** The child generator's chunk name, and the folder its parent lives in. */
  name: string
  dir: string
  /** Effect frame of the start (60 a second, the clock both sides share). */
  frame: number
  /** Where the parent particle was, in world space. */
  at: THREE.Vector3
}

export const childEvents: ChildEvent[] = []

/** Drop posts nobody has taken, so a zone without listeners cannot pile up. */
export function pruneChildEvents(frame: number) {
  let keep = 0
  for (const e of childEvents) if (frame - e.frame < 120) childEvents[keep++] = e
  childEvents.length = keep
}
