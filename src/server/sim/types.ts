/**
 * The authoritative world state (spec 056).
 *
 * Shaped like `src/sim/types.ts` on purpose -- readonly records, a `tick`, and
 * an embedded {@link Rng} -- so the same determinism property holds: given a
 * seed and a sequence of input frames, `step` produces bit-identical state
 * every run. It is a *separate* state from `CombatState` because that one has
 * exactly one player and this one has as many as connect.
 */

import type { DamageElement } from '../data/abilities.js';
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
   * A restorative mote lying on the ground (spec 156).
   *
   * An entity for the reason a projectile is one: interest management, delta
   * tracking, replication and removal all apply to it unchanged instead of
   * being reimplemented alongside with their own bugs. It neither walks, fights,
   * blocks nor can be hit -- {@link isHostile} refuses it at both ends and the
   * movement pass skips it -- so what it costs the rest of the sim is two
   * `continue`s and a pass of its own.
   */
  Mote: 4,
  /**
   * An item lying on the ground (spec 158). The same argument the mote above
   * makes, and it arrived by the same road: interest management, delta tracking,
   * despawn and the reconnect path all apply to it unchanged instead of being
   * reimplemented beside it with their own bugs.
   *
   * Inert in every pass -- it does not walk, cannot be targeted, is not hostile
   * to anything and is not hit by shots. The only thing that happens to it is
   * being picked up or expiring.
   */
  Drop: 5,
} as const;

export const ActivityValue = {
  Idle: 0,
  Moving: 1,
  /** Winding up or channelling -- committed, and visibly so. */
  Casting: 2,
  Stunned: 3,
  Dead: 4,
  /**
   * Changing an active skill (spec 188).
   *
   * A body state rather than a hidden timer on the connection, and that is the
   * whole of what "commitment, not just time" means here. It is replicated by
   * the field `activity` already rides, so every client draws the same body
   * doing the same thing -- and it is a *claim on the body*, so anything that
   * takes the body takes the swap with it: walking off, being staggered,
   * committing to a cast, dying. The server watches for the claim going away
   * and gives the swap up when it does, which is one comparison rather than
   * four cancellation paths.
   *
   * `activityUntilTick` is when the change lands, so the bar over the head and
   * the sweep in the interface are the same clock with no second field.
   */
  Swapping: 5,
} as const;

/**
 * What a body has decided about its target (spec 163).
 *
 * Deliberately *beside* {@link ActivityValue} rather than folded into it.
 * `activity` is what a body is doing and this is what it has decided, and the
 * whole point of the alert phase is that those two come apart: a monster holding
 * still because it is sizing you up and a monster holding still because it has
 * nothing to do are the same `Idle`, and they are not the same thing.
 *
 * `targetId === null` is `Calm` or `Returning` and nothing else, and every
 * transition in `sim/aggro.ts` keeps it that way.
 */
export const AggroValue = {
  /** No business with anybody. */
  Calm: 0,
  /** Has noticed somebody and is looking at them. Does not move, does not swing. */
  Alert: 1,
  /** Chasing and swinging. */
  Engaged: 2,
  /** Running from whatever hit it, and swinging at nothing. */
  Fleeing: 3,
  /**
   * Walking back to its anchor, and it will not be talked out of it (spec 248).
   *
   * Also `targetId === null`, and so distinguishable from `Calm` only by what
   * it refuses -- which is the whole reason it is a state rather than the
   * absence of one. A calm body notices, is rallied and can be hit; this one
   * does none of the three until it is home. Two of those are free, because
   * `notice` and `rally` already require `Calm`.
   */
  Returning: 4,
} as const;

