/**
 * What a poise break does to the body it broke (spec 173).
 *
 * Spec 147 built the stagger and spec 173 gave it teeth: for `staggerTicks` the
 * body cannot walk, turn or swing. That is a real thing happening to a player,
 * and until this file existed it was drawn exactly like standing still -- the
 * server refused every input and the screen said nothing about why.
 *
 * This is the channel that needs no authored content. `unit-driver.ts` also
 * raises a `stagger` trigger for units that have a clip for it, and no unit in
 * the tree has one today, so on its own that channel is silent. A rocked body
 * is not a substitute for an animation; it is the part that works on every rig
 * in the game, including the procedural critters and the mech, on the day the
 * gate lands.
 *
 * Three rules, and the first two are the opposite of each other on purpose:
 *
 *  - **The window is replicated, the start is observed.** How long the body is
 *    held for comes off the wire (`activityUntilTick`), because it varies with
 *    the breaker's Strength and a guessed length would draw a body settling
 *    before it can move or after it already has. *When* it began is the edge
 *    into `Stunned` that this client actually saw. That is deliberately not
 *    derived from `activityUntilTick` minus a constant: a client that arrives
 *    mid-stagger, or reconnects through one, never saw the contact and must not
 *    invent one. The margin runs the same way spec 158's loot pop runs it -- a
 *    missed flinch on a stagger nobody watched costs nothing, where a flinch on
 *    a body that was already staggered is the screen reporting a blow that did
 *    not land in front of anybody.
 *  - **A break is a contact, so every break restarts it.** Spec 146's rule for
 *    the health bar's kick, and the same rule here for the same reason -- and
 *    the opposite of the white chunk beside it, which merges across a burst
 *    because it is a measurement. In practice a second break inside the window
 *    is impossible (`STAGGER_IMMUNE_TICKS` is two seconds and the longest
 *    stagger is 48 ticks), so this is a statement about which of the two
 *    vocabularies this belongs to rather than a case anybody will hit.
 *  - **Time is an argument, and it is the drawn tick.** The same tick the
 *    bodies over it are interpolated by, never a second clock -- so a flinch is
 *    a pure function of a tick count and lands identically at 30fps and 144.
 *    Ticks rather than milliseconds because both numbers it is measured against
 *    are ticks already, and a conversion in here would be a place for the two
 *    to drift.
 *
 * Pure. No three.js, no DOM: `scene.ts` adds what this returns to the drawn
 * transform and decides nothing itself.
 */

import { EntityActivity } from '../../../server/net/protocol.js';

/**
 * How hard the body is thrown, in radians, and how fast it rattles as it
 * settles.
 *
 * The rate is picked against the sampling rather than by eye, exactly as
 * `SHAKE_HZ` is: this is read once per drawn frame, and an oscillation much
 * above 9Hz is sampled barely twice a cycle on a 30fps machine, which draws an
 * erratic jitter instead of a body being rocked. It is slower than the bar's
 * 15Hz because it is a heavier thing moving -- a bar is a graphic and a body
 * has mass, and matching them exactly would make the body look like a label.
 */
export const FLINCH_HZ = 9;

/**
 * The yaw thrown at the moment of contact, in radians (~11 degrees).
 *
 * Small, and bounded by something real: the body is rooted for this whole
 * window, so whatever this adds to the drawn heading is a lie about which way
 * the body is facing that no server tick will correct. Eleven degrees is inside
 * the tolerance spec 142 already accepts between the drawn heading and the
 * authoritative one, so a stagger cannot make a body's facing read wrongly
 * enough to matter for the blow that follows it.
 */
export const FLINCH_YAW = 0.19;

/**
 * The backward rock, in radians (~6 degrees).
 *
 * Under half the yaw, for the reason the bar's vertical shake is under half its
 * horizontal one: a body that pitches as far as it swings reads as falling
 * over, and this is a stagger rather than a knockdown.
 */
export const FLINCH_PITCH = 0.1;

/** Ticks per second the drawn clock runs at, for the oscillation's phase. */
const TICK_RATE = 60;

/** What to add to one body's drawn transform this frame. */
export interface Flinch {
  /** Radians to add to the drawn yaw. */
  readonly yaw: number;
  /** Radians to rock the body back about its own lateral axis. */
  readonly pitch: number;
}

