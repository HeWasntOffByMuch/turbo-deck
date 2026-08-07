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
import type { Vec2 } from '../../sim/types.js';
import type { EffectiveStats, Vec3 } from '../state/types.js';

export const EntityKindValue = {
  Player: 0,
  Monster: 1,
  Prop: 2,
  /**
   * A projectile in flight (spec 062). Deliberately an entity rather than a
   * parallel collection: interest management, delta tracking and replication
   * then apply to it unchanged, instead of being reimplemented alongside with
   * their own bugs.
   */
  Projectile: 3,
} as const;

export const ActivityValue = {
  Idle: 0,
  Moving: 1,
  /** Winding up or channelling -- committed, and visibly so. */
  Casting: 2,
  Stunned: 3,
  Dead: 4,
} as const;

/** Where a cast has got to. Drives the client's animation and the cancel rule. */
export const CastPhase = {
  Windup: 0,
  Channel: 1,
  /**
   * Committed, but not yet pointing at what it committed to (spec 065). The
   * cost is spent and the aim is captured; the wind-up clock has not started.
   */
  Turning: 3,
} as const;

/** Why a cast stopped, so the client can play the right thing. */
export const CastEndReason = {
  Released: 0,
  Cancelled: 1,
  /** Knocked out of it. Death only, since spec 068: a hit no longer does this. */
  Interrupted: 2,
} as const;

/**
 * A cast in progress. One at a time per entity: starting another while this is
 * live is refused rather than queued, so "am I committed right now" is a single
 * null check everywhere it is asked.
 */
export interface CastState {
  readonly abilityId: string;
  readonly startedTick: number;
  /** Tick the effect lands. Cancelling before this costs nothing but time. */
  readonly releaseTick: number;
  /**
   * Tick the caster is free again: the release for everything but a channel,
   * whose pulses run past it (spec 068).
   */
  readonly endTick: number;
  readonly phase: number;
  /** Aim captured at commit, so turning mid-cast cannot re-aim a landed blow. */
  readonly targetX: number;
  readonly targetY: number;
  /**
   * The entity this cast was aimed at, or 0 for an aim at a point (spec 070).
   *
   * A melee cast that names one resolves against that entity and nothing else:
   * an attack is single-target, and a bystander who wandered into the arc is a
   * bystander. The point aim is still captured alongside it, because that is
   * what the body turns into and what the client draws.
   */
  readonly targetEntityId: number;
  /** Channels only: the next tick a pulse is due. */
  readonly nextPulseTick: number;
}

/** A projectile's flight, carried so its arc is reproducible on both ends. */
export interface ProjectileState {
  readonly abilityId: string;
  readonly ownerId: number;
  readonly originX: number;
  readonly originY: number;
  /**
   * Where it is headed *now*. Re-aimed every tick at a named target, so a shot
   * follows a body that moved after it was loosed (spec 079); fixed for a shot
   * thrown at a patch of ground.
   */
  readonly targetX: number;
  readonly targetY: number;
  /**
   * The body this shot is chasing, or 0 for one aimed at a point (spec 079).
   *
   * When it dies or leaves the world the shot is *disjointed*: it keeps the aim
   * it last had and flies on to that spot. Nothing was scheduled, so there is
   * nothing to un-schedule -- the travel is the only thing that decides.
   */
  readonly targetEntityId: number;
  /** World units per tick along the ground line. */
  readonly speed: number;
  /**
   * Peak height above the launch-to-target line, committed at the loose
   * (spec 089).
   *
   * Worked out once, from the distance at launch, and never again. A tracking
   * shot still follows its mark sideways, but the arc it left with is the arc
   * it flies -- one that grew because its target ran would be climbing after it
   * had left the bow.
   */
  readonly arcHeight: number;
  /**
   * Height the shot left at. The other end of the chord its arc rides on; the
   * ground *between* the two is never consulted (spec 089).
   */
  readonly originZ: number;
  /**
   * Ground distance this flight will cover: `travelled` plus what is left to
   * run. Re-stamped every tick, because a tracked target moves the finish line;
   * for a shot at a fixed point it never changes. `travelled / totalDistance` is
   * the flight's progress, and what the arc is drawn against.
   */
  readonly totalDistance: number;
  readonly travelled: number;
  readonly expiresAtTick: number;
}

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
  /** Body radius for collision. */
  readonly radius: number;
  /** Homing target for a monster; null when idle or player-controlled. */
  readonly targetId: number | null;
  /**
   * The route this body is following, when the straight line to its target is
   * blocked (spec 065). Plain data on an immutable entity like everything else,
   * so a replay walks the same way round the same tree.
   */
  readonly path: readonly Vec2[] | null;
  /** How many of `path`'s waypoints have been reached. */
  readonly pathIndex: number;
  /** Earliest tick a new search may run, so replanning has a cadence. */
  readonly repathAtTick: number;
  /** Where the target was when `path` was planned, to notice it moving away. */
  readonly pathGoal: Vec2 | null;
  /** Ability resource. Live, clamped to `stats.maxResource` on recalculation. */
  readonly resource: number;
  /** The cast in progress, or null when free (spec 062). */
  readonly cast: CastState | null;
  /**
   * Ability id -> the tick it may next be used. Absent means ready; entries are
   * never pruned mid-fight, which keeps the map a pure function of what has been
   * cast rather than of when it was last swept.
   */
  readonly cooldowns: Readonly<Record<string, number>>;
  /** Set only on a projectile entity; null on everything that walks. */
  readonly projectile: ProjectileState | null;
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
  /**
   * The sequence number {@link claimedPosition} came from, or 0 before the
   * first input (spec 067).
   *
   * The speed check is per *input*, not per tick, and the two stop being the
   * same thing the moment an input is dropped -- from a full queue, or by a
   * client that skipped ticks catching up after a stall. Measuring the gap lets
   * a claim that spans k inputs be allowed k ticks of travel instead of being
   * accused of covering them all in one.
   */
  readonly claimedSeq: number;
  /**
   * The last correction sent to this entity's client, or null (spec 067).
   *
   * A client that has been corrected makes its next claims from *there* -- it
   * snaps to this position and replays every input it had not heard back about
   * yet, so by input N it is legitimately this many ticks past it. The jump
   * between its old claim and its new one is exactly the error the correction
   * existed to remove, and reading that as a speed hack is how one nudge became
   * two snaps. Pardoning it, with the seq so the allowance grows with the
   * replay, is what stops that.
   */
  readonly pardon: { readonly x: number; readonly y: number; readonly seq: number } | null;
  /**
   * The map spawner that produced this body, or null for anything else -- a
   * player, a projectile, a monster an admin conjured (spec 076).
   */
  readonly spawnerId: string | null;
  /**
   * Where this body was spawned, and so the centre of its leash. Null when it
   * has no home to be dragged away from.
   */
  readonly anchor: Vec2 | null;
}

