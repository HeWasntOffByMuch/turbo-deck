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
 * ## Nothing is painted on the ground
 *
 * There was a decal at the lane's full width under the shaft, on the argument
 * that the honest picture of a danger zone is the danger zone. It read as a
 * painted road: a hard-edged band six hundred units long over the grass, wider
 * and more solid than the weapon making it, and the thing an eye went to.
 *
 * What replaces it is **light**. The beam hangs {@link BEAM_GLOW_LIGHTS} red
 * point lights along itself and the ground under it is lit rather than painted,
 * which says the same thing in the register the rest of this game says it in --
 * a campfire does not draw a disc on the floor either.
 *
 * What that costs is stated rather than hidden: a lit pool has no edge, so the
 * shaft is now the only *hard* statement of where the beam is and it is
 * {@link SHAFT_FRACTION} of the lane. A player at the lane's rim can be hit with
 * nothing solid drawn on them. The lane is what the fight was measured against,
 * so the honest fix if that reads badly is to bring `width` down to the shaft
 * rather than to paint the ground again.
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

/**
 * How many red lights a firing beam hangs along itself.
 *
 * Three, and the number is set from both ends. Fewer leaves gaps -- a point
 * light's pool is a disc and this thing is six hundred units long, so one in the
 * middle lights the middle and says nothing about the ends. More is a claim on
 * the light pool: these go in as ordinary {@link LightRequest}s beside the map's
 * own fixtures, so every one the beam asks for is one a campfire near the player
 * may not get.
 */
export const BEAM_GLOW_LIGHTS = 3;

/**
 * How far each one reaches.
 *
 * A little under half the run, so three of them overlap rather than beading. The
 * campfire's own 420 is the calibration this is read against -- a laser should
 * not out-reach a bonfire, it should be harsher and nearer.
 */
export const BEAM_GLOW_RADIUS = 380;

/**
 * How high above the ground each one sits.
 *
 * Three times the muzzle's own height, and the reason is the near field rather
 * than the far one. What a point light lands on flat ground with is
 * `brightness * (radius/2)^2 * facing / d^2`, and directly underneath, `d` *is*
 * the height -- so a light on the beam, at the 5 units its far end sits at,
 * delivers about two thousand times what it delivers a body-length away. That is
 * not a bright beam, it is a white hole in the grass with dark ground around it,
 * which is exactly what the first cut of this drew.
 *
 * Height is the only lever on that: it is the term the near field divides by.
 * At 145 the pool runs 0.50 under the beam to 0.21 at 150 units out, which is a
 * red wash hugging the line rather than a floodlit field or a row of hot spots.
 *
 * Nothing can see where the light *is* -- a point light draws nothing of itself
 * -- so what this costs is that the three of them together approximate a
 * six-hundred-unit line of light rather than being on it. The alternative is
 * more lights lower down, and each one is a slot the map's own fixtures do not
 * get.
 */
export const BEAM_GLOW_HEIGHT = 145;

/**
 * What one throws with nothing taken off it, in `pointIntensity`'s unit:
 * illuminance at half {@link BEAM_GLOW_RADIUS}.
 *
 * *Under* the campfire's 2.2, which is the opposite of what a laser beside a
 * bonfire suggests and follows from the height above: this one is lifted to
 * spread its pool out, so the same authored number would land far harder.
 *
 * What it was chosen against is the **retro pass**, not taste.
 * `preview-lance.ts` reports how far the light moves the ground *in colour
 * bands*, and there are five of them -- so a wash under half a band is one the
 * quantize rounds away, which is the trap `wind.ts` and the living ground have
 * both fallen into. Measured across that sheet: 15% of the frame moved by a
 * full band. At 0.5 it was 2% and mostly invisible; at 3.1 the ground blew out
 * to white and the beam read as lava rather than as light.
 */
const GLOW_BRIGHTNESS = 1.4;

/**
 * How much of that the flicker is allowed to take away.
 *
 * A third, so the floor is two thirds of the peak. A flicker that reaches zero
 * is a strobe, and a strobe over a weapon a player is trying to walk out of is
 * the ground going dark at the moment they most need to see it.
 */
const FLICKER_DEPTH = 0.34;

/**
 * The periods the flicker is built out of, in ticks.
 *
 * Three, and deliberately incommensurate: one sine is a *pulse* -- a light
 * breathing on a fixed beat, which reads as machinery idling rather than as an
 * arc misbehaving -- and three that never line up have no beat to hear. The
 * fastest is about 13Hz, which is a crackle; the slowest is about 3.5Hz, which
 * is the swell under it.
 */
const FLICKER_PERIODS: readonly number[] = [4.7, 9.3, 17.1];

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

/** The shaft, while it is firing. */
export interface ShaftLook extends BeamLine {
  readonly kind: 'firing';
  /** The visible shaft's thickness. Narrower than the lane -- see the header. */
  readonly width: number;
  readonly coreWidth: number;
  readonly opacity: number;
  readonly coreOpacity: number;
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

/**
 * How far the `index`-th light sits from the head, in world units.
 *
 * At the midpoints of an even division rather than at its joints, so none of
 * them sits on the muzzle -- where the shaft's own colour is already the
 * brightest thing there is and a light adds nothing -- and none sits past the
 * end, where it would light ground the beam does not reach.
 */
export function beamGlowAt(look: ShaftLook, index: number): number {
  const step = look.length / BEAM_GLOW_LIGHTS;
  return step * (index + 0.5);
}

/**
 * What the `index`-th light is worth this tick.
 *
 * Each light has a phase of its own, which is the difference between a beam that
 * flickers and a beam that *pulses*: lit together they are one lamp on a dimmer,
 * and lit out of step they are an unstable line. A pure function of its two
 * arguments, so every client watching one Warden sees the same flicker with
 * nothing replicated for it -- the rule the shimmer and the sight's drift are
 * already under.
 */
export function beamGlowBrightness(index: number, tick: number): number {
  let sum = 0;
  for (const period of FLICKER_PERIODS) {
    sum += Math.sin((tick / period + index * 0.37) * Math.PI * 2);
  }
  const unit = (sum / FLICKER_PERIODS.length + 1) / 2;
  return GLOW_BRIGHTNESS * (1 - FLICKER_DEPTH + FLICKER_DEPTH * unit);
}
