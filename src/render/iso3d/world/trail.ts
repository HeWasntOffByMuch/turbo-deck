/**
 * The streak a thrown weapon leaves behind it (spec 081).
 *
 * Pure -- no three.js, no DOM. It is a ring buffer of where something has been
 * and the strip built over those points; `shot.ts` turns that into buffers.
 *
 * ## Why it samples by distance rather than by frame
 *
 * The obvious trail keeps the last N frames. That makes the streak a property
 * of the *machine*: at 144Hz it is a third as long as at 48Hz, and the same
 * throw looks different on two screens. Sampling on `minSpacing` instead makes
 * it a property of the *flight* -- the same shot lays down the same points
 * however often it was asked -- which is also what stops a shot that has slowed
 * to a crawl from filling the buffer with a puddle of coincident points.
 *
 * The strip is flat in the ground plane. The camera is a fixed isometric one,
 * so there is no bearing that turns a ground-plane ribbon edge-on, and a flat
 * strip costs two vertices a sample instead of a tube's ring.
 */

export interface TrailSample {
  readonly x: number;
  readonly y: number;
  /** Height. The ribbon offsets across the ground plane, never through this. */
  readonly z: number;
}

export interface TrailRibbon {
  /**
   * Flat world-space `x, y, z` triples: two vertices per sample, the left edge
   * then the right, head first.
   *
   * World order, not render order -- `z` is height. The caller is the half that
   * knows three.js puts height in `y`.
   */
  readonly positions: readonly number[];
  /** One per vertex: 1 at the head, falling to 0 at the tail. */
  readonly alphas: readonly number[];
  /** Triangle indices over the strip. Empty below two samples. */
  readonly indices: readonly number[];
}

const EMPTY: TrailRibbon = { positions: [], alphas: [], indices: [] };

function finite(sample: TrailSample): boolean {
  return Number.isFinite(sample.x) && Number.isFinite(sample.y) && Number.isFinite(sample.z);
}

export class Trail {
  /** Newest first, so the head -- the end that matters -- is index 0. */
  private readonly buffer: TrailSample[] = [];
  private readonly limit: number;
  private readonly spacing: number;

  constructor(capacity: number, minSpacing: number) {
    this.limit = Number.isFinite(capacity) && capacity >= 2 ? Math.floor(capacity) : 2;
    this.spacing = Number.isFinite(minSpacing) && minSpacing > 0 ? minSpacing : 0;
  }

  get samples(): readonly TrailSample[] {
    return this.buffer;
  }

  /** Ignored unless it has moved `minSpacing` from the point at the head. */
  push(sample: TrailSample): void {
    if (!finite(sample)) return;

    const head = this.buffer[0];
    if (head) {
      const moved = Math.hypot(sample.x - head.x, sample.y - head.y, sample.z - head.z);
      if (moved < this.spacing) return;
    }

    this.buffer.unshift({ x: sample.x, y: sample.y, z: sample.z });
    if (this.buffer.length > this.limit) this.buffer.length = this.limit;
  }

  clear(): void {
    this.buffer.length = 0;
  }

  /**
   * The strip over what has been pushed so far.
   *
   * `halfWidth` is the half-width at the head; it tapers with the alpha, so the
   * tail narrows into nothing rather than ending in a cut edge. `lift` raises
   * the whole strip off the ground -- a flat shot flies at exactly terrain
   * height, and a streak laid at its own height would z-fight the ground it is
   * skimming.
   */
  ribbon(halfWidth: number, lift: number): TrailRibbon {
    const count = this.buffer.length;
    if (count < 2) return EMPTY;

    const positions: number[] = [];
    const alphas: number[] = [];
    const indices: number[] = [];

    // Carried forward so a pair of coincident samples -- a shot that stalled,
    // or a push the spacing let through on a diagonal -- inherits the last
    // direction that meant something instead of collapsing the strip.
    let acrossX = 0;
    let acrossY = 1;

    for (let i = 0; i < count; i++) {
      const here = this.buffer[i] as TrailSample;
      // The local direction of travel: from the sample behind this one to the
      // sample ahead of it, so the strip miters through a curve rather than
      // kinking at every point.
      const ahead = this.buffer[Math.max(0, i - 1)] as TrailSample;
      const behind = this.buffer[Math.min(count - 1, i + 1)] as TrailSample;
      const dx = ahead.x - behind.x;
      const dy = ahead.y - behind.y;
      const length = Math.hypot(dx, dy);
      if (length > 1e-6) {
        acrossX = -dy / length;
        acrossY = dx / length;
      }

      // 0 at the head, 1 at the tail.
      const along = i / (count - 1);
      const fade = 1 - along;
      const width = halfWidth * fade;
      const z = here.z + lift;

      positions.push(here.x + acrossX * width, here.y + acrossY * width, z);
      positions.push(here.x - acrossX * width, here.y - acrossY * width, z);
      alphas.push(fade, fade);

      if (i > 0) {
        const a = (i - 1) * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    return { positions, alphas, indices };
  }
}
