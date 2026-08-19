/**
 * Where each of a target's attackers stands (spec 187).
 *
 * A pack chasing one player is the case that reads worst without help: every
 * body is routed at the same point, so they arrive on the same side, stack into
 * the same few units of ground and shove each other for the rest of the fight.
 * Local avoidance alone does not fix it -- avoidance answers "how do I not walk
 * into you", and the problem here is that everyone genuinely wants the same
 * place.
 *
 * So a target's surroundings are divided into *slots*: evenly spaced angles on
 * a ring at the attacker's own standoff distance, one body to a slot. An
 * attacker aims at its slot while it closes, which means it comes round to its
 * own side rather than piling onto the near one, and the ring falls out of the
 * approach instead of being marched into.
 *
 * Three properties this is built for, in order of how much they matter:
 *
 *  - **Deterministic.** No RNG, no wall clock, no dependence on hash iteration
 *    order. Claims are taken in the order the caller offers them, which the sim
 *    guarantees is entity creation order, and the search around a preferred
 *    slot is a fixed spiral.
 *  - **Stable.** A body that holds a slot keeps it as long as it is free, so an
 *    attacker does not swap sides every tick as the ring rotates under it.
 *    Without that hysteresis the assignment is correct every tick and the
 *    bodies never arrive anywhere.
 *  - **Cheap.** One integer of state per (target, ring size), and a claim is a
 *    handful of bit tests. Nothing is allocated per attacker.
 *
 * The ring is a *preference*, not a destination: a body stops when it is in
 * reach of its target, wherever on the way to its slot that happens. That is
 * deliberate -- marching to an exact standing position is what makes a pack of
 * animals look like a drill squad, and it is also what makes them shuffle
 * forever when the target moves.
 */

/**
 * The most slots a ring is ever cut into.
 *
 * 32 because the claim set for one ring is a single 32-bit mask, and a ring
 * that wanted more than 32 bodies abreast is a ring around something far larger
 * than anything this game has.
 */
export const MAX_ATTACK_SLOTS = 32;

/**
 * How many bodies of `bodyRadius` stand shoulder to shoulder on a ring of
 * `ringRadius` without overlapping.
 *
 * The chord between two neighbours must be at least a body wide, so the angle
 * one body subtends at the centre is `2 * asin(bodyRadius / ringRadius)` and
 * the count is a full turn divided by it. A ring too small to hold two bodies
 * gets one slot rather than zero -- one attacker standing on the near side is
 * the honest answer there, and dividing by a count of zero is not.
 */
export function slotCount(ringRadius: number, bodyRadius: number): number {
  if (!(ringRadius > 0) || !(bodyRadius > 0)) return 1;
  const ratio = bodyRadius / ringRadius;
  if (ratio >= 1) return 1;
  const count = Math.floor(Math.PI / Math.asin(ratio));
  if (!Number.isFinite(count) || count < 1) return 1;
  return Math.min(count, MAX_ATTACK_SLOTS);
}

/** The world-frame angle of slot `index` on a ring cut into `count`. */
export function slotAngle(index: number, count: number): number {
  return (index * 2 * Math.PI) / count;
}

/** The slot whose angle is nearest `angle`, on a ring cut into `count`. */
export function slotNearest(angle: number, count: number): number {
  const turns = angle / (2 * Math.PI);
  const index = Math.round(turns * count) % count;
  return index < 0 ? index + count : index;
}

/**
 * Which slot each attacker holds, for one tick.
 *
 * Cleared and refilled every tick rather than maintained, because the
 * membership changes constantly -- bodies die, lose interest, are pushed out of
 * leash range -- and a claim nobody released would wall off a side of a target
 * forever. What survives between ticks is the *attacker's* memory of the slot
 * it held, which is passed back in as `held`; that is where the hysteresis
 * lives, and it means a released slot is only ever re-offered to somebody else
 * once its holder has stopped asking for it.
 */
export class SlotBoard {
  /** targetId -> the tightest ring anyone is closing to, and the widest body on it. */
  private readonly rings = new Map<number, { reach: number; radius: number }>();
  /** targetId -> a bit per slot somebody has taken this tick. */
  private readonly claimed = new Map<number, number>();
  /** targetId -> a bit per slot somebody was holding when the tick began. */
  private readonly reserved = new Map<number, number>();

  clear(): void {
    this.rings.clear();
    this.claimed.clear();
    this.reserved.clear();
  }

