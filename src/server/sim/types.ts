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
import type { AttackTiming } from './attack-timing.js';
import type { DropState } from './loot.js';
import type { Statuses } from './statuses.js';

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
  /**
   * An item lying on the ground (spec 154). An entity for the reason a
   * projectile is one: interest management, delta tracking, despawn and the
   * reconnect path then apply to it unchanged instead of being reimplemented
   * beside it with their own bugs.
   *
   * Inert in every pass -- it does not walk, cannot be targeted, is not hostile
   * to anything and is not hit by shots. The only thing that happens to it is
   * being picked up or expiring.
   */
  Drop: 4,
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
   * The follow-through after the blow has landed (spec 144).
   *
   * The body is rooted and may walk out of it, and walking out costs nothing --
   * the attack has already happened and its interval is already running. This is
   * the phase where {@link CastState.committed} is true, which is the whole
   * distinction the spec exists to draw.
   */
  Backswing: 2,
  /**
   * Committed, but not yet pointing at what it committed to (spec 065). The
   * cost is spent and the aim is captured; the wind-up clock has not started.
   */
  Turning: 3,
} as const;

/** Why a cast stopped, so the client can play the right thing. */
export const CastEndReason = {
  Released: 0,
  /**
   * Withdrawn from before the attack point. **The attack did not happen**: no
   * blow, no projectile, cost refunded, no interval started.
   */
  Cancelled: 1,
  /** Knocked out of it. Death only, since spec 068: a hit no longer does this. */
  Interrupted: 2,
  /**
   * Walked out of the follow-through (spec 144). **The attack already happened**
   * and only the remaining animation was skipped -- nothing is refunded and the
   * interval runs on untouched.
   *
   * A reason of its own rather than a second `Cancelled`, because the client
   * hands back its predicted cooldown on anything that is not `Released` and
   * this is the one cancellation that must keep it.
   */
  BackswingCancelled: 3,
} as const;

/**
 * A cast in progress. One at a time per entity: starting another while this is
 * live is refused rather than queued, so "am I committed right now" is a single
 * null check everywhere it is asked.
 */
export interface CastState {
  readonly abilityId: string;
  /**
   * What this cast actually cost, captured at the commit (spec 147).
   *
   * Stored rather than re-read from the ability row, because the cost is now a
   * function of the caster -- Wisdom's scale, Attuned, Flow, Intelligence's
   * shaping premium -- and a withdrawal has to hand back *what was paid*. Reading
   * the row would refund the list price, which is a resource generator for
   * anybody with cost reduction and a cancel key.
   */
  readonly spentResource: number;
  /** Health an Arcane Overflow paid on top. Refunded by a withdrawal too. */
  readonly spentHealth: number;
  /** Tick the request was committed to, turn included. */
  readonly startedTick: number;
  /**
   * Tick the wind-up clock started, which is the tick the *attack* started
   * (spec 144).
   *
   * Not the same as {@link startedTick} whenever the body had to turn first
   * (spec 065): the cost is spent at the commit but the swing has not begun, so
   * the attack interval is measured from here. Re-stamped by `advanceCast` when
   * the turn completes, and equal to `startedTick` when there was no turn.
   */
  readonly windupStartTick: number;
  /** Tick the effect lands. Cancelling before this costs nothing but time. */
  readonly releaseTick: number;
  /**
   * Tick the caster is free again: the release plus the backswing for a basic
   * attack (spec 144), the release itself for everything else (spec 068), and
   * the end of the pulses for a channel.
   */
  readonly endTick: number;
  readonly phase: number;
  /**
   * False until the attack point, true from it on (spec 144).
   *
   * The boundary the whole cancellation model turns on, stored rather than
   * inferred from `tick >= releaseTick` because the two are not the same
   * question: a cast that was withdrawn from a tick before its release is
   * uncommitted forever, and a caller holding it a tick later would read the
   * comparison and conclude the blow had landed.
   */
  readonly committed: boolean;
  /**
   * The timing this attack runs on, worked out once at the start and never
   * again (spec 144).
   *
   * Snapshotted so that a buff landing mid-swing affects the *next* attack
   * rather than jumping this one forward or backward. Recomputing per tick would
   * mean a haste buff at 90% of a wind-up could put the release in the past, and
   * a slow could push it away faster than the clock approaches it.
   */
  readonly timing: AttackTiming;
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
   * Set only on a drop entity; null on everything else (spec 154).
   *
   * The item's identity lives *here* rather than in {@link typeId}, which a drop
   * leaves empty. That is the whole information-hiding argument: `typeId` rides
   * the entity delta and is therefore told to every client that can see the
   * body, and what an unrevealed drop is must not be.
   */
  readonly drop: DropState | null;
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

