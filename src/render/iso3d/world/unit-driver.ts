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

import type { UnitDef } from '../../../units/types.js';
import { abilityById } from '../../../server/data/abilities.js';
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
  /**
   * How fast the attack animation should play, 1 being the authored speed
   * (spec 144).
   *
   * The attack-speed factor, and it is a *fact* rather than a stat lookup
   * because it can be measured off the wire: the server sends the tick the
   * wind-up began and the tick it releases, and the ratio of the ability
   * table's authored wind-up to that span is exactly the factor the sim
   * divided by. So a monster, a remote player and the local one all get the
   * right rate from the same two numbers, and none of them needs stats this
   * client may not have.
   *
   * That direction is the point. Gameplay timing is authoritative and the clip
   * is rescaled to fit it -- the same rule `machine.startAction` already
   * follows -- rather than the animation deciding when anything happens.
   */
  readonly attackRate: number;
  /**
   * The ability being cast, as replicated, or null when nothing is (spec 164).
   *
   * Here because a body has more than one basic attack and they do not look
   * alike: the same `Casting` activity is a sword coming over the shoulder or a
   * bow being drawn, and nothing else on this snapshot can tell them apart. It
   * is an id rather than a resolved animation name on purpose -- what a given
   * ability *looks* like is a decision for the renderer, and putting the
   * decision here would mean the wire had made it.
   *
   * Reading the ability table off it is not the sim reaching into animation:
   * `appearance.ts` already does exactly this for a projectile's look, the
   * table is content rather than state, and nothing this function returns can
   * reach a game outcome.
   */
  readonly abilityId: string | null;
  /**
   * Ticks from now until this cast's own scheduled end, or null when nothing is
   * casting (spec 166).
   *
   * `endTick - tick`, both of which the wire already carries and the cast bar
   * already reads. It is here to answer one question and only one: when a cast
   * stops existing, was that because it *finished* or because it was called
   * off? Nothing else on this snapshot can tell those apart -- a withdrawn
   * wind-up and a completed blow both end with the cast simply gone.
   */
  readonly castTicksLeft: number | null;
  readonly dead: boolean;
}

/**
 * How much of a cast may be left when it ends and still count as finishing.
 *
 * Six ticks, a tenth of a second, and it is a *sampling* margin rather than a
 * judgement about the game. `previous` is the last frame that was driven, and a
 * frame drains as many ticks as it has to -- three at 20fps -- so a cast that
 * ends exactly on schedule was last seen with a few ticks still on it. Reading
 * that as a cancellation would cut the tail off every attack anybody ever
 * completed on a slow machine.
 *
 * The error runs the safe way. A cast ending within this of its own end is
 * treated as finishing, which is what everything did before this existed; and a
 * withdrawal is never that close, because withdrawing happens in the *wind-up*
 * and the whole backswing is still ahead of it.
 */
const FINISHED_WITHIN_TICKS = 6;

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
  shoot: 'shoot',
  /**
   * The poise break (spec 172). No unit in the tree declares it yet, so today
   * this trigger is raised into the void on every rig -- which is the correct
   * shape rather than a gap: `stagger-flinch.ts` is the channel that draws a
   * break without authored content, and this is the hook a `stagger` clip drops
   * into on the day somebody authors one, with nothing else to change.
   */
  stagger: 'stagger',
} as const;

/**
 * Which trigger an ability's animation is reached by.
 *
 * One trigger was enough while `slash` was the only attack clip anybody had
 * authored, and it stopped being enough the moment a second one existed: the
 * Hunting Bow is a level-1 weapon a player can equip in the first minute, and
 * with a single `attack` trigger the pig threw a sword chop at things four
 * hundred units away.
 *
 * The rule is **what the ability sends**, not what it is called. An ability
 * that puts an arrow in the air is drawn with a bow; a thrown star and an
 * arcane bolt leave the same way they always have, because nobody has authored
 * a clip for them and a wrong animation is worse than a generic one. That keeps
 * this a fact read off the content table rather than a list of ids to keep in
 * sync with it.
 */
export function attackTriggerFor(abilityId: string | null): string {
  if (abilityId === null) return DRIVEN_PARAMETERS.attack;
  return abilityById(abilityId)?.projectile?.look === 'arrow'
    ? DRIVEN_PARAMETERS.shoot
    : DRIVEN_PARAMETERS.attack;
}

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
 *
 * Being *alive*, by contrast, is a level rather than an edge, and is asserted on
 * every tick rather than on the one the health crossed back: `dead` going false
 * cannot get a body up by itself, because the state it is in is `terminal` and
 * that category has no exit (see {@link UnitMachine.revive}). Reading it as an
 * edge off `previous` would be one dropped frame away from a player spending
 * the rest of the session drawn as a corpse -- and this is the one fact where
 * the machine's own state answers the question better than the last snapshot
 * does, since a machine that is not down has nothing to get up from.
 */