  /**
   * Declare that a body of `radius` is fighting `targetId` from a ring of
   * `reach`, before anybody claims anything.
   *
   * This is what makes the ring granularity a property of the **target** rather
   * than of each attacker, and it is not a refinement -- it is the difference
   * between the system working and not working on a mixed pack. Cut per
   * attacker, a small_spider's ring around a player is seventeen slots and a
   * ravager's is six; the two sets of angles do not line up, neither excludes
   * the other, and the pair stack on exactly the ground the ring exists to keep
   * them off.
   *
   * The tightest reach and the widest body, because both are the conservative
   * direction: the count that fits the biggest attacker on the smallest ring
   * fits everybody on every larger one. What it costs is that a swarm of small
   * bodies gets a coarser ring while one large body is in the fight, which is
   * the right way round -- the alternative is a ring that says a ravager fits
   * where it does not.
   */
  note(targetId: number, reach: number, radius: number): void {
    const held = this.rings.get(targetId);
    if (!held) {
      this.rings.set(targetId, { reach, radius });
      return;
    }
    if (reach < held.reach) held.reach = reach;
    if (radius > held.radius) held.radius = radius;
  }

  /** How many slots `targetId`'s ring is cut into, given everything that has been noted. */
  cuts(targetId: number): number {
    const ring = this.rings.get(targetId);
    if (!ring) return 1;
    return slotCount(ring.reach, ring.radius);
  }

  /**
   * Hold the slot a body arrived at this tick already holding, before anybody
   * new is offered anything.
   *
   * Without this the hysteresis is only half there, and the half that is
   * missing is the half that matters. Claims are taken in entity creation
   * order, so `take`'s "your held slot wins if it is free" only protects a body
   * from those processed *after* it: an older body with no slot at all can walk
   * off with the exact angle a younger one has been walking toward for a
   * second, and the younger one is shunted round the ring. Reserving first
   * makes it total, and costs one sweep and one integer per target.
   *
   * A body that has **stopped** in reach reserves too, and that is deliberate.
   * Its slot is the ground it is standing on; leaving it unreserved double-
   * books that ground, and the newcomer routed into it finds a body that is
   * pinned, takes the whole of the avoidance itself, and hovers.
   */
  reserve(targetId: number, slot: number): void {
    const slots = this.cuts(targetId);
    if (slot < 0 || slot >= slots) return;
    const key = this.keyFor(targetId, slots);
    this.reserved.set(key, (this.reserved.get(key) ?? 0) | (1 << slot));
  }

  /**
   * Claim a slot on `targetId`'s ring, or -1 when every slot is spoken for.
   *
   * `preferred` is the slot the attacker would like -- normally the one nearest
   * the direction it is already approaching from, so the assignment agrees with
   * the walk already in progress. `held` is the slot it had last tick, or -1;
   * it wins outright, because it reserved that slot before anybody was offered
   * anything.
   *
   * More attackers than slots is answered by -1 rather than by doubling up: the
   * caller falls back to aiming at the target itself, and the bodies queue
   * behind the ring under ordinary avoidance. A second ring would be a better
   * answer and is not worth the state until something in the game fields that
   * many attackers.
   */
  take(targetId: number, preferred: number, held: number): number {
    const slots = this.cuts(targetId);
    const key = this.keyFor(targetId, slots);
    const claimed = this.claimed.get(key) ?? 0;

    if (held >= 0 && held < slots && (claimed & (1 << held)) === 0) {
      this.claimed.set(key, claimed | (1 << held));
      return held;
    }

    // Somebody else's reservation is as good as a claim; our own is not, and we
    // have already taken it above if we wanted it.
    const blocked = claimed | (this.reserved.get(key) ?? 0);
    const want = ((preferred % slots) + slots) % slots;
    // Outward from the wanted slot, alternating sides, so an attacker that
    // cannot have the angle it approached from takes the nearest one it can.
    for (let step = 0; step <= slots; step++) {
      for (const side of step === 0 ? ZERO : SIDES) {
        const index = (((want + side * step) % slots) + slots) % slots;
        if ((blocked & (1 << index)) !== 0) continue;
        this.claimed.set(key, claimed | (1 << index));
        return index;
      }
    }
    return -1;
  }

  private keyFor(targetId: number, slots: number): number {
    return targetId * (MAX_ATTACK_SLOTS + 1) + slots;
  }
}

const ZERO: readonly number[] = [0];
const SIDES: readonly number[] = [1, -1];
