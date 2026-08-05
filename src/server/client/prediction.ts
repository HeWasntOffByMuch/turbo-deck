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
 */

export interface PredictedInput {
  readonly seq: number;
  readonly moveX: number;
  readonly moveY: number;
  readonly facing: number;
  readonly buttons: number;
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
    const scale = (length > 1 ? 1 / length : 1) * perTick;
    return { x: from.x + input.moveX * scale, y: from.y + input.moveY * scale };
  };
}

export class PredictionBuffer {
  private pendingInputs: PredictedInput[] = [];
  private local: Point;
  /** Counts corrections, so a client can surface how badly it is mispredicting. */
  private corrections = 0;

  constructor(
    start: Point,
    private readonly step: PredictStep,
  ) {
    this.local = start;
  }

  get position(): Point {
    return this.local;
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
   */
  reconcile(seq: number, authoritative: Point): Point {
    this.corrections += 1;
    this.pendingInputs = this.pendingInputs.filter((input) => input.seq > seq);
    let position = authoritative;
    for (const input of this.pendingInputs) position = this.step(position, input);
    this.local = position;
    return this.local;
  }

  /** Distance between the local guess and a position the server reported. */
  divergenceFrom(authoritative: Point): number {
    return Math.hypot(this.local.x - authoritative.x, this.local.y - authoritative.y);
  }
}