export function driveUnit(
  machine: UnitMachine,
  facts: UnitFacts,
  previous: UnitFacts | null,
  ticks: number,
): readonly FiredEvent[] {
  machine.setParameter(DRIVEN_PARAMETERS.speed, facts.speed);
  machine.setParameter(DRIVEN_PARAMETERS.dead, facts.dead);
  // Before the trigger below, so an attack ordered on the same tick a player
  // respawns is thrown by the body that stood up rather than dropped by the
  // corpse it replaced -- `revive` clears what a terminal state could never
  // consume.
  if (!facts.dead) machine.revive();
  // Written before the trigger, so the swing that is about to start is entered
  // at the right rate rather than a tick of it playing at the old one.
  machine.setActionRate(facts.attackRate);
  if (startedCasting(facts, previous)) machine.trigger(triggerFor(machine, facts.abilityId));
  // Before the step, so a swing called off on this tick cannot fire the impact
  // it was about to (spec 166) -- the machine leaves the state first and events
  // are read off whatever it is in afterwards.
  else if (cancelledCast(facts, previous)) machine.cancelAction();
  // The break is its own edge and is checked after the cast ones rather than
  // beside them (spec 172), because the two can land on the same frame: a body
  // broken mid-wind-up loses its cast on that tick, so `cancelledCast` is also
  // true, and the swing has to be called off *before* the stagger is raised or
  // the machine leaves the stagger state it was just put into. Only a unit that
  // declared the parameter is triggered, the same rule `triggerFor` applies to
  // `shoot`: a silently dropped trigger is better than a machine asked for a
  // state it has not got.
  if (startedStagger(facts, previous) && machine.getParameter(DRIVEN_PARAMETERS.stagger) !== undefined) {
    machine.trigger(DRIVEN_PARAMETERS.stagger);
  }
  return machine.step(ticks);
}

/**
 * The trigger to raise, given what this particular unit can answer.
 *
 * A unitdef with no `shoot` parameter falls back to `attack`, which is what it
 * did before this existed. That matters because the roster is not uniform: the
 * fox and the dev mannequin share this family's clip library and neither has a
 * draw state, and a silently dropped trigger is a body standing perfectly still
 * through its own attack -- a worse outcome than a generic animation, and a
 * much harder one to notice.
 *
 * `getParameter` is the question to ask, because it returns undefined for a
 * parameter the document never declared, which is exactly the condition and is
 * already how `setParameter` decides to ignore one.
 */
function triggerFor(machine: UnitMachine, abilityId: string | null): string {
  const wanted = attackTriggerFor(abilityId);
  if (wanted === DRIVEN_PARAMETERS.attack) return wanted;
  return machine.getParameter(wanted) === undefined ? DRIVEN_PARAMETERS.attack : wanted;
}

/**
 * The rate an attack animation should play at, from the ticks the server sent.
 *
 * `authoredWindupTicks / (releaseTick - startTick)`, which is the attack-speed
 * factor the sim divided the base attack point by -- recovered rather than
 * replicated, because both ends already have the ability table and the ticks.
 *
 * 1 for anything without a live wind-up to measure, and for a span that has not
 * arrived yet: an animation at the authored speed is always a defensible frame,
 * and a division by zero is not.
 */
export function attackRateFrom(
  authoredWindupTicks: number,
  startTick: number,
  releaseTick: number,
): number {
  const span = releaseTick - startTick;
  if (!(span > 0) || !(authoredWindupTicks > 0)) return 1;
  return authoredWindupTicks / span;
}

/**
 * True on the tick a poise break lands, and on no other (spec 172).
 *
 * The edge into `Stunned`, and nothing cleverer: unlike a cast there is no
 * phase to go backwards and no predicted copy on a second clock, because a
 * stagger is something done *to* this body and arrives on the wire whole. A
 * second break cannot land inside the window either -- `STAGGER_IMMUNE_TICKS`
 * is two seconds against a stagger of at most 48 ticks -- so the edge is the
 * only thing there is to detect.
 *
 * False with no `previous`, which is a body seen for the first time. A unit
 * that comes into view already staggered does not swing into the clip halfway
 * through; it is drawn steady until it is broken in front of somebody.
 */
