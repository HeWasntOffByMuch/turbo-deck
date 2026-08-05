/**
 * The authoritative world state (spec 056).
 *
 * Shaped like `src/sim/types.ts` on purpose -- readonly records, a `tick`, and
 * an embedded {@link Rng} -- so the same determinism property holds: given a
 * seed and a sequence of input frames, `step` produces bit-identical state
 * every run. It is a *separate* state from `CombatState` because that one has
 * exactly one player and this one has as many as connect.
 */

import type { Rng } from '../../shared/prng.js';
import type { EffectiveStats, Vec3 } from '../state/types.js';

export const EntityKindValue = {
  Player: 0,
  Monster: 1,
  Prop: 2,
} as const;

export const ActivityValue = {
  Idle: 0,
  Moving: 1,
  Attacking: 2,
  Stunned: 3,
  Dead: 4,
} as const;

export interface ServerEntity {
  readonly id: number;
  readonly kind: number;
  /** Content id: a monster type, or the player's chosen critter. */
  readonly typeId: string;
  /** Set for player entities, null for everything the server spawned itself. */
  readonly ownerPlayerId: string | null;
  readonly position: Vec3;
  readonly facing: number;
  readonly health: number;
  readonly level: number;
  readonly zoneId: string;
  /**
   * Derived, never persisted: for a player this is recomputed on login and on
   * every equip/skill change, for a monster it comes from its type row.
   */
  readonly stats: EffectiveStats;
  readonly activity: number;
  readonly activityUntilTick: number;
  /** Earliest tick this entity may attack again. */
  readonly attackReadyTick: number;
  /** Residual knockback velocity, in world units per tick. */
  readonly knockbackX: number;
  readonly knockbackY: number;
  readonly knockbackUntilTick: number;
  /** Frozen on impact; inputs are ignored until this tick. */
  readonly hitstopUntilTick: number;
  /** Body radius for collision. */
  readonly radius: number;
  /** Homing target for a monster; null when idle or player-controlled. */
  readonly targetId: number | null;
  /**
   * The position this entity's client last claimed to have predicted, or null
   * before its first input (spec 057).
   *
   * The speed check is made against *this*, not against the entity's
   * authoritative position. A client legitimately runs ahead of the server by
   * roughly the one-way latency, so measuring "how far is your guess from where
   * I last put you" flags every honest player on a real connection. Measuring
   * how far the claim moved between consecutive inputs asks the question that
   * actually matters -- what speed are you claiming to travel at -- and is
   * immune to a constant lead.
   */
  readonly claimedPosition: { readonly x: number; readonly y: number } | null;
}

export interface ServerWorldState {
  readonly tick: number;
  /**
   * Insertion-ordered, which makes iteration deterministic -- every traversal
   * of the world happens in the order entities were created, on every run.
   */
  readonly entities: ReadonlyMap<number, ServerEntity>;
  readonly nextEntityId: number;
  readonly rng: Rng;
}

/**
 * One client's intent for one tick. Note the absence of any authoritative
 * field: a client says which way it wants to go and what it pressed, plus --
 * as a hint only -- where its own prediction landed, which the server measures
 * divergence against and never adopts.
 */
export interface ServerInput {
  readonly entityId: number;
  readonly seq: number;
  readonly moveX: number;
  readonly moveY: number;
  readonly facing: number;
  readonly buttons: number;
  readonly predictedX: number;
  readonly predictedY: number;
}

export type ServerSimEvent =
  | {
      readonly kind: 'hit';
      readonly attackerId: number;
      readonly targetId: number;
      readonly damage: number;
      readonly targetHealth: number;
      readonly hitstopTicks: number;
      readonly knockbackX: number;
      readonly knockbackY: number;
      readonly knockbackTicks: number;
      readonly killed: boolean;
      readonly critical: boolean;
      readonly blocked: boolean;
    }
  | {
      readonly kind: 'correction';
      readonly entityId: number;
      readonly inputSeq: number;
      readonly position: Vec3;
      readonly facing: number;
      readonly reason: number;
    }
  | { readonly kind: 'attackMissed'; readonly attackerId: number }
  | { readonly kind: 'spawned'; readonly entityId: number; readonly typeId: string }
  | { readonly kind: 'despawned'; readonly entityId: number }
  | { readonly kind: 'died'; readonly entityId: number; readonly killerId: number | null };

export interface StepResult {
  readonly state: ServerWorldState;
  readonly events: readonly ServerSimEvent[];
}
