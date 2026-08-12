/**
 * The white chunk a blow leaves on a floating health bar (spec 145).
 * Pure -- no three.js, no DOM, and time is an argument.
 *
 * A bar has three flat states: the fill a body still has, the ground it gave up
 * a moment ago, and black. The fill retreats the instant the server says so --
 * it is replicated health and nothing here delays it -- and the ground behind it
 * stays lit for a beat so the size of the blow is readable off the bar itself
 * rather than only off the number floating away from it.
 *
 * The one rule with a decision in it is the *throttle*. A fast weapon lands
 * inside the effect's own lifetime, and a chunk that restarted per hit would
 * strobe: three hits in a third of a second would be three white slivers, each
 * cancelling the last, and a burst would read as noise rather than as a big
 * chunk. So the first blow of a burst opens a window and every blow inside it
 * grows the *same* chunk, which resolves once, `FLASH_HOLD_MS` after that first
 * blow. That is a leading-edge throttle and deliberately not a debounce: under a
 * debounce a body taking sustained fire would hold a growing white chunk
 * forever and never resolve it, which is the state that reads as a bug.
 *
 * Nothing here knows what a bar looks like. It answers with two fractions and
 * `hud.ts` owns the elements, the same division the damage numbers already have.
 */

/**
 * How long the lost chunk is held before it starts to go, and -- the same
 * number, because it is the same window -- how long a burst has to land inside
 * to be counted as one blow.
 */
export const FLASH_HOLD_MS = 375;

/**
 * How long the white takes to retreat onto the fill, once the hold is over.
 *
 * A duration rather than a speed, so the retreat lasts the same whether the
 * chunk was a scratch or half the bar. A speed would make a small chunk vanish
 * before the eye caught it, which defeats the reason the chunk exists.
 */
export const FLASH_DRAIN_MS = 220;

/**
 * The flinch (spec 146): how long a blow knocks the bar for, how far the
 * biggest one throws it, and how fast it rattles while it settles.
 *
 * 15Hz over 200ms is three cycles, and the rate is picked against the *sampling*
 * rather than by eye: the sim runs at 60Hz, and an oscillation much above this
 * is sampled barely twice a cycle, which draws an erratic stagger instead of a
 * rattle. The distance is small on purpose -- the bar hangs over a head and has
 * to still be over that head afterwards.
 */
export const SHAKE_MS = 200;
export const SHAKE_PIXELS = 2.6;
export const SHAKE_HZ = 15;

/**
 * The blow, as a fraction of the body's own health, that kicks at full strength.
 *
 * A fraction rather than a number of points, because the bar is a fraction: a
 * 30-damage hit is a scratch on a boss and most of a Grazer, and the flinch
 * should say which of those just happened.
 */
const SHAKE_FULL_BLOW = 0.25;

/** What even the smallest blow is worth, so a scratch still registers. */
const SHAKE_FLOOR = 0.35;

/** What to draw for one body this frame. */
export interface BarFill {
  /** The fill the body still has, 0..1. */
  readonly health: number;
  /** Where the white ends, 0..1. Never below `health`. */
  readonly ghost: number;
  /** CSS pixels to add to where the bar is placed, sideways (spec 146). */
  readonly shakeX: number;
  /** CSS pixels to add to where the bar is placed, vertically. */
  readonly shakeY: number;
}

/** A bar with nothing to say: no chunk, no kick. */
const STILL = { shakeX: 0, shakeY: 0 } as const;

/**
 * One body's memory. Health is kept in health units rather than as a fraction
 * so that a changing `maxHealth` -- a level, a buff -- cannot read as a blow.
 */
interface Track {
  health: number;
  /** Where the white ended when the window opened, in health units. */
  ghost: number;
  /** When the window opened, or null when there is nothing to draw. */
  since: number | null;
  /**
   * When the last blow landed, or null once its kick is spent.
   *
   * Separate from `since` because the two rules disagree on purpose (spec 146):
   * the chunk is a measurement and merges across a burst, the kick is a contact
   * and does not.
   */
  struck: number | null;
  /** How hard the last blow was, 0..1 of full strength. */
  force: number;
}

