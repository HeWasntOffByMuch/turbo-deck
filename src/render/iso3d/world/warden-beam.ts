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
 * A **lock-on** is a thin line: a laser pointer swinging onto you, saying
 * *this way, and soon*. A **beam** is the lane itself, at the width that
 * actually damages, saying *this ground, now*. They have to be unmistakable at
 * a glance and from any zoom, so they differ in width by a factor of ten and
 * not in brightness alone -- brightness is what the retro pass quantizes away,
 * and a telegraph nobody can see is a fight nobody can play.
 *
 * ## The width is honest in one phase and not in the other
 *
 * The beam is drawn at `WARDEN_LASER.width`, which is the number
 * `selectByArea` picks bodies out of: what you can see is what will hit you.
 * The lock-on is drawn thin *by design* -- it says where the lance is pointed
 * and not how wide it opens. That is a real cost, stated rather than hidden:
 * the first Warden a player meets under-reads the danger by design, and the
 * second one does not, because by then they have seen a beam.
 *
 * ## Nothing here reads a clock
 *
 * The tick is an argument, like everywhere else in this directory, so the same
 * frame drawn twice is the same picture and a golden is a question about the
 * state rather than about when the test ran.
 */

import { WardenPhase, laserCycleFor, wardenPhaseOf } from '../../../server/data/warden.js';
import { CastPhase } from '../../../server/sim/types.js';

/**
 * How wide the lock-on line is drawn, in world units.
 *
 * A player body is 32 across, so this is about a fifth of one: thin enough to
 * read as an aiming line rather than as a corridor, wide enough to survive the
 * virtual raster at the zoom the game is played at. It is **not** derived from
 * the lane's own width, deliberately -- the whole point is that it does not
 * predict it.
 */
export const LOCK_ON_WIDTH = 6;

/**
 * The hot middle of a firing beam, as a fraction of the lane's full width.
 *
 * **Narrow**, and photographing it is what decided the number. At a quarter of
 * the lane the core is a stripe down the middle of a band and the whole thing
 * reads as a painted road; at a seventh it is a filament inside a glow, which
 * is what a beam looks like. The other half of the same fix is that the lane
 * around it got *more* opaque rather than less -- a hot centre needs something
 * saturated to be hot against, and a washed-out surround made the core the
 * subject.
 */
export const CORE_FRACTION = 0.14;

/**
 * How much of the beam's brightness comes and goes, and how fast.
 *
 * Small. What it is for is that a solid band of one colour laid on the ground
 * reads as an interface element rather than as something happening, and the
 * cheapest fix that is not more particles is a shimmer on the core. The outer
 * band is deliberately left steady: that one is the danger zone, and a danger
 * zone that visibly breathes is a danger zone a player will squint at.
 */
const SHIMMER_DEPTH = 0.16;
const SHIMMER_TICKS = 7;

/** The look of one lance this frame, or nothing when there is nothing to draw. */
export interface BeamLook {
  /** True while it is firing, false while it is aiming. */
  readonly firing: boolean;
  /** How far the paint runs from the muzzle. */
  readonly length: number;
  /** The full width of the band that is drawn. */
  readonly width: number;
  readonly opacity: number;
  /** The hot middle's full width, or 0 for a phase that has none. */
  readonly coreWidth: number;
  readonly coreOpacity: number;
}

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

  if (phase === WardenPhase.LockOn) {
    // Brightening as it settles on you, which is `syncTelegraphs`' own rule for
    // a ground-targeted wind-up: the ring says where, and how much longer there
    // is to move. Here the line says where, and the brightness says how soon.
    const progress = rampOf(cast, tick);
    return {
      firing: false,
      length: cycle.range,
      width: LOCK_ON_WIDTH,
      // Dimmer at its very brightest than the beam's core is at its dimmest,
      // which is the second half of "much weaker": width says *thinner* and
      // this says *not yet*. It still has to be seen -- it is the only warning
      // there is -- so it opens visible rather than at nothing and doubles.
      opacity: 0.32 + 0.28 * progress,
      // None. A six-unit line with a two-unit core inside it is two decals
      // drawing one line, and at this width the core would be the whole of it.
      coreWidth: 0,
      coreOpacity: 0,
    };
  }

  if (phase === WardenPhase.Firing) {
    const shimmer = 1 + SHIMMER_DEPTH * Math.sin((tick / SHIMMER_TICKS) * Math.PI * 2);
    return {
      firing: true,
      length: cycle.range,
      // The lane's own, exactly: what is drawn is what damages.
      width: cycle.width,
      opacity: 0.55,
      coreWidth: cycle.width * CORE_FRACTION,
      // Clamped, because the shimmer is a multiplier and an opacity over one is
      // a material three silently accepts and then draws as one -- so the
      // breathing would flatten at the top of every cycle.
      coreOpacity: Math.min(1, 0.84 * shimmer),
    };
  }

  return null;
}

/** How far through the lock-on this is, clamped, and 1 for a cast with no span. */
function rampOf(cast: BeamCast | null, tick: number): number {
  if (!cast) return 1;
  const span = cast.releaseTick - cast.startTick;
  if (!(span > 0)) return 1;
  return Math.max(0, Math.min(1, (tick - cast.startTick) / span));
}
