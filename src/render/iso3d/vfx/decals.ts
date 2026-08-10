/**
 * Where blood stays (spec 120).
 *
 * Pure -- no three.js, no DOM, no clock. Decals are grouped into buckets keyed by
 * map chunk, capped per bucket and globally, and faded out rather than popped.
 *
 * ## The lifetime is owned here, and that is deliberate
 *
 * The obvious design frees a decal when its chunk streams out. In this client
 * that is a leak with a plausible-looking cause: `StreamedMap.add` inserts and
 * *nothing removes* (`docs/vfx-plan.md` §3c), so the eviction the design waits
 * for never happens, the field grows without bound, and the code reviews as
 * correct because the intent is right.
 *
 * So the caps here are the real lifetime, and {@link DecalField.dropChunk} is
 * written and connected to nothing. When chunk eviction lands, one call site
 * makes it work; until then, nothing depends on it existing.
 *
 * ## Bucketed by chunk because rebuilding is the expensive half
 *
 * A decal is a handful of triangles and merging a bucket is cheap; merging the
 * whole field on every hit is not. `props.ts` reached the same conclusion about
 * the prop field for the same reason (spec 086), and this follows it: an add
 * marks one bucket dirty and a view rebuilds only what it is told.
 */

import type { FluidKind } from './splat.js';

/** The terrain's own chunk: 28 cells at 22 world units (`terrain/chunk.ts`). */
export const CHUNK_WORLD_SIZE = 28 * 22;

export interface DecalInput {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly size: number;
  readonly rotation: number;
  /** The surface normal it was laid on. Need not be normalized. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly seed: number;
  readonly fluid: FluidKind;
}

export interface Decal {
  x: number;
  y: number;
  z: number;
  size: number;
  rotation: number;
  nx: number;
  ny: number;
  nz: number;
  seed: number;
  fluid: FluidKind;
  /** Ticks since it landed. */
  age: number;
  /** Age at which it starts fading, or -1 while it is not fading. */
  fadeFrom: number;
  /** 1 fresh, 0 gone. Written by `update`, read by the view. */
  opacity: number;
}

export interface ChunkKey {
  readonly cx: number;
  readonly cz: number;
}

export interface DecalLimits {
  readonly perChunk: number;
  readonly total: number;
  readonly chunkSize: number;
  /** How long a decal takes to fade once it has been marked. */
  readonly fadeTicks: number;
}

export const DECAL_LIMITS: DecalLimits = {
  perChunk: 64,
  total: 512,
  chunkSize: CHUNK_WORLD_SIZE,
  fadeTicks: 90,
};

/** 0 off, 1 reduced, 2 full. Off is off: nothing is stored and nothing is built. */
export type GoreLevel = 0 | 1 | 2;