/** Clamp into 0..1, and answer 0 for a NaN rather than passing one to the DOM. */
function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export class HealthFlashes {
  private readonly tracks = new Map<number, Track>();

  /**
   * Read one body's bar, and notice any damage since the last read.
   *
   * Called once per body per frame from the same loop that places the bars, so
   * "since the last read" is "since the last frame this body was on screen".
   * A body that was off screen for a while comes back with its flash already
   * resolved, which is right: the chunk marks a blow you were watching.
   */
  read(id: number, health: number, maxHealth: number, nowMs: number): BarFill {
    const max = maxHealth > 0 ? maxHealth : 0;
    const now = Number.isFinite(nowMs) ? nowMs : 0;
    const current = Math.max(0, Math.min(max, Number.isFinite(health) ? health : 0));

    const track = this.tracks.get(id);
    if (!track) {
      // First sight of a body is never a blow: a monster that spawns already
      // wounded, or one that walks into view mid fight, must not flash for
      // damage nobody here saw land.
      this.tracks.set(id, {
        health: current,
        ghost: current,
        since: null,
        struck: null,
        force: 0,
      });
      const seen = unit(max > 0 ? current / max : 0);
      return { health: seen, ghost: seen, ...STILL };
    }

    if (current < track.health) {
      // A blow. Only open a window if one is not already running: inside the
      // hold the chunk simply grows, because `ghost` is already back at the
      // health this burst started from and the fill has just dropped further.
      const phase = this.phase(track, now);
      if (phase !== 'hold') {
        // Idle, or part-way through a retreat. Either way the white starts from
        // wherever it is drawn *right now* -- taking the pre-blow health instead
        // would jump a half-drained chunk back up the bar.
        track.ghost = Math.max(this.ghostAt(track, now), current);
        track.since = now;
      }
      // The kick, on the other hand, restarts on *every* blow (spec 146). It is
      // contact rather than measurement: a burst that grows one chunk is still
      // three separate hits, and a bar under sustained fire should rattle.
      track.struck = now;
      const blow = max > 0 ? (track.health - current) / max : 0;
      track.force = Math.max(SHAKE_FLOOR, Math.min(1, blow / SHAKE_FULL_BLOW));
    } else if (current > track.health) {
      // A heal. The fill may have caught the white up; if it has, there is
      // nothing left to say and the window closes rather than pinning a chunk
      // above the fill for the rest of its hold.
      if (current >= track.ghost) {
        track.ghost = current;
        track.since = null;
      }
    }

    track.health = current;

    // Once a flash has fully resolved, forget it, so a body that is never hit
    // again is not re-deciding a phase every frame for the rest of the session.
    if (track.since !== null && this.phase(track, now) === 'done') {
      track.since = null;
      track.ghost = current;
    }

    const fill = max > 0 ? current / max : 0;
    const ghost = max > 0 ? this.ghostAt(track, now) / max : 0;
    const drawnFill = unit(fill);
    return {
      health: drawnFill,
      ghost: Math.max(drawnFill, unit(ghost)),
      ...this.shakeAt(track, now),
    };
  }

  /**
   * Drop every body not in `live`.
   *
   * The bars themselves are removed the same frame by the same set, and a
   * session kills monsters without end -- a map that only ever grew would be a
   * slow leak keyed by entity id.
   */
  retain(live: ReadonlySet<number>): void {
    for (const id of [...this.tracks.keys()]) {
      if (!live.has(id)) this.tracks.delete(id);
    }
  }

  /** How many bodies are remembered. For tests, and for anyone counting. */
  get tracked(): number {
    return this.tracks.size;
  }

  /**
   * How far the bar is knocked off its anchor right now, in CSS pixels.
   *
   * A decaying oscillation on `cos`, not `sin`, so the bar is *already*
   * displaced in the frame the blow lands -- a kick that started from zero and
   * swung out a quarter cycle later would put the biggest movement 17ms after
   * the hit, which is exactly late enough to stop reading as contact.
   *
   * The envelope is quadratic rather than exponential for one reason: it
   * reaches zero *at* `SHAKE_MS` instead of approaching it, so the bar settles
   * onto its anchor rather than snapping the last fraction of a pixel back when
   * the kick is dropped.
   */
  private shakeAt(track: Track, now: number): { shakeX: number; shakeY: number } {
    if (track.struck === null) return STILL;
    const elapsed = now - track.struck;
    // A clock that stepped backwards holds the kick's start rather than
    // producing a phase from a negative time.
    if (elapsed < 0) return { shakeX: SHAKE_PIXELS * track.force, shakeY: 0 };
    if (elapsed >= SHAKE_MS) {
      track.struck = null;
      return STILL;
    }
    const left = 1 - elapsed / SHAKE_MS;
    const envelope = left * left;
    const angle = (2 * Math.PI * SHAKE_HZ * elapsed) / 1000;
    const amplitude = SHAKE_PIXELS * track.force * envelope;
    // Vertically at less than half, because a bar that jumps as far up as it
    // does sideways reads as the body moving rather than as the bar being hit.
    return { shakeX: amplitude * Math.cos(angle), shakeY: amplitude * 0.4 * Math.sin(angle) };
  }

  /** Where the white ends right now, in health units. */
  private ghostAt(track: Track, now: number): number {
    const phase = this.phase(track, now);
    if (phase === 'idle' || phase === 'done') return track.health;
    if (phase === 'hold') return Math.max(track.ghost, track.health);
    const elapsed = now - (track.since ?? now) - FLASH_HOLD_MS;
    const left = 1 - elapsed / FLASH_DRAIN_MS;
    return Math.max(track.health, track.health + (track.ghost - track.health) * left);
  }

  private phase(track: Track, now: number): 'idle' | 'hold' | 'drain' | 'done' {
    if (track.since === null) return 'idle';
    const elapsed = now - track.since;
    // A clock that went backwards -- an `estimatedTick` corrected downwards --
    // holds rather than resolving early or dividing by a negative.
    if (elapsed < FLASH_HOLD_MS) return 'hold';
    if (elapsed < FLASH_HOLD_MS + FLASH_DRAIN_MS) return 'drain';
    return 'done';
  }
}