export type AggroStateValue = (typeof AggroValue)[keyof typeof AggroValue];

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
  /**
   * Fallback flask charges this cast took (spec 156).
   *
   * Beside `spentResource` and for the same reason: a withdrawal has to hand
   * back *what was paid*, and a charge is the flask's whole cost. Spending it at
   * the commit is what stops the flask being feint-able -- the alternative,
   * charging at the release, makes starting one free and cancelling it strictly
   * better than not starting it.
   */
  readonly spentCharges: number;
  /**
   * Guard this cast paid at the commit (spec 188).
   *
   * Beside `spentResource` and `spentCharges` for the reason they are beside
   * each other: a withdrawal has to hand back **what was paid**, whatever it was
   * priced in, or the price of a wind-up somebody stepped out of stops being
   * "the time it took". Health has no field of its own because `spentHealth`
   * already existed for Arcane Overflow and a skill's blood price adds to it --
   * one number to refund rather than two that have to agree.
   */
  readonly spentPoise: number;
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
  /**
   * Was the named target within `range + radius` when the wind-up *began*
   * (spec 221)?
   *
   * The whole of "a swing that was in range lands". `landOnTarget` reads this
   * instead of measuring the distance again at the release, so a target that
   * walked out of reach during a wind-up nobody withdrew from is still hit.
   *
   * Stamped by `advanceCast` at the two places `phase` becomes
   * {@link CastPhase.Windup} and nowhere else -- on the commit tick itself for
   * a cast that needs no turn, and at alignment for one that does. At the
   * wind-up rather than at the commit because a body turns first (spec 065)
   * and the turn is not the swing: `windupStartTick` is re-stamped there for
   * exactly this reason and the reach belongs beside it.
   *
   * `startCast` leaves it false rather than working it out, though it could:
   * what is to hand there is the position the *client* claimed, and with the
   * release no longer measuring anything that would be a reach a client could
   * assert. `advanceCast` is handed the server's own view, rewound to what the
   * attacker was looking at (spec 149).
   *
   * False for a cast that names no target, where it means nothing: an
   * untargeted cone is measured by its own geometry at the release and always
   * has been.
   */
  readonly targetInReach: boolean;
  /** Channels only: the next tick a pulse is due. */
  readonly nextPulseTick: number;
}

/**
 * A restorative mote's state (spec 156). Set only on a mote entity, null on
 * everything else -- the same shape {@link ProjectileState} has, for the same
 * reason: a payload that belongs to one kind of body has no business being
 * seven nullable fields on every body.
 */