function keyOf(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export class DecalField {
  private readonly buckets = new Map<string, Decal[]>();
  private readonly dirty = new Set<string>();
  private readonly limits: DecalLimits;
  private gore: GoreLevel = 2;
  private live = 0;

  private viewX = 0;
  private viewZ = 0;

  constructor(limits: Partial<DecalLimits> = {}) {
    this.limits = { ...DECAL_LIMITS, ...limits };
  }

  get count(): number {
    return this.live;
  }

  setGore(level: GoreLevel): void {
    this.gore = level;
    if (level === 0) this.clear();
  }

  getGore(): GoreLevel {
    return this.gore;
  }

  /** Where the camera is, so a global eviction drops the far buckets first. */
  setViewpoint(x: number, z: number): void {
    this.viewX = x;
    this.viewZ = z;
  }

  chunkOf(x: number, z: number): ChunkKey {
    const size = Math.max(1, this.limits.chunkSize);
    return { cx: Math.floor(x / size), cz: Math.floor(z / size) };
  }

  /**
   * Lay a decal down. Returns false when it was refused.
   *
   * Refusal at gore 0 is total: nothing is stored, no bucket is marked dirty, and
   * so no geometry is ever built. The setting has to remove the *work*, not just
   * the pixels, or "off" is a lie told to somebody whose machine is struggling.
   */
  add(input: DecalInput): boolean {
    if (this.gore === 0) return false;
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || !Number.isFinite(input.z)) return false;
    if (input.size <= 0) return false;

    const { cx, cz } = this.chunkOf(input.x, input.z);
    const key = keyOf(cx, cz);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }

    const length = Math.sqrt(input.nx * input.nx + input.ny * input.ny + input.nz * input.nz);
    const inv = length > 1e-5 ? 1 / length : 0;
    bucket.push({
      x: input.x,
      y: input.y,
      z: input.z,
      size: input.size,
      rotation: input.rotation,
      nx: inv === 0 ? 0 : input.nx * inv,
      ny: inv === 0 ? 1 : input.ny * inv,
      nz: inv === 0 ? 0 : input.nz * inv,
      seed: input.seed,
      fluid: input.fluid,
      age: 0,
      fadeFrom: -1,
      opacity: 1,
    });
    this.live += 1;
    this.dirty.add(key);

    this.enforcePerChunk(key, bucket);
    this.enforceTotal();
    return true;
  }

  /**
   * Age the field.
   *
   * A bucket is only marked dirty when a decal's opacity actually *changes*, so a
   * settled field costs nothing: a hundred stains sitting at full opacity rebuild
   * no geometry at all.
   */
  update(ticks: number): void {
    if (ticks <= 0 || this.gore === 0) return;
    const fade = Math.max(1, this.limits.fadeTicks);

    for (const [key, bucket] of this.buckets) {
      let changed = false;
      for (let i = bucket.length - 1; i >= 0; i--) {
        const decal = bucket[i];
        if (!decal) continue;
        decal.age += ticks;
        if (decal.fadeFrom < 0) continue;

        const opacity = Math.max(0, 1 - (decal.age - decal.fadeFrom) / fade);
        if (opacity !== decal.opacity) {
          decal.opacity = opacity;
          changed = true;
        }
        if (opacity <= 0) {
          bucket.splice(i, 1);
          this.live -= 1;
        }
      }
      if (changed) this.dirty.add(key);
      if (bucket.length === 0) this.buckets.delete(key);
    }
  }

  /**
   * A chunk went away, so its stains go with it.
   *
   * **Nothing calls this yet.** The client has no chunk-eviction path -- see the
   * note at the top of this file -- and this exists so that when one lands it is
   * one call site rather than a redesign. It is tested, so it will still work
   * then.
   */
  dropChunk(cx: number, cz: number): void {
    const key = keyOf(cx, cz);
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    this.live -= bucket.length;
    this.buckets.delete(key);
    this.dirty.add(key);
  }

  clear(): void {
    for (const key of this.buckets.keys()) this.dirty.add(key);
    this.buckets.clear();
    this.live = 0;
  }

  /** Buckets that changed since the last call. Reported once, then forgotten. */
  takeDirty(): readonly ChunkKey[] {
    const out: ChunkKey[] = [];
    for (const key of this.dirty) {
      const [cx, cz] = key.split(',');
      out.push({ cx: Number(cx), cz: Number(cz) });
    }
    this.dirty.clear();
    return out;
  }

  bucket(cx: number, cz: number): readonly Decal[] {
    return this.buckets.get(keyOf(cx, cz)) ?? [];
  }

  /** Every live bucket, for a view that is rebuilding from scratch. */
  chunks(): readonly ChunkKey[] {
    const out: ChunkKey[] = [];
    for (const key of this.buckets.keys()) {
      const [cx, cz] = key.split(',');
      out.push({ cx: Number(cx), cz: Number(cz) });
    }
    return out;
  }

  /**
   * Over the per-chunk cap, the oldest decal starts fading.
   *
   * Marked rather than removed: a stain that vanishes on the frame a new one
   * lands is a pop, and in a busy fight it is a pop every few frames right where
   * the player is looking.
   *
   * The cap counts only decals that are **not already fading**. Counting the
   * whole bucket looks equivalent and is not: a fade takes ninety ticks, so under
   * sustained fire the dying ones stay in the count, every add marks another
   * survivor, and within a few seconds the entire bucket is fading and the ground
   * goes clean in the middle of the fight that is staining it. A preview of
   * ninety hits into one chunk reported 77 decals with 77 of them fading, which
   * is what that failure looks like from outside.
   */
  private enforcePerChunk(key: string, bucket: Decal[]): void {
    let solid = 0;
    for (const decal of bucket) if (decal.fadeFrom < 0) solid += 1;
    let over = solid - this.limits.perChunk;
    if (over <= 0) return;
    for (const decal of bucket) {
      if (over <= 0) break;
      if (decal.fadeFrom >= 0) continue;
      decal.fadeFrom = decal.age;
      over -= 1;
    }
    this.dirty.add(key);
  }

  /**
   * Over the global cap, whole buckets go -- the furthest from the viewpoint
   * first, and never the one the player is standing in.
   */
  private enforceTotal(): void {
    if (this.live <= this.limits.total) return;
    const size = Math.max(1, this.limits.chunkSize);
    const ranked: { key: string; distance: number }[] = [];
    for (const key of this.buckets.keys()) {
      const [cxText, czText] = key.split(',');
      const centreX = (Number(cxText) + 0.5) * size;
      const centreZ = (Number(czText) + 0.5) * size;
      const dx = centreX - this.viewX;
      const dz = centreZ - this.viewZ;
      ranked.push({ key, distance: dx * dx + dz * dz });
    }
    ranked.sort((a, b) => b.distance - a.distance);

    for (const { key } of ranked) {
      if (this.live <= this.limits.total) break;
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      this.live -= bucket.length;
      this.buckets.delete(key);
      this.dirty.add(key);
    }
  }
}