  // --- progression state (spec 147) --------------------------------------
  /**
   * Guard left before this body is staggered. Live, like health: clamped to
   * `stats.traits.maxPoise` on recalculation and refilled whole by a break.
   */
  readonly poise: number;
  /**
   * Earliest tick this body may be broken again. The window that stops two
   * attackers holding a third permanently -- see `sim/poise.ts`.
   */
  readonly staggerImmuneUntilTick: number;
  /** Absorbed before health, and never above `stats.traits.maxShield`. */
  readonly shield: number;
  /** The tick the whole shield falls off. Shields expire, they do not decay. */
  readonly shieldUntilTick: number;
  /** Every timed state this body is carrying. See `sim/statuses.ts`. */
  readonly statuses: Statuses;
  /**
   * The last tick this body moved, cast or was hit.
   *
   * A tick rather than a boolean because what Intelligence's Prepared Casting
   * asks is "how long", and a boolean would need a counter beside it that meant
   * the same thing worse. Stamped forward by any of the three, so `tick - this`
   * is the length of the current lull.
   */
  readonly stillSinceTick: number;
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
      /**
       * The blow found a weak point (spec 147). Distinct from `critical`: a crit
       * is a bigger number, a weak point is a bigger number *and* an opening
       * left behind that anybody can use.
       */
      readonly weakPoint: boolean;
    }
  | {
      /**
       * A body's guard broke (spec 147). It is rooted for `ticks` and whatever
       * it was casting is gone.
       *
       * Its own event rather than a flag on `hit`, because the two do not always
       * arrive together: an ability with `abilityPoiseFactor` can break a body it
       * did no damage to, and a break with no blow behind it still has to be
       * drawn.
       */
      readonly kind: 'poiseBroken';
      readonly entityId: number;
      readonly breakerId: number;
      readonly ticks: number;
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
      /**
       * A cast entered a phase: the commit itself, the turn completing, the
       * attack point being reached (`phase: Backswing`), or a channel opening.
       *
       * One event for all of them, because the client's job is the same in
       * every case -- redraw the bar against the new clock. Read as combat
       * hooks: `phase: Windup` after `Turning` is *attack started*, and
       * `phase: Backswing` is *attack committed* (spec 144).
       */
      readonly kind: 'castStarted';
      readonly entityId: number;
      readonly abilityId: string;
      readonly phase: number;
      /** The tick the wind-up began, so a scaled bar has an origin (spec 144). */
      readonly startTick: number;
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
  | {
      /**
       * A drop crossed its reveal tick (spec 154).
       *
       * Its own event rather than the server re-deriving the crossing per
       * connection, for the reason `poiseBroken` is one: the sim owns the clock,
       * so the tick a reveal happens on is a fact about the world rather than
       * something each observer works out for itself and gets slightly
       * differently. The server turns it into one `LootDrop` per interested
       * connection; a client that was not there hears the identity on first
       * sight instead.
       *
       * Emitted exactly once per drop, and never for one that spawned already
       * revealed -- there is nothing to announce when the first message a client
       * gets already carries the answer.
       */
      readonly kind: 'lootRevealed';
      readonly entityId: number;
    }
  | { readonly kind: 'died'; readonly entityId: number; readonly killerId: number | null };

export interface StepResult {
  readonly state: ServerWorldState;
  readonly events: readonly ServerSimEvent[];
}