/** One map spawner's live state (spec 076). */
export interface SpawnerState {
  /** The body this spawner put in the world, or null while it is empty. */
  readonly entityId: number | null;
  /**
   * The earliest tick a replacement may appear. Stamped when the last one was
   * removed, so the wait starts at the death rather than at a global cadence;
   * 0, and so immediately, for a spawner that has never been filled.
   */
  readonly readyAtTick: number;
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
  /**
   * Spawner id -> its timer. Sim state, not server bookkeeping: a replay that
   * did not carry it would repopulate the world on a different tick.
   */
  readonly spawners: ReadonlyMap<string, SpawnerState>;
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
  /**
   * False when this frame carries no prediction -- a synthesised input that
   * exists only to deliver an ability request on a tick the client sent no
   * movement. Without it those frames would be read as a client predicting
   * nowhere, and answered with a correction on every cast.
   */
  readonly hasPrediction: boolean;
  /**
   * How many sequence numbers this input covers, normally 1 (spec 067).
   *
   * More than that means inputs between the last applied one and this one never
   * reached the sim, so the claim it carries has had that many ticks to travel.
   * The sim only uses it to size the speed allowance; it never moves the body
   * further for it.
   */
  readonly seqSpan: number;
  /** An ability the client is asking to commit to this tick; '' for none. */
  readonly castAbilityId: string;
  readonly castTargetX: number;
  readonly castTargetY: number;
  /** The entity asked for by id, or 0 to aim at the point alone (spec 070). */
  readonly castTargetEntityId: number;
  /** Withdraw from whatever is winding up. Honoured before any new commit. */
  readonly cancelCast: boolean;
}

export type ServerSimEvent =
  | {
      readonly kind: 'hit';
      readonly attackerId: number;
      readonly targetId: number;
      readonly damage: number;
      readonly targetHealth: number;
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
  | {
      readonly kind: 'castStarted';
      readonly entityId: number;
      readonly abilityId: string;
      readonly phase: number;
      readonly releaseTick: number;
      readonly endTick: number;
      readonly targetX: number;
      readonly targetY: number;
      readonly targetEntityId: number;
    }
  | {
      readonly kind: 'castEnded';
      readonly entityId: number;
      readonly abilityId: string;
      readonly reason: number;
    }
  | {
      readonly kind: 'castRejected';
      readonly entityId: number;
      readonly abilityId: string;
      readonly reason: string;
    }
  | {
      /** A point cue for the client to draw: an impact, a blast, a heal. */
      readonly kind: 'effect';
      readonly effectId: string;
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly radius: number;
      readonly durationTicks: number;
    }
  | { readonly kind: 'spawned'; readonly entityId: number; readonly typeId: string }
  | { readonly kind: 'despawned'; readonly entityId: number }
  | { readonly kind: 'died'; readonly entityId: number; readonly killerId: number | null };

export interface StepResult {
  readonly state: ServerWorldState;
  readonly events: readonly ServerSimEvent[];
}
