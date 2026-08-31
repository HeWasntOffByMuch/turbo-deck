/**
 * What the Warden's lance looks like this frame (spec 259).
 *
 * Pure -- no three.js, no DOM, no `GameClient`. It is handed replicated facts
 * and answers what to draw, which is the discipline `shot-vfx.ts`,
 * `affliction-vfx.ts` and `vfx-wire.ts` all keep so that presentation has
 * nothing it *could* call. Every `if` in here decides a picture; none of them
 * decides a game outcome.
 *
 * ## Two pictures, and the difference between them is the encounter
 *
 * A **lock-on** is a sight: a line of single pixels running out of the head,
 * sliding away from the machine, saying *this way, and soon*. A **beam** is a
 * shaft of light out of the same opening, saying *this line, now*. They share
 * one line -- the pointer shows exactly where the beam will be -- and they are
 * unmistakable at a glance because one is made of dots and the other is solid.
 *
 * ## Where the line is
 *
 * From the head's opening down to just off the ground at the far end. Both ends
 * are load-bearing. The **near** end is the opening because that is where a
 * player's eye goes -- it is the only part of this machine that turns, so it is
 * the part that tells you where the shot is going. The **far** end is near the
 * ground because the sim's lane damages everything from the muzzle outward: a
 * level beam at head height would be a weapon that visibly passes over the body
 * it is hurting.
 *
 * ## The width, and which of the two shapes is honest about it
 *
 * The **footprint** on the ground is the lane's own width, and it is the
 * truthful one: what is drawn there is what `selectByArea` picks bodies out of.
 * The **shaft** is deliberately narrower, and that is the relationship a
 * fireball already has to its blast -- the object you can see is smaller than
 * the region it affects, and the mark on the ground is what states the region.
 * A shaft drawn at the lane's full width is a girder rather than a beam.
 *
 * ## Nothing here reads a clock
 *
 * The tick is an argument, like everywhere else in this directory, so the same
 * frame drawn twice is the same picture and every client watching one Warden
 * sees the dots in the same places.
 */

import { WardenPhase, laserCycleFor, wardenPhaseOf, type LaserCycle } from '../../../server/data/warden.js';
import { CastPhase } from '../../../server/sim/types.js';

/**
 * How far off the ground the far end of the line sits.
 *
 * Low enough that the shaft plainly reaches the ground -- which is what the
 * scorch marks under it are a consequence of -- and not zero, because a beam
 * that ends exactly on the surface has half of it inside the hill on any ground
 * that is not level.
 */
export const BEAM_END_LIFT = 5;

/**
 * The shaft's thickness, as a fraction of the lane it is fired down.
 *
 * A third, which is where "narrower" lives: the lane is the ground the sim
 * damages and does not move, and this is the object you can see. 24 units on the
 * shipped lane -- half again a player's radius, so it plainly clears the retro
 * raster at range, and plainly a *line* rather than the corridor a full-width
 * band drew.
 */
export const SHAFT_FRACTION = 0.34;

/** The hot filament inside the shaft, as the same fraction. */
export const CORE_FRACTION = 0.12;

/**
 * How far apart the sight's pixels sit, in world units.
 *
 * Wide, on purpose. A dotted line reads as a *sight* rather than as a beam
 * exactly to the extent that the gaps are bigger than the dots, and a dot here
 * is one or two pixels of the virtual raster -- so the spacing has to be a body
 * radius or so before the eye reads dashes instead of a line with holes in it.
 */
export const SIGHT_SPACING = 26;

/** How many world units the sight's pattern slides per tick, away from the head. */
const SIGHT_DRIFT = 1.6;

/**
 * How much of the beam's brightness comes and goes, and how fast.
 *
 * Small. What it is for is that a solid shaft of one colour reads as a prop
 * rather than as something happening, and the cheapest fix that is not more
 * particles is a shimmer on the core. The shaft around it is deliberately left
 * steady: a beam that visibly breathes is a beam a player will squint at.
 */
const SHIMMER_DEPTH = 0.16;
const SHIMMER_TICKS = 7;

/** The line both phases are drawn along. */
export interface BeamLine {
  /** How far it reaches from the head. */
  readonly length: number;
  /** How high above the ground the far end sits. */
  readonly endLift: number;
}

/**
 * The sight, while it is aiming.
 *
 * `phase` is how far along a gap the pattern has slid, in `[0, 1)`, so a caller
 * lays its first dot at `phase * spacing` and steps by `spacing` from there.
 * Sliding rather than twinkling because a laser sight is a *scan*: which dots
 * are lit is not information, and a pattern that travels says the machine is
 * doing something where a random flicker says the picture is noisy.
 */
export interface SightLook extends BeamLine {
  readonly kind: 'lockOn';
  readonly spacing: number;
  readonly phase: number;
  /** Size of one dot in virtual pixels. One is a pixel; two survives a resize. */
  readonly pixel: number;
  readonly opacity: number;
}

/** The shaft, while it is firing, and the ground it is standing on. */
export interface ShaftLook extends BeamLine {
  readonly kind: 'firing';
  /** The visible shaft's thickness. Narrower than the lane -- see the header. */
  readonly width: number;
  readonly coreWidth: number;
  readonly opacity: number;
  readonly coreOpacity: number;
  /** The lane's own width, drawn on the ground: what actually damages. */
  readonly footprintWidth: number;
  readonly footprintOpacity: number;
}

