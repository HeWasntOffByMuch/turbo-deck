/**
 * A drop, and how far its presentation has got (spec 156).
 *
 * The idea this file exists to hold is that **the item is decided at once and
 * its presentation unfolds afterwards**. `defId` is written on the tick the body
 * is swept and is never written again; the three ticks beside it are a clock the
 * client draws against. There is no deferred roll here and there must never be
 * one: a rarity settled seconds after the drop is a thing a player could wait
 * out, log out of, or race, and every one of those is an exploit wearing a
 * presentation costume.
 *
 * The reveal is therefore *derived*, not stored: {@link revealPhaseAt} is a pure
 * function of the drop and a tick. Nothing marks itself revealed, so nothing can
 * be revealed twice, and a client, a test and the server all answer the question
 * the same way from the same two numbers.
 *
 * Pure and part of the deterministic core: no clock, no DOM, no randomness of
 * its own.
 */

import type { Rng } from '../../shared/prng.js';
import { MAX_REVEAL_SCALE } from '../config.js';
import type { RarityId } from '../data/items.js';
import { DROP_LIFETIME_TICKS, rarityRow } from '../data/loot.js';
import type { Vec3 } from '../state/types.js';

/**
 * How far a drop's presentation has got.
 *
 * `Spawned` is the object landing; `Anticipation` is the window where something
 * is visibly happening and the item is still unnamed; `Revealed` is the identity
 * being available. A common drop is `Revealed` on the tick it lands and never
 * occupies either of the other two, which is what keeps ordinary loot ordinary.
 */
export const RevealPhase = {
  Spawned: 0,
  Anticipation: 1,
  Revealed: 2,
} as const;

export type RevealPhaseValue = (typeof RevealPhase)[keyof typeof RevealPhase];

export interface DropState {
  /**
   * The item, decided on the tick this landed and **never changed after**.
   *
   * Withheld from the wire until the reveal (see `net/messages.ts`), which is
   * information hiding rather than indecision: the server has known since the
   * body fell.
   */
  readonly defId: string;
  readonly count: number;
  /** Read off the item's row, so it cannot disagree with what the item is. */
  readonly rarity: RarityId;
  /**
   * Whose kill this was, or null for a drop nobody owns -- an admin's, today.
   *
   * A player id rather than an entity id, so a drop survives its owner
   * disconnecting and coming back onto a new body (spec 150).
   */
  readonly ownerPlayerId: string | null;
  /**
   * Where the body was standing when it fell -- the point the item was thrown
   * *from* (spec 156).
   *
   * The entity's own position is where it lands, so this is the other end of an
   * arc the client draws and nothing simulates. It is authoritative for one
   * reason: **every player has to see the same throw.** A scatter picked
   * client-side would put the same sword in five different places on five
   * screens, and "did you see where it went" is a question two people standing
   * next to each other must be able to answer the same way.
   */
  readonly origin: Vec3;
  readonly spawnTick: number;
  /** When the anticipation cue fires. Equal to `spawnTick` when there is none. */
  readonly anticipationTick: number;
  /** When the identity is told. Equal to `spawnTick` for a common drop. */
  readonly revealTick: number;
  /** When the world takes it back. */
  readonly expiresTick: number;
}

/**
 * A drop, with its clock stamped.
 *
 * The timings are **snapshotted here** rather than recomputed per tick, for the
 * reason spec 144 snapshots attack timing: a knob turned mid-reveal must not
 * move a reveal that is already running. Turning `lootRevealScale` up affects
 * the next drop, never the one already lying in the grass.
 */
export function makeDrop(
  defId: string,
  count: number,
  rarity: RarityId,
  ownerPlayerId: string | null,
  origin: Vec3,
  tick: number,
  revealScale: number,
): DropState {
  const row = rarityRow(rarity);
  const scale = Math.max(0, Math.min(MAX_REVEAL_SCALE, revealScale));
  const reveal = Math.round(row.revealTicks * scale);
  // Clamped under the reveal rather than scaled independently: the anticipation
  // is the run-up *to* the reveal, and a lead that overshot it would fire a cue
  // for a window that had already closed.
  const anticipation = Math.min(reveal, Math.round(row.anticipationTicks * scale));
  return {
    defId,
    count,
    rarity,
    ownerPlayerId,
    origin,
    spawnTick: tick,
    anticipationTick: tick + anticipation,
    revealTick: tick + reveal,
    expiresTick: tick + DROP_LIFETIME_TICKS,
  };
}

