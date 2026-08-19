/**
 * The client half of the prediction contract (spec 056), as a pure buffer.
 *
 * This is the piece a networked renderer needs and `src/render/` does not yet
 * have. It is deliberately free of transport and of rendering: it holds the
 * unacknowledged inputs, applies them locally the moment they are produced,
 * and knows how to rebuild the local position from a server correction.
 *
 * The rule it implements, from PROTOCOL.md:
 *
 *  1. apply each input locally at once, and keep it, keyed by `seq`
 *  2. every delta carries `ackInputSeq`; drop everything at or below it
 *  3. a correction is authoritative *as of* its `inputSeq` -- snap to it, then
 *     replay every input after it through the same local step function
 *  4. no correction means the prediction was good enough. Do nothing at all --
 *     no snap, and no reason to ask the server anything
 *
 * Step 3 is the whole reason the inputs are kept rather than just the position:
 * a correction describes the world several ticks ago, and naively snapping to it
 * would throw away every input the player has made since, which reads as the
 * character being yanked backwards.
 *
 * Spec 067 splits step 3 in two. A correction is still adopted *exactly* -- the
 * position this buffer reports to the server is always authoritative-plus-replay
 * and never a compromise -- but a **drift** correction, the small kind the server
 * now sends as soon as it notices any disagreement at all, keeps the difference
 * as a visual offset and eases it to nothing over a few ticks. So the state is
 * right immediately and the *picture* catches up smoothly, which is what lets
 * error be corrected continuously instead of being allowed to pile up until it
 * is worth a snap.
 */

import { pushOutOfObstacles, slideCircle } from '../../sim/collision.js';
import type { WorldColliders } from '../../sim/types.js';
import { isWalkable } from '../sim/movement.js';
import type { TerrainSampler } from '../world/terrain.js';

export interface PredictedInput {
  readonly seq: number;
  readonly moveX: number;
  readonly moveY: number;
  readonly facing: number;
  readonly buttons: number;
  /**
   * How fast the body could move on the tick this input was made for, as a
   * fraction of its own speed (spec 184). Absent is 1.
   *
   * On the *input* rather than on the predictor, because a slow is a timed
   * state: a predictor built with one scale would keep it for the whole
   * session, and a **replay** of buffered inputs after a correction has to walk
   * each of them at the speed that applied when it was sent rather than at the
   * speed that applies now.
   */
  readonly moveScale?: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Local movement: the client's best guess at what the server will do with one
 * input. It does not have to be perfect -- divergence is what corrections are
 * for -- but the closer it is, the fewer corrections arrive.
 */
export type PredictStep = (from: Point, input: PredictedInput) => Point;

/**
 * Open-ground prediction: walk one tick of `speed` along the input direction.
 * Matches the server exactly away from walls, water and cliffs, which is where
 * a player spends nearly all of their time -- so corrections stay rare enough
 * that seeing one is informative.
 */
export function createFlatPredictor(speed: number, tickRate: number): PredictStep {
  const perTick = speed / tickRate;
  return (from, input) => {
    const length = Math.hypot(input.moveX, input.moveY);
    if (length <= 1e-6) return from;
    const scale = (length > 1 ? 1 / length : 1) * perTick * (input.moveScale ?? 1);
    return { x: from.x + input.moveX * scale, y: from.y + input.moveY * scale };
  };
}

/**
 * Prediction against the world the server is actually colliding against
 * (spec 063).
 *
 * The flat predictor above walks through walls and off cliffs and lets the
 * server put it back, which is fine at 100 units of open ground and terrible in
 * a forest -- and the iso renderer draws the forest. Every tree is a place the
 * flat guess keeps walking and the server does not, so the correction threshold
 * is crossed and the player is snapped backwards out of a trunk they can see.
 *
 * This runs the same three steps the server's `resolveMovement` does, against
 * the same colliders and the same heightfield, from `buildWorld`. It is not
 * exact -- it does not know about another body pressing on it, which is the
 * server's alone -- but it agrees everywhere terrain and vegetation are the only
 * thing in the way, which is where the corrections were coming from.
 */
export function createWorldPredictor(options: {
  readonly world: WorldColliders;
  readonly terrain: TerrainSampler;
  readonly radius: number;
  readonly speed: number;
  readonly tickRate: number;
}): PredictStep {
  const perTick = options.speed / options.tickRate;
  return (from, input) => {
    const length = Math.hypot(input.moveX, input.moveY);
    if (length <= 1e-6) return from;
    const scale = (length > 1 ? 1 / length : 1) * perTick * (input.moveScale ?? 1);
    const dx = input.moveX * scale;
    const dy = input.moveY * scale;

    let landed = slideCircle(from, dx, dy, options.radius, options.world);

    // The heightfield half, mirroring the server: try each axis alone before
    // refusing, so running along a shoreline slides instead of sticking.
    //
    // Skipped entirely across ground this sampler admits it does not have
    // (spec 146). A streaming client's unarrived ground does not sample as
    // missing -- it extrapolates the held extent's outermost cell and answers
    // with a confident number, which reads as a cliff about half the time. So
    // unknown ground imposes no constraint at all: we keep the collider slide,
    // we do not invent a cliff or a lake, and the server corrects us if the
    // guess was wrong. Being wrong in the direction of "kept walking" is what
    // corrections are for; being wrong in the direction of "refused" sticks the
    // player on a chunk boundary with no way to know why.
    const knows = options.terrain.knows;
    const covered =
      knows === undefined ||
      (knows.call(options.terrain, from.x, from.y) && knows.call(options.terrain, landed.x, landed.y));
    const standingOn = { x: from.x, y: from.y, z: options.terrain.heightAt(from.x, from.y) };
    if (covered && (landed.x !== from.x || landed.y !== from.y) && !isWalkable(standingOn, landed.x, landed.y, options.terrain)) {
      const alongX = { x: landed.x, y: from.y };
      const alongY = { x: from.x, y: landed.y };
      if (alongX.x !== from.x && isWalkable(standingOn, alongX.x, alongX.y, options.terrain)) {
        landed = alongX;
      } else if (alongY.y !== from.y && isWalkable(standingOn, alongY.x, alongY.y, options.terrain)) {
        landed = alongY;
      } else {
        landed = from;
      }
    }

    return pushOutOfObstacles(landed, options.radius, options.world);
  };
}

/**
 * How much of the visual offset survives one tick. 0.82 halves it in about four
 * ticks and leaves under a percent after a quarter of a second: fast enough that
 * a correction is over before the player has read it, slow enough that it is a
 * glide rather than the snap it replaces.
 */
const OFFSET_DECAY = 0.82;

/** Below this the offset is spent; keeping it alive is float noise in the draw. */
const OFFSET_EPSILON = 0.02;

/**
 * Past this, easing is a lie: a body that far from where the server says it is
 * has been teleported, killed and respawned, or is cheating, and all three
 * should look like what they are.
 */
const MAX_EASED_OFFSET = 48;

export class PredictionBuffer {
  private pendingInputs: PredictedInput[] = [];
  private local: Point;
  /** Counts corrections, so a client can surface how badly it is mispredicting. */
  private corrections = 0;
  /**
   * What to add to {@link position} to get what should be *drawn* -- the
   * remainder of the last eased correction, decaying toward nothing.
   *
   * Never sent, never predicted from. Prediction continues from the server's
   * answer the instant it arrives; this is only the picture catching up.
   */
  private offsetX = 0;
  private offsetY = 0;