export type BeamLook = SightLook | ShaftLook;

/** What a caller has to know about the cast, and no more. */
export interface BeamCast {
  readonly abilityId: string;
  /** A {@link CastPhase}. */
  readonly phase: number;
  /** The tick the wind-up began, so a lock-on has an origin to ramp from. */
  readonly startTick: number;
  /** The tick it commits, which is the end of that ramp. */
  readonly releaseTick: number;
}

/**
 * What to draw over a body of this type, given the cast it is in the middle of.
 *
 * `null` for every body in the game but one, and for that one whenever it is
 * not aiming or firing -- so the caller's whole job is "draw it or hide it".
 *
 * The phase comes from `data/warden.ts`'s own `wardenPhaseOf` rather than from
 * a second reading of the cast, which is the promise that file makes: the phase
 * the sim acts on and the phase a player is shown are one derivation. The
 * overheat is passed as `false` because a machine that has stopped firing draws
 * no beam -- what it draws then is a status mark, which is somebody else's job.
 */
export function beamLookFor(
  typeId: string,
  cast: BeamCast | null,
  tick: number,
): BeamLook | null {
  const cycle = laserCycleFor(typeId);
  if (!cycle) return null;
  const phase = wardenPhaseOf(
    cycle,
    cast?.abilityId ?? null,
    cast?.phase ?? null,
    CastPhase.Channel,
    false,
  );
  if (phase === WardenPhase.LockOn) return sight(cycle, cast, tick);
  if (phase === WardenPhase.Firing) return shaft(cycle, tick);
  return null;
}

function sight(cycle: LaserCycle, cast: BeamCast | null, tick: number): SightLook {
  // Brightening as it settles on you, which is `syncTelegraphs`' own rule for a
  // ground-targeted wind-up: the ring says where, and how much longer there is
  // to move. Here the dots say where, and the brightness says how soon.
  const progress = rampOf(cast, tick);
  return {
    kind: 'lockOn',
    length: cycle.range,
    endLift: BEAM_END_LIFT,
    spacing: SIGHT_SPACING,
    // Positive and modulo one, so a client that picked the fight up late slides
    // from wherever the tick says rather than from a negative offset that would
    // put its first dot behind the head.
    phase: (((tick * SIGHT_DRIFT) / SIGHT_SPACING) % 1 + 1) % 1,
    // Two rather than one. A single pixel of the virtual raster is right at the
    // resolution this game is authored for and is a *half* pixel the moment the
    // interface scale rounds the other way, which is a sight that disappears on
    // somebody's monitor and nobody else's.
    pixel: 2,
    // Dimmer at its brightest than the shaft is at its dimmest, which is the
    // second half of "much weaker": dots say *thinner* and this says *not yet*.
    // It still has to be seen -- it is the only warning there is -- so it opens
    // visible rather than at nothing and climbs.
    opacity: 0.38 + 0.3 * progress,
  };
}

function shaft(cycle: LaserCycle, tick: number): ShaftLook {
  const shimmer = 1 + SHIMMER_DEPTH * Math.sin((tick / SHIMMER_TICKS) * Math.PI * 2);
  return {
    kind: 'firing',
    length: cycle.range,
    endLift: BEAM_END_LIFT,
    width: cycle.width * SHAFT_FRACTION,
    coreWidth: cycle.width * CORE_FRACTION,
    opacity: 0.85,
    // Clamped, because the shimmer is a multiplier and an opacity over one is a
    // material three silently accepts and then draws as one -- so the breathing
    // would flatten at the top of every cycle and only ever read as a dimming.
    coreOpacity: Math.min(1, 0.92 * shimmer),
    // The lane's own, exactly: what is drawn there is what damages.
    footprintWidth: cycle.width,
    // Dim. It is underneath a lit shaft and its job is to say where the edges of
    // the danger are, not to compete with the thing making it dangerous.
    footprintOpacity: 0.3,
  };
}

/** How far through the lock-on this is, clamped, and 1 for a cast with no span. */
function rampOf(cast: BeamCast | null, tick: number): number {
  if (!cast) return 1;
  const span = cast.releaseTick - cast.startTick;
  if (!(span > 0)) return 1;
  return Math.max(0, Math.min(1, (tick - cast.startTick) / span));
}

/**
 * How many dots a sight of this length holds, and where each one sits along it.
 *
 * Here rather than in the scene because it is arithmetic with an off-by-one in
 * it: the pattern slides, so the count has to be the same every frame or the
 * geometry is rebuilt whenever a dot crosses the end -- and a caller that
 * allocated per frame would be allocating a `Float32Array` sixty times a second
 * for as long as somebody is being aimed at.
 */
export function sightDotCount(look: SightLook): number {
  return Math.max(1, Math.floor(look.length / look.spacing));
}

/** How far along the line the `index`-th dot sits, in world units from the head. */
export function sightDotAt(look: SightLook, index: number): number {
  const along = (index + look.phase) * look.spacing;
  // Wrapped rather than clamped: a dot that has slid past the end comes back at
  // the head, which is what makes the pattern travel forever out of a fixed
  // number of points.
  return along % look.length;
}