/**
 * How far from the body a drop can land, in world units (spec 156).
 *
 * Far enough that two drops from the same fight are two objects rather than one
 * pile, near enough that the thing is obviously *that* kill's. The floor is not
 * zero because a drop directly under the corpse reads as having been placed
 * rather than dropped, which is the whole thing this is here to avoid.
 */
export const SCATTER_MIN = 14;
export const SCATTER_MAX = 34;

/**
 * Where a drop lands, given where the body fell.
 *
 * **Server-side and seeded**, and that is the point rather than an
 * implementation detail: the landing spot is the drop entity's replicated
 * position, so every client is looking at the same object in the same place and
 * the throw they each draw ends where the others' do. A client-side scatter
 * would be five different worlds agreeing about nothing.
 *
 * Height is left to the caller, which has the terrain: this is the ground plane
 * only. Nothing checks the landing against a collider -- a drop is inert and
 * blocks nobody, so the worst case is an item resting against a rock, and the
 * cost of a walkability search per kill is not worth avoiding that.
 */
export function scatterLanding(rng: Rng, from: Vec3): [{ x: number; y: number }, Rng] {
  // Two integer draws rather than a float one, so this reproduces exactly
  // across engines like every other roll in the sim.
  const [degrees, afterAngle] = rng.nextInt(0, 359);
  const [reach, afterReach] = afterAngle.nextInt(SCATTER_MIN, SCATTER_MAX);
  const angle = (degrees * Math.PI) / 180;
  return [{ x: from.x + Math.cos(angle) * reach, y: from.y + Math.sin(angle) * reach }, afterReach];
}

/**
 * The two ticks the phase is read off: everything {@link revealPhaseAt} needs.
 *
 * Structural rather than {@link DropState} so that the client can ask the same
 * question of what it was *sent*, which is a rarity and two ticks and no item.
 * One implementation of "how far has this got" for both ends is the point --
 * a second one on the client is a second opinion waiting to disagree.
 */
export interface RevealClock {
  readonly anticipationTick: number;
  readonly revealTick: number;
}

/**
 * Where the anticipation cue falls, recovered from what the wire carries.
 *
 * The server stamps three ticks and sends two, because the third is derivable:
 * both were scaled by the same `lootRevealScale`, so the span that arrived says
 * what that scale was and the row says what fraction of it the run-up is. Not
 * sent, because a number a client can compute exactly is a number that can go
 * out of step with the one it was computed from.
 */
export function anticipationTickFor(
  rarity: RarityId,
  spawnTick: number,
  revealTick: number,
): number {
  const row = rarityRow(rarity);
  const span = Math.max(0, revealTick - spawnTick);
  if (row.revealTicks <= 0 || span === 0) return spawnTick;
  const scale = span / row.revealTicks;
  return spawnTick + Math.min(span, Math.round(row.anticipationTicks * scale));
}

/**
 * How far the presentation has got at `tick`.
 *
 * Monotone in `tick` by construction -- it is two comparisons against fixed
 * numbers, so it cannot go backwards and cannot be advanced by being asked.
 */
export function revealPhaseAt(drop: RevealClock, tick: number): RevealPhaseValue {
  if (tick >= drop.revealTick) return RevealPhase.Revealed;
  if (tick >= drop.anticipationTick) return RevealPhase.Anticipation;
  return RevealPhase.Spawned;
}

/** Whether the identity may be told to a client at `tick`. */
export function isRevealed(drop: Pick<RevealClock, 'revealTick'>, tick: number): boolean {
  return tick >= drop.revealTick;
}

/**
 * True on the one tick a drop crosses into `Revealed`.
 *
 * An equality rather than a `>=`, because this is what makes the server send
 * exactly one reveal message: the sim visits every drop on every tick, so the
 * crossing happens once and the frame that carries it is the frame it happened
 * on. A drop that spawns already revealed crosses on its spawn tick and is
 * covered by the first-sight message instead, which is why the caller checks
 * `revealTick > spawnTick` before believing this.
 */
export function revealsOn(drop: DropState, tick: number): boolean {
  return tick === drop.revealTick && drop.revealTick > drop.spawnTick;
}
