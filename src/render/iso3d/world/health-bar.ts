/**
 * The white chunk a blow leaves on a floating health bar (spec 143).
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

/** What to draw for one body this frame. Both fractions of the full bar. */
export interface BarFill {
  /** The fill the body still has, 0..1. */
  readonly health: number;
  /** Where the white ends, 0..1. Never below `health`. */
  readonly ghost: number;
}

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
      this.tracks.set(id, { health: current, ghost: current, since: null });
      const seen = unit(max > 0 ? current / max : 0);
      return { health: seen, ghost: seen };
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
    return { health: drawnFill, ghost: Math.max(drawnFill, unit(ghost)) };
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
