/**
 * The Warden's laser cycle, as numbers (spec 259).
 *
 * `data/scaling.ts`'s register, one system smaller: every quantity the
 * encounter turns on is here, so retuning it is a diff of one file and nothing
 * in `sim/warden.ts` carries a number of its own. What is deliberately *not*
 * here is the body -- health, Guard, move speed, armour and the melee swing are
 * a row in `data/monsters.ts` like every other monster's, because a Warden that
 * authored its own stats somewhere else would be an enemy nobody could compare
 * to a ravager.
 *
 * A table keyed by monster type id rather than a bare constant, in the register
 * `FIXTURE_LIGHTS` and `SHOT_ART` are in: one row today, and a second laser
 * mech is a row here rather than an edit to the sim. `sim/warden.ts` is the
 * only thing that interprets one, and it reaches this table through
 * {@link laserCycleFor} rather than by naming an id.
 *
 * Pure data plus four queries over it, and the queries take loose values rather
 * than a `ServerEntity` -- `facesAim`'s shape, and for its reason: the client
 * has a replica and no server types, and the phase a player is looking at and
 * the phase the sim is in must not be two derivations.
 */

import { SERVER_TICK_RATE } from '../config.js';

/**
 * One laser cycle, whole.
 *
 * Every field is read by something: eight by the ability row this builds, three
 * by the state machine, one by the steering. There is no number here that is
 * only documentation.
 */
export interface LaserCycle {
  /** The row in `data/abilities.ts` this cycle is spent through. */
  readonly abilityId: string;
  /**
   * The lock-on: the ability's wind-up, and the whole of the telegraph.
   *
   * Long on purpose. Spec 094's rule for every wind-up in the game is that a
   * player has to *see* it, decide, and act inside it, and on a real connection
   * a good part of a short window is the round trip. This one is longer than
   * any player wind-up because what it is asking for is not a dodge but a
   * *walk*: the answer to a laser is to be standing somewhere else.
   */
  readonly lockOnTicks: number;
  /** How long the beam runs once it has been committed to. */
  readonly firingTicks: number;
  /** How often it damages whoever is in it. The channel's pulse clock. */
  readonly pulseIntervalTicks: number;
  /**
   * Between one cycle and the next, measured from the attack point.
   *
   * `nextReadyTick` stamps a non-basic ability's cooldown at the tick the blow
   * goes off, so this covers the beam and the overheat and leaves the
   * remainder as ordinary fighting. It is the *only* pacing: there is no second
   * clock deciding when the Warden feels like aiming.
   */
  readonly cooldownTicks: number;
  /** How far the beam reaches, and the range the cast is gated at. */
  readonly range: number;
  /** The lane's **full** width, so a body within half of it is in the beam. */
  readonly width: number;
  /** Health damage, per pulse. */
  readonly damage: number;
  /**
   * Guard damage, per pulse, absolute.
   *
   * Absolute because `poiseDamage` is (spec 188): a skill that says "and this
   * much Guard" should mean it to everybody. It is the larger of the two
   * numbers on purpose -- the beam's identity is that it takes your guard
   * before it takes your health, so standing in it is what staggers you, and
   * being staggered in it is what kills you.
   */
  readonly guardDamage: number;
  /**
   * How fast the beam may be re-aimed once it is firing, in degrees a second.
   *
   * The number the whole encounter rests on. It is not the body's turn rate and
   * must stay far below it: a beam that tracked at `stats.turnRate` would be a
   * damage aura with extra steps, and the intended answer -- bait the
   * commitment one way, then walk out of it -- would not exist.
   *
   * Chosen against the *far* end of the range rather than the near one, which
   * is the half that is easy to get wrong. A lane sweeps its tip faster the
   * further out you stand, so escaping is hardest at maximum range: at 400
   * units 8 deg/s carries the beam sideways at 56 units a second against a
   * player's 155, which leaves a body about half a second of walking to clear
   * its own half-width. At 25 deg/s the same escape takes nearly two seconds,
   * which is most of the beam.
   */
  readonly firingTurnRateDeg: number;
  /** How long the machine is helpless afterwards. The player's damage window. */
  readonly overheatTicks: number;
  /**
   * What `StatusId.Exposed` is worth during that window.
   *
   * The punish, expressed in the vocabulary the game already has rather than as
   * a Warden-shaped damage multiplier: `resolveBlow` reads an exposure's
   * magnitude on every blow from anybody, so the window rewards whoever is
   * standing there, which is what makes the group reading of this encounter
   * work without a raid mechanic in it.
   */
  readonly overheatExposure: number;
}

function seconds(value: number): number {
  return Math.max(1, Math.round(value * SERVER_TICK_RATE));
}

/**
 * The one cycle in the game.
 *
 * Read the four durations together, because what a player experiences is their
 * sum and not any one of them: 1.8s of being aimed at, 2.0s of beam, 3.0s of a
 * helpless machine, and 9.0s from the trigger to the next trigger -- which
 * leaves about four seconds in which the Warden is simply a heavy monster that
 * walks at you. That last span is not spare time, it is what makes the cycle
 * legible: a telegraph nobody ever sees the *absence* of is just a rhythm.
 */