export interface MoteState {
  /** `MoteKind`: what it restores. See `sim/restoration.ts`. */
  readonly kind: number;
  /** How much, before `applyHealing` scales it. Fixed at generation. */
  readonly amount: number;
  /**
   * The only body that may see or take this, and never 0.
   *
   * Ownership by *entity* rather than by player id, so the whole rule stays
   * inside the sim: nothing in here has ever needed to know what a player id is,
   * and a pickup check that had to would be the first.
   */
  readonly ownerEntityId: number;
  /**
   * The hop, as two points and a clock (spec 156).
   *
   * A mote bursts out of the body and lands a short way off before it may be
   * taken. That is not decoration: without it a mote spawns inside its owner's
   * attract radius and is collected on the first tick it is legally allowed to
   * be, which measured at **0.30 seconds on screen** -- six frames at the 20Hz
   * broadcast rate, and the whole of that was the arm delay. A drop nobody can
   * see is a drop nobody believes in.
   *
   * Carried as an origin and a rest point rather than as a velocity, so the
   * position during the hop is a pure function of the tick: no integration, no
   * accumulated error, and a replay lands it on the same blade of grass.
   */
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly restX: number;
  readonly restY: number;
  /**
   * The two ends of the hop, stored rather than derived from the config.
   *
   * Self-describing on purpose: reading a tuning constant to interpret stored
   * state means a mote in flight when somebody retunes the constant is a mote
   * whose arc changes under it.
   */
  readonly launchFromTick: number;
  readonly landsAtTick: number;
  /**
   * First tick it may be attracted or collected -- landing plus a beat.
   *
   * The beat is a **floor on how long a drop is on screen**, and it is the half
   * of the visibility fix the hop alone could not give. A mote that happens to
   * land inside its owner's pickup radius has no travel left to do, so without
   * this it is taken on the tick it touches down and the geometry decides
   * whether the player ever saw it.
   */
  readonly armedAtTick: number;
  /** First tick it is gone. Expiry is a comparison, like a status. */
  readonly expiresAtTick: number;
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

/**
 * The bottom of a returning body's ramp home (spec 248).
 *
 * `distance` is to the **anchor**, not to the point the walk ends at: the
 * arrival radius is a function of the body's idle plan, which `sim/idle.ts`
 * already reads and this file has no business knowing. So the span is closed
 * there, where the two numbers meet.
 */
export interface ReturnStart {
  /** How far from its anchor the body was when it gave up. */
  readonly distance: number;
  /** And what health it gave up on -- the value the ramp starts from. */
  readonly health: number;
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
  /**
   * How fast this body actually travelled last tick, world units per second
   * (spec 187).
   *
   * The *actual* velocity, measured from where the body ended up, not the one
   * it asked for -- a body that walked into a tree has a velocity of nearly
   * zero however hard it was pushing, and the crowd around it has to believe
   * the tree rather than the intent. Reciprocal avoidance is built on each body
   * assuming its neighbours will keep doing what they are doing, so this is the
   * one fact it needs about a neighbour that the position alone cannot give.
   *
   * Not replicated: nothing on the client predicts a body other than its own
   * player, and the drawn motion of everything else is interpolated between two
   * replicated positions, which already carries the velocity implicitly.
   */
  readonly velocity: Vec2;
  /** Homing target for a monster; null when idle or player-controlled. */
  readonly targetId: number | null;
  /**
   * What this body has decided about {@link targetId} -- an {@link AggroValue}
   * (spec 163). `Calm` exactly when `targetId` is null.
   */
  readonly aggro: number;
  /**
   * When {@link aggro} runs out: an `Alert` becoming `Engaged`, or a `Fleeing`
   * becoming `Calm`. 0 for the two states that end on an event rather than on a
   * clock, which is what makes it a comparison and never a sweep.
   */
  readonly aggroUntilTick: number;
  /**
   * Where a startled body bolted toward, and null for anything that is not
   * `Fleeing` (spec 213).
   *
   * A flight has to *commit* to somewhere, and this is the whole of why. The
   * heading used to be re-derived from the attacker's current position on every
   * tick, which is stable only while the attacker is slower than its quarry --
   * and no player is. A pursuer at 155 against a grazer's 40 overshoots through
   * the body every frame, the away vector flips sign at 60Hz, and the one
   * temperament whose entire behaviour is leaving oscillates between two
   * coordinates two thirds of a unit apart.
   *
   * Written by `provoke`, which is the one moment the attacker's position is the
   * right one to measure from, and cleared by `calm` and `engage`. Read only by
   * `fleeFrom`, which runs at it and does not second-guess it: the flight is
   * re-aimed when the goal is reached or when a fresh blow lands, and on nothing
   * else. "Hit it again and it bolts anew" is a rule a player reads off the
   * screen; a heading re-derived every 16ms is not.
   */
  readonly fleeGoal: Vec2 | null;
  /**
   * Where this body's walk home began, and null for anything that is not
   * `Returning` (spec 248).
   *
   * The pair {@link fleeGoal} makes with `Fleeing`: a state in the aggro
   * machine, plus the one number that state needs and no other does. Both ends
   * of a ramp, because "regenerate to full along the route" is a line between
   * two points and neither of them can be re-derived later -- the distance is
   * gone the moment the body takes a step, and the health is gone the moment it
   * takes any of it back.
   *
   * Written by `goHome`, which is idempotent for exactly this reason: a span
   * re-snapshotted every tick is a ramp that restarts from where it has got to,
   * which is a body that never heals at all. Cleared by `arriveHome`, and by
   * `calm` and `engage` alongside `fleeGoal` -- a stale span left on a body that
   * turned round would be picked up by its next walk home instead of being
   * measured from the leash break that started it.
   */
  readonly returnStart: ReturnStart | null;
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
   * Where a drop this body has asked for is aimed, or null (spec 172).
   *
   * Putting something down is an action that needs facing rather than a skill:
   * no cost, no cooldown, no wind-up and nothing rooted, so it is this one field
   * rather than a {@link CastState}. What it does is exactly what
   * `CastPhase.Turning` does -- it holds the action until the body is pointing
   * at what it was aimed at -- and `resolveFacing` reads it directly under the
   * cast, so the turn runs at the body's own rate and is the same turn every
   * other player watches.
   *
   * The item itself is *not* here: what a drop takes out of a bag lives behind
   * an async store the sim cannot reach, so the server holds the request and
   * this is the half the sim needs to turn the body.
   */
  readonly dropAim: Vec2 | null;
  /** Set only on a mote entity; null on everything else (spec 156). */
  readonly mote: MoteState | null;
  /**
   * Set only on a drop entity; null on everything else (spec 158).
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
  /**
   * How far from that anchor this body may be dragged before it gives up
   * (spec 222).
   *
   * A number rather than a nullable, because `anchor` already answers "is this
   * body leashed at all" and two fields that can each say no is one more state
   * than the question has. Written at spawn from the marker's own
   * `leashRadius`, capped at `LEASH_RADIUS`, and left at that default for every
   * body that has no spawner behind it -- where it is a number nothing reads,
   * since `beyondLeash` gives up on a null anchor first.
   */
  readonly leashRadius: number;
  /**
   * The player this body is talking to, or null (spec 246).
   *
   * A claim on the body, in the register `activity` already has for a swap: it
   * is what makes a conversation cost something visible rather than being a
   * window one client opened. `monsterIntent` reads it before it reads
   * anything else, so a body holding one stands still and faces -- and every
   * other client watches it stop, because a position and a facing are already
   * replicated. What is *said* is not: that is a table both ends have.
   *
   * An entity id rather than a boolean, because "is somebody talking to it"
   * and "is it you" are two questions and only the second can refuse a second
   * player. Released by `releaseConversation` on every path that can end one,
   * including the ones nobody asked for -- walking away, dying, despawning,
   * disconnecting.
   */
  readonly conversationWith: number | null;

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