export function startedStagger(facts: UnitFacts, previous: UnitFacts | null): boolean {
  if (facts.activity !== EntityActivity.Stunned) return false;
  return previous !== null && previous.activity !== EntityActivity.Stunned;
}

/**
 * True on the tick a cast begins, and on no other.
 *
 * Three things count as beginning. The obvious one is activity crossing into
 * `Casting`. The second is the phase going *backwards* — from recovery to
 * turning or wind-up — which is what a second swing looks like when it starts
 * before the first has finished replicating, and treating it as a continuation
 * would drop every attack after the first in a chain.
 *
 * The third is a cast appearing where a moment ago there was none, while the
 * activity says `Casting` throughout (spec 166). That is a *withdrawal followed
 * by another attack*, and the two halves are on different clocks: the cast list
 * is predicted and drops the withdrawn cast at once, while the activity is
 * replicated at 20Hz and can easily not move between the two. It used to be
 * unreachable in practice because a withdrawn swing played on regardless and
 * the next attack was drawn by the first one's leftovers; now that the first is
 * cancelled, missing this would leave the body standing perfectly still through
 * an attack it is really making.
 */
export function startedCasting(facts: UnitFacts, previous: UnitFacts | null): boolean {
  if (facts.dead) return false;
  if (facts.activity !== EntityActivity.Casting) return false;
  if (previous === null || previous.activity !== EntityActivity.Casting) return true;
  const from = previous.castPhase;
  const to = facts.castPhase;
  if (to === null) return false;
  if (from === null) return isOpening(to);
  return isOpening(to) && !isOpening(from);
}

/** The phases that begin a swing rather than finish one. */
function isOpening(phase: number): boolean {
  return phase === CastPhaseValue.Turning || phase === CastPhaseValue.Windup;
}

/**
 * True on the tick a cast is called off, and on no other (spec 166).
 *
 * Two facts and a subtraction: the cast is gone, and the last time it was seen
 * it had more than a sampling margin of itself left to run. That is the whole
 * definition of a cancellation from out here -- the sim knows it as
 * `cancelWindup` and `cancelBackswing`, and neither of those distinctions
 * changes what the *animation* should do, which is stop.
 *
 * Read off the cast being gone rather than off the activity, and that is the
 * important half. `castPhase` comes from the cast list, which the client
 * predicts, so a player who withdraws sees their own cast disappear on the frame
 * they asked; `activity` is replicated and is a round trip behind it. Keying on
 * the activity would leave the body finishing a blow it had already been
 * refunded for, for exactly as long as the connection is bad -- and the
 * connection being bad is when a withdrawal matters most.
 *
 * A cast that ran its course is deliberately *not* this. An attack's clip is
 * authored to fit inside its own cast, so a cast ending on time is one whose
 * animation has already finished and there would be nothing to cancel; where
 * that is not true -- an ability borrowing another attack's clip, as the arcane
 * bolt borrows the sword's -- cutting the tail off every cast of it would be a
 * regression rather than a fix.
 */
