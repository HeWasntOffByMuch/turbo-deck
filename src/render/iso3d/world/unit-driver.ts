/**
 * Replicated facts in, machine commands out (spec 111).
 *
 * This is the presentation-only boundary, written as a function signature rather
 * than as a comment asking people to be careful.
 *
 * The brief's rule is that the server sends position, facing and an action enum,
 * the client picks the animation, and animation state never feeds back into
 * gameplay state. The enforcement is that this function is handed a
 * {@link UnitFacts} — a plain snapshot of what the wire said — and *not* the
 * `GameClient`. It has nothing to call. There is no `sendInput` in scope, no
 * entity to mutate, and no way to reach one, so an animation cannot influence a
 * game outcome even if somebody set out to make it. The events it returns go to
 * the renderer and to nothing else.
 *
 * The other direction is already closed by the module graph: `src/render/` reads
 * `src/server/`, never the reverse, and eslint fails the build on an import back
 * the other way.
 *
 * Pure, so a whole fight's worth of animation decisions can be replayed in Node.
 */

import { EntityActivity, CastPhaseValue } from '../../../server/net/protocol.js';
import type { FiredEvent, UnitMachine } from '../../../units/machine.js';

/**
 * Everything about an entity that may pick an animation.
 *
 * Every field is either straight off the wire or something the renderer already
 * computed for its own drawing. Nothing here is derived from an animation, which
 * is the property that makes the feedback loop impossible rather than merely
 * discouraged.
 */
export interface UnitFacts {
  /** World units per second, from the drawn motion. */
  readonly speed: number;
  /** `EntityActivity`, as replicated. */
  readonly activity: number;
  /** `CastPhaseValue` while a cast is running, else null. */
  readonly castPhase: number | null;
  readonly dead: boolean;
}

/**
 * The parameter names a driven unit is expected to declare.
 *
 * A unitdef that declares none of them still runs — `setParameter` ignores what
 * was not declared, so an author who wired their machine on triggers alone gets
 * a machine driven by triggers alone rather than a crash. The names are here so
 * the catalogue and the authoring docs agree on the vocabulary.
 */
export const DRIVEN_PARAMETERS = {
  speed: 'speed',
  dead: 'dead',
  attack: 'attack',
} as const;

/**
 * Writes this tick's facts onto the machine and steps it.
 *
 * Steps by whole ticks and by nothing else. The caller passes how many the
 * frame's accumulator actually drained, which is what makes an event land on the
 * same machine tick at 30fps as at 144 — see {@link UnitMachine.step}, which
 * walks them one at a time so an overshoot cannot skip one.
 *
 * The attack trigger is edge-detected against the *previous* facts rather than
 * raised whenever the activity says casting: a cast lasts many ticks, and a
 * trigger raised on each of them would restart the swing every frame of its own
 * wind-up.
 */
export function driveUnit(
  machine: UnitMachine,
  facts: UnitFacts,
  previous: UnitFacts | null,
  ticks: number,
): readonly FiredEvent[] {
  machine.setParameter(DRIVEN_PARAMETERS.speed, facts.speed);
  machine.setParameter(DRIVEN_PARAMETERS.dead, facts.dead);
  if (startedCasting(facts, previous)) machine.trigger(DRIVEN_PARAMETERS.attack);
  return machine.step(ticks);
}

/**
 * True on the tick a cast begins, and on no other.
 *
 * Two things count as beginning. The obvious one is activity crossing into
 * `Casting`. The other is the phase going *backwards* — from recovery to
 * turning or wind-up — which is what a second swing looks like when it starts
 * before the first has finished replicating, and treating it as a continuation
 * would drop every attack after the first in a chain.
 */
export function startedCasting(facts: UnitFacts, previous: UnitFacts | null): boolean {
  if (facts.dead) return false;
  if (facts.activity !== EntityActivity.Casting) return false;
  if (previous === null || previous.activity !== EntityActivity.Casting) return true;
  const from = previous.castPhase;
  const to = facts.castPhase;
  if (from === null || to === null) return false;
  return isOpening(to) && !isOpening(from);
}

/** The phases that begin a swing rather than finish one. */
function isOpening(phase: number): boolean {
  return phase === CastPhaseValue.Turning || phase === CastPhaseValue.Windup;
}

/**
 * The speed the blend tree should see, from two drawn positions.
 *
 * Measured off what is actually on screen rather than off the replicated
 * velocity, so the feet match the body the eye is following. That sounds like
 * animation feeding back into itself and is not: the drawn position comes from
 * the interpolator over authoritative samples, which no animation touches.
 *
 * Zero when no time passed, rather than a division by zero that would send an
 * infinity into a blend tree and clamp it to a dead sprint.
 */
export function speedBetween(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  seconds: number,
): number {
  if (!(seconds > 0)) return 0;
  return Math.hypot(to.x - from.x, to.y - from.y) / seconds;
}