  constructor(
    start: Point,
    private readonly step: PredictStep,
  ) {
    this.local = start;
  }

  /** The predicted position: what the server is told, and what replays from. */
  get position(): Point {
    return this.local;
  }

  /** The position to draw: {@link position} plus whatever is left to ease in. */
  get drawn(): Point {
    if (this.offsetX === 0 && this.offsetY === 0) return this.local;
    return { x: this.local.x + this.offsetX, y: this.local.y + this.offsetY };
  }

  /** How far the drawn body still lags the predicted one. Diagnostics. */
  get easing(): number {
    return Math.hypot(this.offsetX, this.offsetY);
  }

  get pending(): readonly PredictedInput[] {
    return this.pendingInputs;
  }

  get correctionCount(): number {
    return this.corrections;
  }

  /** Applies an input locally and remembers it until the server acknowledges it. */
  apply(input: PredictedInput): Point {
    this.pendingInputs.push(input);
    this.local = this.step(this.local, input);
    return this.local;
  }

  /**
   * Drops inputs the server has already accounted for. Called with every
   * delta's `ackInputSeq`, which is what stops the buffer growing without bound
   * on a healthy connection.
   */
  acknowledge(seq: number): void {
    if (this.pendingInputs.length === 0) return;
    this.pendingInputs = this.pendingInputs.filter((input) => input.seq > seq);
  }

  /**
   * Snaps to the server's position as of `seq`, then replays everything after
   * it. The replayed inputs stay pending: the server has not acknowledged them,
   * so a second correction must be able to replay them again.
   *
   * `eased` keeps the difference the correction made as a visual offset instead
   * of moving the drawn body -- see {@link drawn}. The corrected state is
   * adopted either way; the flag only decides whether the player watches it
   * happen.
   */
  reconcile(seq: number, authoritative: Point, options?: { readonly eased?: boolean }): Point {
    this.corrections += 1;
    this.pendingInputs = this.pendingInputs.filter((input) => input.seq > seq);
    let position = authoritative;
    for (const input of this.pendingInputs) position = this.step(position, input);

    if (options?.eased) {
      // Where we were, relative to where we now know we are. Added to the
      // previous offset rather than replacing it, so a second correction
      // arriving mid-ease does not restart the glide from a stale position.
      const carriedX = this.local.x + this.offsetX - position.x;
      const carriedY = this.local.y + this.offsetY - position.y;
      if (Math.hypot(carriedX, carriedY) <= MAX_EASED_OFFSET) {
        this.offsetX = carriedX;
        this.offsetY = carriedY;
      } else {
        this.offsetX = 0;
        this.offsetY = 0;
      }
    } else {
      this.offsetX = 0;
      this.offsetY = 0;
    }

    this.local = position;
    return this.local;
  }

  /**
   * One tick of easing. Driven from the same fixed-timestep loop that produces
   * inputs, so the glide is measured in ticks rather than in frames -- a client
   * drawing at 30fps and one at 144 converge at the same rate.
   */
  decay(): void {
    if (this.offsetX === 0 && this.offsetY === 0) return;
    this.offsetX *= OFFSET_DECAY;
    this.offsetY *= OFFSET_DECAY;
    if (Math.hypot(this.offsetX, this.offsetY) < OFFSET_EPSILON) {
      this.offsetX = 0;
      this.offsetY = 0;
    }
  }

  /** Distance between the local guess and a position the server reported. */
  divergenceFrom(authoritative: Point): number {
    return Math.hypot(this.local.x - authoritative.x, this.local.y - authoritative.y);
  }
}