// --- fitting a decal to what it landed on ------------------------------------

/**
 * Height samples across a decal's footprint, as `resolution x resolution`
 * world-space triples.
 *
 * Why a grid rather than one quad: the ground is a heightfield, and a flat quad
 * laid on a slope either floats at one end or is buried at the other -- and on a
 * ridge it does both at once. Sampling the real height at each vertex makes the
 * decal follow the ground it is on, which is also why it needs no projection pass.
 *
 * The lift is along the surface normal rather than straight up, so a decal on a
 * steep face stands off it by the same distance as one on the flat.
 */
export function decalGrid(
  decal: Decal,
  resolution: number,
  ground: (x: number, z: number) => number,
  lift: number,
  out: Float32Array,
): void {
  const steps = Math.max(2, Math.floor(resolution));
  const half = decal.size * 0.5;
  const cos = Math.cos(decal.rotation);
  const sin = Math.sin(decal.rotation);

  for (let row = 0; row < steps; row++) {
    for (let column = 0; column < steps; column++) {
      const u = (column / (steps - 1)) * 2 - 1;
      const v = (row / (steps - 1)) * 2 - 1;
      const localX = u * half;
      const localZ = v * half;
      const x = decal.x + localX * cos - localZ * sin;
      const z = decal.z + localX * sin + localZ * cos;
      const at = (row * steps + column) * 3;
      out[at] = x;
      out[at + 1] = ground(x, z) + lift * decal.ny + lift * 0.25;
      out[at + 2] = z;
    }
  }
}

/** UVs for {@link decalGrid}, which are a fixed function of the resolution. */
export function decalGridUvs(resolution: number, out: Float32Array): void {
  const steps = Math.max(2, Math.floor(resolution));
  for (let row = 0; row < steps; row++) {
    for (let column = 0; column < steps; column++) {
      const at = (row * steps + column) * 2;
      out[at] = column / (steps - 1);
      out[at + 1] = row / (steps - 1);
    }
  }
}

/** Triangle indices over a `resolution x resolution` grid. */
export function decalGridIndices(resolution: number, base: number, out: number[]): void {
  const steps = Math.max(2, Math.floor(resolution));
  for (let row = 0; row < steps - 1; row++) {
    for (let column = 0; column < steps - 1; column++) {
      const a = base + row * steps + column;
      const b = a + 1;
      const c = a + steps;
      const d = c + 1;
      out.push(a, c, b, b, c, d);
    }
  }
}

/**
 * Whether a surface facing `(nx, ny, nz)` should take a decal projected along
 * `(dirX, dirY, dirZ)`.
 *
 * The rule that stops blood wrapping onto the underside of a rock. A box
 * projector applies its texture to every face it passes through, including the
 * ones pointing away, and the result is a stain that appears to have been
 * painted on from beneath.
 *
 * `maxAngle` is in radians, measured between the surface normal and the
 * *incoming* direction reversed -- so a face turned square-on to the spray is
 * accepted and one turned past the limit is not.
 */
export function acceptsProjection(
  nx: number,
  ny: number,
  nz: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  maxAngle: number,
): boolean {
  const nLength = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const dLength = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
  if (nLength < 1e-6 || dLength < 1e-6) return false;
  // Against the reversed direction: the spray travels along `dir`, so a face it
  // can hit is one whose normal opposes it.
  const dot = -(nx * dirX + ny * dirY + nz * dirZ) / (nLength * dLength);
  return dot >= Math.cos(Math.max(0, Math.min(Math.PI, maxAngle)));
}
