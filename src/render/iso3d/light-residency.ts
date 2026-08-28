/**
 * Which lights get one of the pool's slots (spec 250).
 *
 * A world with fixtures in it has more lights than a frame can afford, and the
 * two costs are different costs with different fixes. This module is the second
 * one: *which* of them are lit right now. The first -- that the number of lights
 * on the scene must never change -- is why there is a fixed pool for this to
 * assign at all, and lives in `world-lights.ts` beside the three.js it is about.
 *
 * Pure, and a decision rather than a thing that draws, which is the split every
 * view-model in this directory keeps.
 *
 * ## Hysteresis is the whole of it
 *
 * A slot assignment that flipped between two fixtures at the same distance would
 * pop a light on and off every frame -- the most visible thing in this system,
 * driven by the cheapest possible indecision. So a request is
 * *claimed* within {@link LightLimits.activateRadius} and *kept* until past
 * `releaseRadius`, and a slot is only taken off a light already in it by a
 * candidate nearer by more than `swapMargin`.
 *
 * That is spec 208's shape for map chunks, and its reason: **the thing that lets
 * go must not fight the thing that takes hold.** There, a keep radius was
 * derived from a request radius so a chunk between them is held and unasked;
 * here, a light between the two radii is lit and not competed for.
 *
 * ## Why every slot is the same
 *
 * There was a shadow-casting prefix here, and two sub-pools to keep a
 * shadowless light out of it: `castShadow` is part of three's program key, so a
 * slot cannot change its mind about casting, and a light dropped into a casting
 * slot would have sampled whatever was last baked into that slot's cube map.
 * Nothing casts now -- see `world-lights.ts` for why -- so a slot is a slot and
 * the whole split went with it.
 */

export interface LightRequest {
  /**
   * Stable for as long as this is the same light in the same place.
   *
   * What the whole of the hysteresis is keyed on, so a key that changed every
   * time a region was recomposed would reassign every slot near the player on
   * every stream event -- which is exactly the flicker this module exists to
   * prevent.
   */
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color: number;
  readonly brightness: number;
  readonly radius: number;
}

export interface LightLimits {
  /** Total slots. */
  readonly slots: number;
  /** Nothing further than this is ever claimed. */
  readonly activateRadius: number;
  /** A light already in a slot keeps it until it is further than this. */
  readonly releaseRadius: number;
  /** How much nearer a candidate must be to take an occupied slot. */
  readonly swapMargin: number;
}

/** Where the lights are measured from: the point the camera is framing. */
export interface LightFocus {
  readonly x: number;
  readonly z: number;
}

/**
 * How far a light is from the focus, on the ground plane.
 *
 * Flat, and deliberately: this camera is orthographic and parks a constant
 * distance from what it frames, so height above the ground says nothing about
 * whether a light is on screen -- and a lamp post's flame is a body and a half
 * up, which under a 3D distance would make a lamp consistently less eligible
 * than a campfire standing next to it.
 */
function distanceTo(focus: LightFocus, light: LightRequest): number {
  return Math.hypot(light.x - focus.x, light.z - focus.z);
}

/** Nearest first, ties broken on the key so the answer never depends on order. */
function byDistanceThenKey(
  a: { readonly d: number; readonly request: LightRequest },
  b: { readonly d: number; readonly request: LightRequest },
): number {
  if (a.d !== b.d) return a.d - b.d;
  return a.request.key < b.request.key ? -1 : a.request.key > b.request.key ? 1 : 0;
}

/**
 * Fill the pool.
 *
 * Three passes, in this order, and the order is the hysteresis:
 *
 *  1. **Keep** what is already in a slot, while it is still offered and still
 *     inside the release radius.
 *  2. **Fill** free slots from the nearest candidates inside the activate
 *     radius.
 *  3. **Swap** only where a candidate is nearer than the worst held light by
 *     more than the margin -- which is the only pass that can put a light out,
 *     so it is the one with a threshold on it.
 */
function fillPool(
  slotIndices: readonly number[],
  candidates: readonly LightRequest[],
  held: readonly (string | null)[],
  focus: LightFocus,
  limits: LightLimits,
  out: (string | null)[],
): void {
  const ranked = candidates
    .map((request) => ({ d: distanceTo(focus, request), request }))
    .sort(byDistanceThenKey);
  const byKey = new Map(ranked.map((one) => [one.request.key, one]));

  const taken = new Set<string>();
  for (const slot of slotIndices) {
    const key = held[slot] ?? null;
    if (key === null) continue;
    const still = byKey.get(key);
    // Gone from the offer, or walked out of the release radius. Either way the
    // slot is free -- and an offer that vanished is the ordinary case, since a
    // region the client forgot takes its fixtures with it.
    if (!still || still.d > limits.releaseRadius) continue;
    // One light, one slot. `held` comes back from the caller's own last answer
    // and so cannot normally repeat a key, but a duplicate that slipped in would
    // be one light drawn twice as bright as it asked for, which is the kind of
    // thing nobody would ever think to look for.
    if (taken.has(key)) continue;
    out[slot] = key;
    taken.add(key);
  }

  const waiting = ranked.filter(
    (one) => !taken.has(one.request.key) && one.d <= limits.activateRadius,
  );
  let next = 0;
  for (const slot of slotIndices) {
    if (out[slot] !== null) continue;
    const one = waiting[next];
    if (!one) break;
    next++;
    out[slot] = one.request.key;
    taken.add(one.request.key);
  }

  // Whoever is left wants a slot somebody else has. Take the furthest held one
  // first, and only where the gap is worth putting a light out for.
  for (; next < waiting.length; next++) {
    const one = waiting[next];
    if (!one) break;
    let worst: { slot: number; d: number } | null = null;
    for (const slot of slotIndices) {
      const key = out[slot];
      if (key === null || key === undefined) continue;
      const sitting = byKey.get(key);
      // A slot holding a key this sub-pool cannot rank is one it just kept; it
      // is in range by construction, so there is nothing to compare against.
      if (!sitting) continue;
      if (!worst || sitting.d > worst.d) worst = { slot, d: sitting.d };
    }
    if (!worst || one.d >= worst.d - limits.swapMargin) break;
    out[worst.slot] = one.request.key;
  }
}

/**
 * What each pool slot should hold, given what it holds now.
 *
 * A pure function of its arguments: the same requests, the same held array and
 * the same focus give the same answer, whatever order the requests arrive in.
 * That is asserted rather than assumed, because a residency that depended on
 * arrival order would be a village that lit itself differently depending on
 * which region the worker happened to finish first.
 *
 * `held` is read positionally and may be shorter than the pool; a slot it says
 * nothing about is treated as empty.
 */
export function assignLights(
  requests: readonly LightRequest[],
  held: readonly (string | null)[],
  focus: LightFocus,
  limits: LightLimits,
): readonly (string | null)[] {
  const out: (string | null)[] = Array.from({ length: limits.slots }, () => null);
  const slots = Array.from({ length: limits.slots }, (_unused, slot) => slot);
  fillPool(slots, requests, held, focus, limits, out);
  return out;
}
