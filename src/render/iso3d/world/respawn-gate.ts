/**
 * Whether the world under a respawning player has arrived yet (spec 281).
 *
 * A respawn puts the body somewhere it has never been: the server answers with
 * a `Correction` carrying `CorrectionReason.Teleport`, spec 067 snaps it, and on
 * that same frame the player is standing at `DEFAULT_SPAWN` — several hundred
 * units and a whole request window away from every chunk this client holds.
 * `requestChunks` asks for that ground off the *next* delta, so what is on
 * screen in between is a void with a player in it, and what follows is 25
 * chunks inserting, meshing and composing their prop regions into frames that
 * are being drawn.
 *
 * {@link LoadGate} already knows how to answer "has the ground around the
 * player arrived", and deliberately **latches** so it can never answer it
 * twice: its own header says walking into unstreamed ground is an ordinary
 * streaming problem, and that covering the screen for it would be a fog rather
 * than a loading screen.
 *
 * That rule is right and does not move. **A respawn is not walking.** It is a
 * discrete jump, to a place the server chooses, asked for by a button — which
 * is why this gate is armed by the *press* and by nothing else. A gate that
 * armed itself off thin ground would be exactly the fog the boot gate refuses
 * to be; a gate armed by a button cannot fire while nobody has pressed one.
 *
 * Pure, and time is an argument. Presentation only: nothing here reaches the
 * sim, the wire carries nothing new, and the same seed and inputs produce the
 * same authoritative state whether the cover is up or down.
 */

import { hasGlyph } from './pixel-font.js';

/** What the return is waiting on, in the order it waits on them. */
export type RespawnPhase = 'asking' | 'arriving';

export interface RespawnGateInput {
  /** The frame's timestamp, straight from `requestAnimationFrame`. */
  readonly nowMs: number;
  /** Whether the local body is dead, straight off `ClientView.selfDead`. */
  readonly dead: boolean;
  /** Ground the map declares within the ready radius of where the body stands. */
  readonly needed: number;
  /** How many of those are held. */
  readonly held: number;
  /** Arrivals not yet drawn: mesh replies in flight plus prop regions owed. */
  readonly meshPending: number;
}

export interface RespawnCover {
  readonly phase: RespawnPhase;
  /** What the banner shouts. Constant across a return -- see {@link COVER_LABEL}. */
  readonly label: string;
  /** One line under the bar saying what is being waited for. */
  readonly detail: string;
  /** 0..1, and never smaller than it was within one return. */
  readonly fraction: number;
  /** Whole seconds until the gate gives up and shows the world anyway. */
  readonly secondsLeft: number;
}

/**
 * How long the world may be covered for one return.
 *
 * A bail-out rather than a wait. On the shipped map the whole request window is
 * one `MAP_CHUNK_BURST` -- 25 chunks, served in a single burst -- and a return
 * settles in well under a second. What this covers is the cases the stream
 * cannot: a respawn the server refused, a chunk reply that never came, ground
 * the map declares outside the serve radius. The world is never permanently
 * covered, whatever the stream does.
 */
export const RESPAWN_COVER_TIMEOUT_MS = 12_000;

/**
 * How near the deadline the countdown appears.
 *
 * A message rather than a threshold. A number counting down from twelve reads
 * as *you must wait twelve seconds to respawn*, which is a punishment nobody
 * wrote; the same number appearing only once something has gone slowly reads as
 * what it is, which is a promise that this ends.
 */
export const COUNTDOWN_VISIBLE_MS = 5_000;

/**
 * The word over a return.
 *
 * One word for both phases, deliberately: a banner that changes mid-wait is
 * noise, and which half of the return we are in is the detail line's business.
 */
export const COVER_LABEL = 'RESPAWNING';

/** What the detail line says while the server has not answered yet. */
export const ASKING_DETAIL = 'WAITING FOR THE SERVER';

/** ...and once the ground is all in but not all drawn. */
export const BUILDING_DETAIL = 'BUILDING THE WORLD';

/**
 * The share of the bar the chunk stream owns.
 *
 * {@link LoadGate}'s own split and for its reason: the rest is the meshing
 * tail, which is real time and would otherwise be a bar sitting at 100% while
 * the page is visibly still working.
 */
const STREAM_SHARE = 0.9;

export class RespawnGate {
  private armed = false;
  private deadlineMs = 0;
  private best = 0;
  /** Whether this return has seen the body alive, so a second death is legible. */
  private sawAlive = false;

