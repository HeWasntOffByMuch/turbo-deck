/**
 * The particle store (spec 118).
 *
 * Structure of arrays, one `Float32Array` per field, allocated once at
 * construction and never grown. There is no particle *object* anywhere in this
 * system -- a particle is an index, and every field of it is `pool.x[i]`. That is
 * the entire reason the update loop can promise zero allocation: there is
 * nothing it could allocate.
 *
 * Live particles are packed into `[0, count)` and removal is swap-with-last.
 * A free list would work too and is the more usual answer, but dense packing
 * buys the thing that actually matters downstream: the renderer uploads
 * `subarray(0, count)` of each field straight into an instanced attribute with
 * no gather step and no holes to skip.
 *
 * One reading note. `noUncheckedIndexedAccess` is on in this repo, so every
 * typed-array read is `number | undefined` to the compiler and is written
 * `?? 0`. It is not defensive coding -- the indices are always in bounds -- it is
 * the shape the tsconfig requires, and it is the same thing `retro-pass.ts` does.
 */

/** How many trail samples a ribbon particle keeps. */
export const RIBBON_SAMPLES = 12;

export class ParticlePool {
  readonly capacity: number;

  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;

  /** Both in ticks. `age` counts up to `life`; `life` is never zero. */
  readonly age: Float32Array;
  readonly life: Float32Array;

  readonly size: Float32Array;
  readonly rot: Float32Array;
  readonly rotVel: Float32Array;
  readonly frame: Float32Array;

  /**
   * The owning effect's scale and tint, copied in at birth rather than looked up
   * per tick.
   *
   * Four floats of duplication that buy independence: an instance can be evicted
   * to make room for a more important effect while its particles are still in
   * the air, and without this they would visibly jump size and colour on the
   * frame their owner went away.
   */
  readonly scale: Float32Array;
  readonly tintR: Float32Array;
  readonly tintG: Float32Array;
  readonly tintB: Float32Array;
  readonly tintStrength: Float32Array;

  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly a: Float32Array;

  /** Per-particle seed, so turbulence differs between two particles of one burst. */
  readonly seed: Int32Array;
  /** Flat index into the system's emitter table. */
  readonly emitter: Int32Array;
  /** The effect instance slot that owns it, or -1 once its owner is gone. */
  readonly instance: Int32Array;
  readonly bounces: Int32Array;
  /**
   * 1 once a particle has settled on the ground and stopped bouncing.
   *
   * A separate flag rather than "zero vertical speed", because gravity would
   * pull a resting particle back through the ground on the very next tick and
   * every tick after that -- which is a bounce per tick, a sub-effect per tick,
   * and a spark that quietly machine-guns decals into the world while looking
   * perfectly still.
   */
  readonly resting: Uint8Array;
  /** Which draw call it belongs to; copied from the emitter for sorting. */
  readonly batch: Int32Array;
  /** Ribbon slot, or -1. Only ribbon-mode particles hold one. */
  readonly ribbon: Int32Array;

  count = 0;

  // --- ribbon tracks ---------------------------------------------------------
  //
  // A bounded side-table rather than a `Trail` per particle. `world/trail.ts`
  // already established the rule these follow -- sample by distance travelled,
  // never by frame, so a streak is a property of the flight and not of the
  // frame rate -- but it stores samples as objects in a growing array, which is
  // exactly right for eight projectiles and exactly wrong for two thousand
  // particles. The rule is reused; the container is not.
  readonly ribbonCapacity: number;
  readonly ribbonXyz: Float32Array;
  readonly ribbonCount: Int32Array;
  private readonly ribbonFree: Int32Array;
  private ribbonFreeCount: number;

  constructor(capacity: number, ribbonCapacity = 128) {
    this.capacity = Math.max(1, Math.floor(capacity));
    const n = this.capacity;

    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.rotVel = new Float32Array(n);
    this.frame = new Float32Array(n);
    this.scale = new Float32Array(n);
    this.tintR = new Float32Array(n);
    this.tintG = new Float32Array(n);
    this.tintB = new Float32Array(n);
    this.tintStrength = new Float32Array(n);
    this.r = new Float32Array(n);
    this.g = new Float32Array(n);
    this.b = new Float32Array(n);
    this.a = new Float32Array(n);
    this.seed = new Int32Array(n);
    this.emitter = new Int32Array(n);
    this.instance = new Int32Array(n);
    this.bounces = new Int32Array(n);
    this.resting = new Uint8Array(n);
    this.batch = new Int32Array(n);
    this.ribbon = new Int32Array(n);

    this.ribbonCapacity = Math.max(0, Math.floor(ribbonCapacity));
    this.ribbonXyz = new Float32Array(this.ribbonCapacity * RIBBON_SAMPLES * 3);
    this.ribbonCount = new Int32Array(this.ribbonCapacity);
    this.ribbonFree = new Int32Array(this.ribbonCapacity);
    this.ribbonFreeCount = this.ribbonCapacity;
    for (let i = 0; i < this.ribbonCapacity; i++) this.ribbonFree[i] = i;
  }

  get free(): number {
    return this.capacity - this.count;
  }