/** A body holding its own: nothing to add. */
export const STEADY: Flinch = { yaw: 0, pitch: 0 };

interface Track {
  /** Whether this body was inside a break's window when last read. */
  broken: boolean;
  /** The drawn tick the edge into `Stunned` was seen on, or null once spent. */
  since: number | null;
  /** How long the window is, in ticks, as the wire described it at the edge. */
  ticks: number;
}

/**
 * One flinch per body, tracked across frames.
 *
 * The same shape as {@link HealthFlashes}, and for the same reason: the edge
 * that starts it is "changed since the last time this body was read", which
 * only something holding the previous read can answer.
 */
export class StaggerFlinches {
  private readonly tracks = new Map<number, Track>();

  /** How many bodies are being tracked. Diagnostics, and a leak check. */
  get tracked(): number {
    return this.tracks.size;
  }

  /**
   * Read one body's flinch, and notice any break since the last read.
   *
   * Called once per body per frame from the loop that draws them, so "since the
   * last read" is "since the last frame this body was on screen".
   */
  read(id: number, activity: number, activityUntilTick: number, drawnTick: number): Flinch {
    const now = Number.isFinite(drawnTick) ? drawnTick : 0;
    const until = Number.isFinite(activityUntilTick) ? activityUntilTick : 0;
    const broken = activity === EntityActivity.Stunned && now < until;

    const track = this.tracks.get(id);
    if (!track) {
      // First sight of a body is never a contact. A body that walks into view
      // already staggered is drawn steady, which is right: this marks a break
      // somebody watched land.
      this.tracks.set(id, { broken, since: null, ticks: 0 });
      return STEADY;
    }

    // The edge, and the only place a flinch starts. `broken && !track.broken`
    // rather than `broken` alone: the window is many ticks long and a start
    // recorded on each of them would hold the body at full amplitude for the
    // whole stagger and then drop it, which reads as a stutter rather than a
    // blow.
    if (broken && !track.broken) {
      track.since = now;
      track.ticks = Math.max(1, Math.round(until - now));
    }
    track.broken = broken;

    return this.flinchAt(track, now);
  }

  /** Drops a body's track. Called when its rig goes away, so this cannot grow. */
  forget(id: number): void {
    this.tracks.delete(id);
  }

  /**
   * Keeps only the bodies still in the world, the same shape `TurnEase` uses.
   *
   * A per-entity map in a render loop is a leak unless something prunes it, and
   * the pruning has to be "who is still here" rather than "who died": an entity
   * that goes out of interest range is removed from the view without ever being
   * marked dead.
   */
  retain(live: ReadonlySet<number>): void {
    for (const id of this.tracks.keys()) if (!live.has(id)) this.tracks.delete(id);
  }

  /**
   * How far the body is thrown right now.
   *
   * A decaying oscillation on `cos`, not `sin`, so the body is *already*
   * displaced on the frame the break lands -- spec 146's reasoning for the
   * bar's kick, and it applies harder here, because a stagger is the one moment
   * the player is being told they have lost control and a reaction a quarter
   * cycle late reads as unrelated to the hit.
   *
   * The envelope is quadratic rather than exponential so it reaches zero *at*
   * the end of the window instead of approaching it: the body settles onto its
   * real heading on the tick it gets to move again, rather than snapping the
   * last fraction of a degree back when the track is dropped.
   */
  private flinchAt(track: Track, now: number): Flinch {
    if (track.since === null) return STEADY;
    const elapsed = now - track.since;
    // A clock that stepped backwards holds the start rather than producing a
    // phase from a negative time. The value returned is exactly what `elapsed
    // === 0` produces, so the guard is a clamp rather than a third shape: the
    // yaw is already out at full throw and the pitch has not started, which is
    // what `cos` and `sin` say at zero.
    if (elapsed < 0) return { yaw: FLINCH_YAW, pitch: 0 };
    if (elapsed >= track.ticks) {
      track.since = null;
      return STEADY;
    }
    const left = 1 - elapsed / track.ticks;
    const envelope = left * left;
    const angle = (2 * Math.PI * FLINCH_HZ * elapsed) / TICK_RATE;
    return {
      yaw: FLINCH_YAW * envelope * Math.cos(angle),
      pitch: FLINCH_PITCH * envelope * Math.sin(angle),
    };
  }
}