  /**
   * The player pressed RESPAWN. The only thing that arms this gate.
   *
   * And the only thing that moves it from outside: there is deliberately no way
   * to disarm it. A cover a caller could take down is a cover with two answers
   * to when the world comes back, and the interesting case -- the socket
   * dropping mid-return -- wants it to *stay*, since the body is still standing
   * on ground that has not arrived and the reconnect banner is above everything
   * anyway. What bounds every one of those cases is the deadline, which is one
   * rule that always fires rather than a list of exits somebody has to keep
   * complete.
   */
  ask(nowMs: number): void {
    this.armed = true;
    this.deadlineMs = nowMs + RESPAWN_COVER_TIMEOUT_MS;
    this.best = 0;
    this.sawAlive = false;
  }

  /**
   * What to draw over the world, or null.
   *
   * Null rather than a covered flag, the shape `deathOverlay` returns and for
   * its reason: there is one thing a caller does with this, so a value that can
   * be present and not covering is a value with an extra way to be wrong.
   */
  read(input: RespawnGateInput): RespawnCover | null {
    if (!this.armed) return null;

    // Ordered before everything else, because it is the one case where the
    // cover must come *down* rather than lift: a second death belongs under the
    // death banner, not under a return that is not happening.
    if (input.dead && this.sawAlive) {
      this.armed = false;
      return null;
    }

    const remainingMs = Math.max(0, this.deadlineMs - input.nowMs);
    // The bail-out, asked once and above both halves: a respawn the server never
    // answered and a chunk reply that never came are the same failure from the
    // player's side, which is a world that does not come back.
    if (remainingMs === 0) {
      this.armed = false;
      return null;
    }
    const secondsLeft = Math.ceil(remainingMs / 1000);

    if (input.dead) {
      // Coverage is deliberately *not* consulted here. Until the teleport has
      // landed the body is still standing at the death site, whose ground is
      // fully held -- so a gate that read the chunks first would report a
      // finished return on the frame before the one that moves the player.
      //
      // Which frame that is, is settled by the server rather than hoped for:
      // `respawn()` sends the `Correction` synchronously inside the message
      // handler and the health rides the next 20Hz delta over the same ordered
      // channel, so the teleport is never seen after the heal.
      return {
        phase: 'asking',
        label: COVER_LABEL,
        detail: this.detailFor(ASKING_DETAIL, remainingMs, secondsLeft),
        fraction: this.best,
        secondsLeft,
      };
    }

    this.sawAlive = true;
    const short = input.needed > 0 && input.held < input.needed;
    const owed = input.meshPending > 0;
    // Dying next to the spawn is a return with nothing to wait for, and it lifts
    // on the first frame -- which is the same answer for the same reason the
    // boot gate gives when a chunk count is already complete.
    if (!short && !owed) {
      this.armed = false;
      return null;
    }

    // {@link STREAM_SHARE} and no tail term: the last tenth belongs to the
    // meshing, and the only state in which the meshing is done is the one this
    // returned from a line above -- so the bar sits at 90% while the world is
    // being built and is gone the instant it is. Written as the one term it is
    // rather than as a sum with a branch that can never be taken.
    const stream =
      input.needed > 0 ? Math.min(1, input.held / input.needed) * STREAM_SHARE : STREAM_SHARE;
    // Clamped upward against everything seen before, {@link LoadGate}'s rule and
    // its reason: `needed` comes from a live map and moves as the body settles,
    // and a denominator that grows would walk the bar backwards.
    this.best = Math.max(this.best, stream);
    return {
      phase: 'arriving',
      label: COVER_LABEL,
      detail: this.detailFor(
        short ? `${String(input.held)} / ${String(input.needed)} CHUNKS` : BUILDING_DETAIL,
        remainingMs,
        secondsLeft,
      ),
      fraction: this.best,
      secondsLeft,
    };
  }

  private detailFor(detail: string, remainingMs: number, secondsLeft: number): string {
    if (remainingMs > COUNTDOWN_VISIBLE_MS) return detail;
    return `SHOWING THE WORLD IN ${String(secondsLeft)}`;
  }
}

/**
 * Whether the face can draw `text`.
 *
 * Exported for the test that walks every string this module can produce: the
 * 5x7 face has one case and a fixed symbol set, and a character with no glyph
 * draws as a solid block rather than failing -- so "it is drawable" is a claim
 * that has to be asserted rather than looked at.
 */
export function coverTextDrawable(text: string): boolean {
  return [...text].every((character) => hasGlyph(character));
}