  /**
   * Claim the next slot, or -1 when full.
   *
   * The caller writes every field it cares about; nothing is cleared here
   * beyond the handful whose stale value from a previous particle would be
   * actively wrong (`age`, `bounces`, `ribbon`).
   */
  spawn(): number {
    if (this.count >= this.capacity) return -1;
    const index = this.count;
    this.count += 1;
    this.age[index] = 0;
    this.bounces[index] = 0;
    this.resting[index] = 0;
    this.ribbon[index] = -1;
    return index;
  }

  /**
   * Remove a particle by swapping the last one into its slot.
   *
   * Returns nothing, and the caller must **not** advance its loop counter: the
   * particle now at `index` has not been visited yet. Every loop over the pool
   * in `system.ts` iterates backwards for exactly this reason.
   */
  kill(index: number): void {
    const ribbon = this.ribbon[index] ?? -1;
    if (ribbon >= 0) this.releaseRibbon(ribbon);

    const last = this.count - 1;
    if (index !== last) {
      this.x[index] = this.x[last] ?? 0;
      this.y[index] = this.y[last] ?? 0;
      this.z[index] = this.z[last] ?? 0;
      this.vx[index] = this.vx[last] ?? 0;
      this.vy[index] = this.vy[last] ?? 0;
      this.vz[index] = this.vz[last] ?? 0;
      this.age[index] = this.age[last] ?? 0;
      this.life[index] = this.life[last] ?? 1;
      this.size[index] = this.size[last] ?? 0;
      this.rot[index] = this.rot[last] ?? 0;
      this.rotVel[index] = this.rotVel[last] ?? 0;
      this.frame[index] = this.frame[last] ?? 0;
      this.scale[index] = this.scale[last] ?? 1;
      this.tintR[index] = this.tintR[last] ?? 1;
      this.tintG[index] = this.tintG[last] ?? 1;
      this.tintB[index] = this.tintB[last] ?? 1;
      this.tintStrength[index] = this.tintStrength[last] ?? 0;
      this.r[index] = this.r[last] ?? 0;
      this.g[index] = this.g[last] ?? 0;
      this.b[index] = this.b[last] ?? 0;
      this.a[index] = this.a[last] ?? 0;
      this.seed[index] = this.seed[last] ?? 0;
      this.emitter[index] = this.emitter[last] ?? 0;
      this.instance[index] = this.instance[last] ?? -1;
      this.bounces[index] = this.bounces[last] ?? 0;
      this.resting[index] = this.resting[last] ?? 0;
      this.batch[index] = this.batch[last] ?? 0;
      this.ribbon[index] = this.ribbon[last] ?? -1;
    }
    this.count = last;
  }

  clear(): void {
    for (let i = this.count - 1; i >= 0; i--) this.kill(i);
    this.count = 0;
  }

  // --- ribbons ---------------------------------------------------------------

  /** Claim a ribbon track, or -1 when they are all spoken for. */
  claimRibbon(): number {
    if (this.ribbonFreeCount <= 0) return -1;
    this.ribbonFreeCount -= 1;
    const slot = this.ribbonFree[this.ribbonFreeCount] ?? -1;
    if (slot >= 0) this.ribbonCount[slot] = 0;
    return slot;
  }

  releaseRibbon(slot: number): void {
    if (slot < 0 || slot >= this.ribbonCapacity) return;
    if (this.ribbonFreeCount >= this.ribbonCapacity) return;
    this.ribbonCount[slot] = 0;
    this.ribbonFree[this.ribbonFreeCount] = slot;
    this.ribbonFreeCount += 1;
  }

  /**
   * Push a sample onto a ribbon, newest last, dropping the oldest when full.
   *
   * Distance-gated by the caller, not here: whether a sample is far enough from
   * the last one to be worth keeping is a property of the emitter's tuning, and
   * this is the container.
   */
  pushRibbon(slot: number, x: number, y: number, z: number): void {
    if (slot < 0 || slot >= this.ribbonCapacity) return;
    const base = slot * RIBBON_SAMPLES * 3;
    const held = this.ribbonCount[slot] ?? 0;
    if (held >= RIBBON_SAMPLES) {
      // Shift down by one sample. Twelve samples is short enough that a copy
      // beats the index arithmetic of a true ring, and it keeps the renderer's
      // read a straight walk from oldest to newest.
      this.ribbonXyz.copyWithin(base, base + 3, base + RIBBON_SAMPLES * 3);
      const tail = base + (RIBBON_SAMPLES - 1) * 3;
      this.ribbonXyz[tail] = x;
      this.ribbonXyz[tail + 1] = y;
      this.ribbonXyz[tail + 2] = z;
      return;
    }
    const at = base + held * 3;
    this.ribbonXyz[at] = x;
    this.ribbonXyz[at + 1] = y;
    this.ribbonXyz[at + 2] = z;
    this.ribbonCount[slot] = held + 1;
  }

  /** The newest sample's distance from `(x, y, z)`, or Infinity when empty. */
  ribbonHeadDistance(slot: number, x: number, y: number, z: number): number {
    if (slot < 0 || slot >= this.ribbonCapacity) return Number.POSITIVE_INFINITY;
    const held = this.ribbonCount[slot] ?? 0;
    if (held === 0) return Number.POSITIVE_INFINITY;
    const at = slot * RIBBON_SAMPLES * 3 + (held - 1) * 3;
    const dx = (this.ribbonXyz[at] ?? 0) - x;
    const dy = (this.ribbonXyz[at + 1] ?? 0) - y;
    const dz = (this.ribbonXyz[at + 2] ?? 0) - z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}