  // --- the health economy (spec 156) --------------------------------------
  /**
   * Progress toward the next restorative mote.
   *
   * Live sim state, and the one number the whole kill-sustain economy turns on.
   * Not replicated in absolute terms and not persisted: the client is told a
   * fraction because that is all a bar asks, and a save that carried it would
   * make logging out at 99 a way to bank a mote.
   *
   * There is no client message that reaches this. The only thing that moves it
   * is a kill the server resolved, or Wisdom salvaging an overheal.
   */
  readonly restoration: number;
  /**
   * Fallback flask charges left. Live, clamped to `stats.traits.fallbackCharges`
   * on recalculation, exactly like health and poise.
   */
  readonly fallbackCharges: number;
  /** How far through the current charge a rest is. Ticks, and only in a rest zone. */
  readonly restingTicks: number;
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

/**
 * What was good about a killing blow (spec 156).
 *
 * Five facts, and every one of them is something `resolveBlow` already worked
 * out for its own reasons -- which is what "already detectable server-side" has
 * to mean if the health economy's skill hooks are not to become a second combat
 * system running beside the first.
 *
 * Here rather than in `sim/restoration.ts` because it rides the `died` event,
 * and an event's payload belongs with the events.
 */
export interface KillQualities {
  /** The killing blow found a weak point. Perception's route. */
  readonly weakPoint: boolean;
  /** It did far more damage than was left to do. Strength's. */
  readonly overkill: boolean;
  /** The body was staggered when it died. Strength's, again. */
  readonly execution: boolean;
  /** The killer had not been hit in the last half second. Agility's. */
  readonly untouched: boolean;
  /** It was an ability rather than the weapon. Intelligence's. */
  readonly abilityKill: boolean;
}

export const NO_QUALITIES: KillQualities = {
  weakPoint: false,
  overkill: false,
  execution: false,
  untouched: false,
  abilityKill: false,
};

/** What one {@link ServerSimEvent} cooldown refund took off one ability. */
export interface CooldownRefund {
  readonly abilityId: string;
  /** Ticks actually removed -- what the clamp allowed, not what was offered. */
  readonly ticks: number;
}

/** Who paid for a cooldown refund. One producer today (spec 252). */
export const COOLDOWN_REFUND_MOBILE_OFFENSE = 'mobileOffense';

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
      /**
       * What the blow was made of, for the picture only (spec 232).
       *
       * Optional, and absent is `physical` -- which is what every blow in this
       * game was drawn as before this existed, and what the two heal sites that
       * raise a `hit` with negative damage correctly leave it as. Nothing in the
       * sim reads it: it is carried here so that `world.ts` can put it on the
       * wire, because a `CombatResult` names no ability and the client therefore
       * cannot work it out.
       */
      readonly element?: DamageElement;
      /**
       * This damage arrived from an affliction rather than from a blow
       * (spec 190).
       *
       * What it exists for is `rally`, which is driven off this tick's `hit`
       * events and whose whole bound is *"one hop per actual blow"* -- a poison
       * pulsing twenty times would otherwise shout for the nest twenty times,
       * from wherever the applier had got to by then. It is the same argument
       * that keeps a pulse away from `provoke`: the blow that applied the
       * affliction has already called everyone it was going to call.
       *
       * It was sim-only until spec 219, on the argument that a client draws a
       * floating number the same way whatever caused it -- true of the number,
       * and false of the *picture*. A pulse has an attacker who walked away
       * seconds ago and a bearing along which nothing happened, so every beat
       * of a Poison threw a brush hit off the body. It rides as
       * `CombatFlag.Periodic` now, and the client draws the number and not the
       * blow.
       */
      readonly periodic?: boolean;
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
      /**
       * Which way the cue points, radians about Y (spec 235).
       *
       * Optional, and absent is the same "no bearing" a radial cue has always
       * had -- a blast, a heal and a ring are the same picture whichever way the
       * caster was standing, and they say so by leaving this off rather than by
       * sending a zero that means something.
       *
       * It exists because two shapes are *not* radial and could not be drawn at
       * all without it: a cone and a lane both run from the caster toward the
       * aim, and `landArea` sends a line's cue at the caster's own feet. Every
       * landing that has a direction already computes one -- `landCone` has had
       * `dirX/dirY` since spec 062 -- so this carries what was being thrown away.
       */
      readonly rotation?: number;
    }
  | {
      /**
       * A body was credited for a kill (spec 156).
       *
       * Carries the breakdown, and that is the whole reason it exists: the
       * brief's quality bar asks whether a designer can inspect *why* a player
       * received a given amount of restoration, and a number with no derivation
       * beside it is exactly what gets retuned in the wrong direction. Nothing
       * in the sim reads it -- the meter has already moved by the time this is
       * pushed -- so it is pure instrumentation and costs nothing to ignore.
       */
      readonly kind: 'restoration';
      readonly entityId: number;
      readonly victimId: number;
      /** Progress added by this kill, bonuses and farm decay included. */
      readonly progress: number;
      /** How full the meter is now, 0..1. */
      readonly meter: number;
      readonly motes: number;
      /** Of those, how many the elite guarantee added on top. */
      readonly guaranteed: number;
      /** True when this body helped rather than finished. */
      readonly assist: boolean;
      /** What paid, and how much, as fractions of the base. */
      readonly sources: readonly { readonly reason: string; readonly amount: number }[];
    }
  | {
      /**
       * Cooldown was taken off a body's active abilities (spec 252).
       *
       * Pure instrumentation, in the register `restoration` occupies: nothing
       * in the sim reads it -- the cooldowns have already moved by the time it
       * is pushed -- and it carries the breakdown because the balance question
       * this mechanic raises is *which* abilities got the time, not how much
       * came off in total. One trigger pays every cooling active ability at
       * once, so a total with no derivation beside it is exactly the number
       * that gets retuned in the wrong direction.
       *
       * `source` names what paid, so a second producer later cannot silently
       * make a Mobile Offense count wrong.
       */
      readonly kind: 'cooldownRefunded';
      readonly entityId: number;
      readonly source: string;
      /** Total ticks removed, across every ability below. */
      readonly ticks: number;
      readonly abilities: readonly CooldownRefund[];
    }
  | {
      /** A mote reached somebody, or faded without doing (spec 156). */
      readonly kind: 'mote';
      /** The mote's own entity id, which is about to stop existing. */
      readonly entityId: number;
      readonly ownerId: number;
      /** `MoteKind`. See `sim/restoration.ts`. */
      readonly moteKind: number;
      /** What actually landed. Zero when it faded untaken. */
      readonly restored: number;
      /** What did not: the overheal on a collection, or all of it on a fade. */
      readonly wasted: number;
      readonly collected: boolean;
    }
  | { readonly kind: 'spawned'; readonly entityId: number; readonly typeId: string }
  | { readonly kind: 'despawned'; readonly entityId: number }
  | {
      /**
       * A drop crossed its reveal tick (spec 158).
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
  | {
      readonly kind: 'died';
      readonly entityId: number;
      readonly killerId: number | null;
      /**
       * What died, carried rather than looked up (spec 164).
       *
       * The rule this states: **a death event outlives the body it is about.**
       * Step 4a of `stepWorld` sweeps a dead monster out of the state in the
       * same step that emits this event, so every reader that runs afterwards --
       * `server.ts`'s experience award among them -- resolves the entity id to
       * nothing. That award had been dead code since spec 062 for exactly this
       * reason: the row it needed was gone before it looked, so no kill in the
       * game's history has ever paid out.
       *
       * `world.ts` already knew this and worked around it locally, building a
       * `killedBy` map from the events *before* the sweep so loot could be
       * rolled. Two fields on the event is that same fact stated once, for
       * every reader, instead of reconstructed by each.
       */
      readonly victimKind: number;
      readonly victimTypeId: string;
      /**
       * How it died (spec 156).
       *
       * On the event that already says *who* killed *whom* rather than as a
       * second event beside it, because there is one death and it should have
       * one record. Every field is something `resolveBlow` had already worked
       * out for its own reasons, so none of it is a new measurement -- and the
       * restoration pass in `world.ts` is the only reader, because it is the
       * only thing that has to tell a scrappy kill from a clean one.
       *
       * All false for a death with no blow behind it: a fall, an admin
       * despawn, a body that ran out of health with nobody to credit.
       */
      readonly qualities: KillQualities;
    };

export interface StepResult {
  readonly state: ServerWorldState;
  readonly events: readonly ServerSimEvent[];
}