export function cancelledCast(facts: UnitFacts, previous: UnitFacts | null): boolean {
  if (previous === null || facts.castPhase !== null || previous.castPhase === null) return false;
  return (previous.castTicksLeft ?? 0) > FINISHED_WITHIN_TICKS;
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

/**
 * What a body's speed is, kept on the sim's clock (spec 118).
 *
 * The drawn distance divided by the frame delta is the obvious way to measure
 * this and it is wrong, because the two are on different clocks. A body's drawn
 * position only moves on a frame that drained a 60Hz tick -- the local player's
 * because prediction advances a tick at a time, a remote one's because the
 * interpolator has no new sample to walk toward. Above 60fps most frames drain
 * no tick at all, so most frames measured a real distance of zero over a real
 * delta and reported a standing body.
 *
 * That was invisible in the state machine, which only evaluates transitions on
 * a tick and so never saw the zero. It was extremely visible in the blend tree,
 * which is read on *every* frame: at 120Hz the pig alternated between its run
 * pose and frame 0.02 of a fifteen-second idle, every other frame.
 *
 * So distance accumulates on the frame clock and the division happens on the
 * tick clock, and a frame that drained nothing holds the last answer rather
 * than inventing a stop.
 */
export interface SpeedClock {
  /** Drawn distance since the last tick-bearing frame. */
  readonly pending: number;
  /** World units per second, measured over whole ticks. */
  readonly speed: number;
}

/** A body that has not moved yet. */
export const STOPPED: SpeedClock = { pending: 0, speed: 0 };

/**
 * Folds one frame's drawn travel in, and takes the quotient when a tick landed.
 *
 * `ticks` is what the frame's accumulator actually drained, the same number the
 * machine steps by. Dividing by `ticks * tickSeconds` rather than by the frame
 * delta is the whole point: the numerator is however many ticks' worth of
 * travel the drawn position picked up, so the denominator has to be those same
 * ticks and not the wall-clock time it took to notice them.
 */
export function advanceSpeed(
  clock: SpeedClock,
  travelled: number,
  ticks: number,
  tickSeconds: number,
): SpeedClock {
  const moved = Number.isFinite(travelled) && travelled > 0 ? travelled : 0;
  const pending = clock.pending + moved;
  const whole = Math.max(0, Math.floor(ticks));
  if (whole === 0 || !(tickSeconds > 0)) return { pending, speed: clock.speed };
  return { pending: 0, speed: pending / (whole * tickSeconds) };
}

/**
 * How fast the blend parameter is allowed to move, in speed units per second.
 *
 * 1000, so the run threshold of 150 is reached from a standstill -- or given up
 * -- in 150ms, which is the duration the unitdefs author their locomotion
 * transitions at. Tying the two together is the point: the parameter and the
 * cross-fade it feeds should take the same time, or one of them is visible on
 * its own and reads as a cut.
 */
export const BLEND_SLEW_PER_SECOND = 1000;

/**
 * Moves the blend parameter toward the measured speed at a bounded rate (spec 119).
 *
 * The machine has two kinds of blend and only one is time-based. A state
 * transition fades over ticks; a blend tree is a pure function of its
 * parameter, evaluated live -- for the *outgoing* layer of a transition as much
 * as the incoming one. The sim has no acceleration, so speed steps between 0
 * and full in a single tick, and those two facts do not compose:
 *
 * Setting off, the step lands on exactly the value the cross-fade is heading
 * to, so the fade does the work and the step is invisible. Stopping, the
 * outgoing layer stops being a run before the transition it is the outgoing
 * half of has done anything -- the tree reads zero and emits the idle clip, so
 * the run pose is not faded out, it is simply not there. The cross-fade then
 * blends idle into idle for 150ms and looks like a cut.
 *
 * A rate limit rather than an exponential decay, so the settle time is a number
 * somebody chose rather than one that emerges from a half-life -- and so it can
 * be the *same* number as the transition's. Advanced on `ticks` rather than on
 * the frame delta for the reason spec 118 exists: a frame that drained no tick
 * must not advance a signal the sim clock owns.
 *
 * Both directions, not only the fall. Damping one way would fix the symptom and
 * leave the two paths different in kind, which is what made this hard to see.
 * Rising it cannot be seen anyway: `speed > 5` is crossed inside the first
 * tick, and the tree then walks up through the walk band under a cross-fade
 * that is already running.
 */
export function slewSpeed(
  current: number,
  target: number,
  ticks: number,
  tickSeconds: number,
  rate: number = BLEND_SLEW_PER_SECOND,
): number {
  const from = Number.isFinite(current) ? current : 0;
  const to = Number.isFinite(target) ? target : 0;
  const whole = Math.max(0, Math.floor(ticks));
  if (whole === 0 || !(tickSeconds > 0) || !(rate > 0)) return from;

  const step = rate * whole * tickSeconds;
  const delta = to - from;
  if (Math.abs(delta) <= step) return to;
  return from + Math.sign(delta) * step;
}

/**
 * Whether a unit shows its own death, so the scene must not show it as well.
 *
 * The scene squashes a corpse to 0.6 so a kill reads. That is the right answer
 * for the procedural rigs, which have no death clip: a body that stopped where
 * it stood is otherwise indistinguishable from one standing still. An authored
 * unit with a `terminal` state falls over by itself, and squashing it too drew
 * the pig at half size for the whole of its collapse, then snapped it back to
 * full size the moment it was alive again.
 *
 * Asked of the *document* rather than of the state the machine is in this
 * frame. Both answer the question for a body that died while being watched;
 * only this one answers it for a corpse that was already on the ground when the
 * client joined, whose machine spends its first frame in the entry state and
 * would pop from squashed to full size as it caught up.
 *
 * `terminal` is the category for a state that is never left, which for a living
 * body is not a thing to be in -- so a unit that declares one is a unit that
 * has somewhere to fall.
 */
export function hasDeathAnimation(unit: UnitDef): boolean {
  return unit.stateMachine.states.some((state) => state.category === 'terminal');
}
