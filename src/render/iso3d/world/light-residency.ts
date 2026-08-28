/**
 * Which lights get one of the pool's slots (spec 248).
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
 * re-bake a shadow cube map every frame -- the single most expensive thing in
 * this system, driven by the cheapest possible indecision. So a request is
 * *claimed* within {@link LightLimits.activateRadius} and *kept* until past
 * `releaseRadius`, and a slot is only taken off a light already in it by a
 * candidate nearer by more than `swapMargin`.
 *
 * That is spec 208's shape for map chunks, and its reason: **the thing that lets
 * go must not fight the thing that takes hold.** There, a keep radius was
 * derived from a request radius so a chunk between them is held and unasked;
 * here, a light between the two radii is lit and not competed for.
 *
 * ## Why two sub-pools rather than one
 *
 * A pool light either casts shadows or it does not, for the life of the scene:
 * `castShadow` is part of three's program key, so a light that sometimes cast
 * would recompile every material in the world the moment somebody walked past a
 * campfire. So the pool has a shadow-casting prefix, and a light that wants no
 * shadow may never sit in it -- a shadowless light in a casting slot would still
 * sample whatever was last baked into that slot's cube map, which is somebody
 * else's shadows, frozen.
 *
 * A fixture that wants a shadow and cannot get a casting slot falls back to a
 * plain one: lit with no shadow is much closer to right than not lit at all.
 */

export interface LightRequest {
  /**
   * Stable for as long as this is the same light in the same place.
   *
   * What the whole of the hysteresis is keyed on, so a key that changed every
   * time a region was recomposed would re-bake a shadow map on every stream
   * event -- which is exactly the cost this module exists to avoid paying.
   */
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color: number;
  readonly brightness: number;
  readonly radius: number;
  /** Whether this light wants a slot that casts. */
  readonly shadow: boolean;
  /**
   * Bumped when the world under this light has changed since it was baked.
   *
   * Not read here -- assignment does not care -- but carried on the request so
   * that the one place holding a light's identity holds all of it.
   */
  readonly revision: number;
}

export interface LightLimits {
  /** How many of the pool's slots cast shadows. The pool's prefix. */
  readonly shadowSlots: number;
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
 * Fill one sub-pool, and answer which requests it could not take.
 *
 * Three passes, in this order, and the order is the hysteresis:
 *
 *  1. **Keep** what is already in a slot, while it is still offered and still
 *     inside the release radius.
 *  2. **Fill** free slots from the nearest candidates inside the activate
 *     radius.
 *  3. **Swap** only where a candidate is nearer than the worst held light by
 *     more than the margin -- which is the pass that can cost a bake, so it is
 *     the one with a threshold on it.
 */
function fillPool(
  slotIndices: readonly number[],
  candidates: readonly LightRequest[],
  held: readonly (string | null)[],
  focus: LightFocus,
  limits: LightLimits,
  out: (string | null)[],
): readonly LightRequest[] {
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
  // first, and only where the gap is worth a re-bake.
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

  return waiting.slice(next).map((one) => one.request);
}

/**
 * What each pool slot should hold, given what it holds now.
 *
 * A pure function of its arguments: the same requests, the same held array and
 * the same focus give the same answer, whatever order the requests arrive in.
 * That is asserted rather than assumed, because a residency that depended on
 * arrival order would be a shadow bake that depended on which region the worker
 * happened to finish first.
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
  const shadowSlots: number[] = [];
  const plainSlots: number[] = [];
  for (let slot = 0; slot < limits.slots; slot++) {
    if (slot < limits.shadowSlots) shadowSlots.push(slot);
    else plainSlots.push(slot);
  }

  // The casting prefix first, so a fixture that wants shadows gets first refusal
  // on the slots that can give it one -- and falls through to a plain slot with
  // everything else if it does not.
  const wantsShadow = requests.filter((request) => request.shadow);
  const spilled = fillPool(shadowSlots, wantsShadow, held, focus, limits, out);
  const plain = [...requests.filter((request) => !request.shadow), ...spilled];
  fillPool(plainSlots, plain, held, focus, limits, out);
  return out;
}