export const WARDEN_LASER: LaserCycle = {
  abilityId: 'warden.laser',
  lockOnTicks: seconds(1.8),
  firingTicks: seconds(2),
  // Eight pulses over the beam, which is the coarsest cadence that still lets a
  // player pay a *fraction* of it for a slow reaction. At one pulse a second a
  // beam is four all-or-nothing hits and stepping out is worth either
  // everything or nothing.
  pulseIntervalTicks: seconds(0.25),
  cooldownTicks: seconds(9),
  // Past its own notice range (420), so a body it has engaged is always inside
  // it: the laser is the thing it does, not a thing it does when you get close.
  range: 620,
  // A little over two player bodies. Wide enough to be a place rather than a
  // line, narrow enough that walking out of it is a walk rather than a sprint.
  width: 70,
  damage: 4,
  guardDamage: 5,
  firingTurnRateDeg: 8,
  overheatTicks: seconds(3),
  overheatExposure: 0.6,
};

/** Every body that fights this way, by monster type id. */
export const LASER_CYCLES: ReadonlyMap<string, LaserCycle> = new Map([['warden', WARDEN_LASER]]);

/** The cycle this body fights with, or null for a monster that does not. */
export function laserCycleFor(typeId: string): LaserCycle | null {
  return LASER_CYCLES.get(typeId) ?? null;
}

/**
 * The cycle an ability id belongs to, or null.
 *
 * The other direction, and it has one caller that could not use the first:
 * `coolAfterBeam` is driven off `castEnded` events, which name an ability and
 * not a body. Built once rather than searched, because it is asked per event.
 */
const BY_ABILITY: ReadonlyMap<string, LaserCycle> = new Map(
  [...LASER_CYCLES.values()].map((cycle) => [cycle.abilityId, cycle]),
);

export function cycleByAbility(abilityId: string): LaserCycle | null {
  return BY_ABILITY.get(abilityId) ?? null;
}

/**
 * The four states, and there are only four (spec 259).
 *
 * A `const` object in `StatusId`'s register rather than a string union, because
 * it crosses no wire and its whole use is comparison. **Nothing stores one**:
 * every state is derived from facts that are already replicated for their own
 * reasons -- the cast and its phase, and one status -- so there is no field
 * that can disagree with the body it describes, and a client answers the same
 * question off a replica with the same function.
 */
export const WardenPhase = {
  /** Fighting like anything else: chasing, and swinging its melee attack. */
  Normal: 0,
  /** Aiming. Rooted by its own wind-up, and tracking at its own turn rate. */
  LockOn: 1,
  /** Committed. Rooted, and re-aiming at `firingTurnRateDeg` and no faster. */
  Firing: 2,
  /** Helpless. The player's window. */
  Overheated: 3,
} as const;

export type WardenPhaseValue = (typeof WardenPhase)[keyof typeof WardenPhase];

/**
 * Which state a body is in, from the things both ends can see.
 *
 * Loose values rather than a `ServerEntity`, which is `facesAim`'s shape and is
 * here for its reason: the renderer has a `KnownCast` and a list of wire
 * statuses, and "is that mech about to fire" must not be two derivations that
 * agree until one is edited.
 *
 * `castPhase` is a {@link import('../sim/types.js').CastPhase}. It is not read
 * beyond telling the channel from everything before it, so a caller with only
 * the phase byte off the wire can answer.
 */
export function wardenPhaseOf(
  cycle: LaserCycle | null,
  castAbilityId: string | null,
  castPhase: number | null,
  channelPhase: number,
  overheated: boolean,
): WardenPhaseValue {
  if (!cycle) return WardenPhase.Normal;
  if (castAbilityId === cycle.abilityId) {
    return castPhase === channelPhase ? WardenPhase.Firing : WardenPhase.LockOn;
  }
  // Asked *after* the cast, and the order is load-bearing rather than tidy: the
  // overheat is applied on the tick the beam ends, so for exactly one tick a
  // body can carry both, and what it is doing then is finishing the beam.
  return overheated ? WardenPhase.Overheated : WardenPhase.Normal;
}

/** Where a beam is, for anything that has to draw one or measure one. */
export interface Beam {
  readonly originX: number;
  readonly originY: number;
  readonly dirX: number;
  readonly dirY: number;
  readonly range: number;
  /** A body within this of the lane's centre line is in the beam. */
  readonly halfWidth: number;
}

/**
 * The beam a body at `(x, y)` pointing `facing` is throwing.
 *
 * From the **heading** rather than from the cast's aim, and that is the
 * encounter's one geometric claim: `sim/warden.ts` keeps the aim and the facing
 * equal to each other every tick a beam is live, so this answers the same lane
 * `selectByArea` picks bodies out of -- and it answers it for a client, which
 * has a replicated facing and has never been sent a cast's aim as a direction.
 */
export function beamOf(cycle: LaserCycle, x: number, y: number, facing: number): Beam {
  return {
    originX: x,
    originY: y,
    dirX: Math.cos(facing),
    dirY: Math.sin(facing),
    range: cycle.range,
    halfWidth: cycle.width / 2,
  };
}
