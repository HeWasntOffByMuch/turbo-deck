/**
 * The VFX layer: the sim, drawn (spec 118).
 *
 * This owns an `Object3D` and hands it to whoever is building a scene. That is
 * the entire integration -- add the root to `WorldScene.scene`, call
 * {@link update} with the frame's tick count, and the particles are in the
 * low-resolution buffer, because `RetroPass.render` draws that scene into it.
 * There is no pass to insert and nothing to composite.
 *
 * The split is the usual one for this repo. Every decision -- what spawns, where
 * it goes, what colour it is, what gets dropped when the budget is tight -- is in
 * `system.ts` and is tested in Node. This file copies floats into buffers.
 *
 * ## Sync runs before the pixel snap
 *
 * `WorldScene` nudges the camera by up to half a virtual pixel just before it
 * draws, and undoes it after. Billboard bases must be built from the *unsnapped*
 * camera, for the same reason `syncHover` picks against it: a basis derived from
 * the snapped camera wobbles by the snap amount every frame, which is exactly
 * the shimmer the snap exists to remove. Particle positions are world-space and
 * do not care either way.
 *
 * In practice the shader reads `viewMatrix` itself, so the ordering requirement
 * lands on the *scene's* call site rather than here -- but it is written down
 * because "it happens to work" is not a reason.
 */

import * as THREE from 'three';
import { ParticleBatch, MeshParticleBatch, modeCode } from './batches.js';
import { FAMILY } from './compile.js';
import { depthOrder } from './depth-sort.js';
import { fallbackSegment, ribbonSegments, MAX_SEGMENTS, SEGMENT_STRIDE } from './ribbon.js';
import { RIBBON_SAMPLES, type ParticlePool } from './pool.js';
import { VfxSystem, type VfxHooks, type VfxSystemOptions } from './system.js';
import { REGISTRY } from './registry.js';
import { DecalField, type GoreLevel } from './decals.js';
import { DecalView } from './decal-view.js';
import {
  bloodHitRequest,
  brushExplosionRequest,
  type BloodHitInput,
  type BrushExplosionInput,
  type SpawnRequest,
} from './brush.js';
import type { PlayOptions } from './types.js';

/** How many of the sim's lights are actually given a `PointLight`. */
const LIGHT_POOL = 4;

export interface VfxLayerOptions extends Omit<VfxSystemOptions, 'registry'> {
  readonly registry?: VfxSystemOptions['registry'];
  /** Drive real point lights from emitters that ask for one. Default true. */
  readonly lights?: boolean;
}

export class VfxLayer {
  readonly root = new THREE.Object3D();
  readonly system: VfxSystem;
  /** The stains (spec 120). Outlives every particle, owned by map chunks. */
  readonly decals: DecalField;
  private readonly decalView: DecalView;

  private readonly batches: (ParticleBatch | MeshParticleBatch)[] = [];
  /**
   * Draw order for the solid batches, back to front (spec 123).
   *
   * Semi-transparent solids that intersect each other have to be drawn far-first
   * or the near ones punch holes in the far ones. Insertion sort over a
   * preallocated array: the order barely changes between frames, so it runs at
   * about O(n) and allocates nothing.
   */
  private readonly order: Int32Array;
  private readonly depth: Float32Array;
  /** Write cursor per batch, reset every sync. Preallocated. */
  private readonly cursors: Int32Array;
  /** Instances each batch needs this frame, counted before anything is written. */
  private readonly needed: Int32Array;
  /** Each batch's family, so the count pass never has to reach for an emitter. */
  private readonly families: Int32Array;
  /** One particle's ribbon links, rewritten per particle. Preallocated (spec 139). */
  private readonly segments = new Float32Array(MAX_SEGMENTS * SEGMENT_STRIDE);
  private readonly pointLights: THREE.PointLight[] = [];
  private drawCalls = 0;
  // The isometric default, so the sort is right before anybody sets one.
  private viewX = -0.577;
  private viewY = -0.577;
  private viewZ = -0.577;

  constructor(options: VfxLayerOptions) {
    const registry = options.registry ?? REGISTRY;
    this.decals = new DecalField();
    // The sim reports a contact; the field decides whether to keep it. Wiring
    // them here rather than inside the sim is what keeps the sim free of chunk
    // bookkeeping and the field free of particles.
    this.system = new VfxSystem({
      ...options,
      registry,
      hooks: {
        ...options.hooks,
        decal: (x, y, z, seed, fluid, size, dirX, dirZ) => {
          this.decals.add({
            x,
            y,
            z,
            size,
            // The stain lies the way the drop was travelling.
            rotation: Math.atan2(dirZ, dirX),
            nx: 0,
            ny: 1,
            nz: 0,
            seed,
            fluid,
          });
        },
      },
    });
    this.decalView = new DecalView(this.decals, options.hooks.ground);
    this.root.add(this.decalView.root);

    this.root.name = 'vfx';
    // Never culled as a whole: its children hold world-space particles and the
    // root's own transform is the identity, so a bounding volume on it would be
    // meaningless and recomputing one every frame would not be free.
    this.root.frustumCulled = false;

    for (const batch of registry.batches) {
      const made =
        batch.family === FAMILY.mesh && batch.meshShape !== ''
          ? new MeshParticleBatch(batch.blend, batch.meshShape)
          : new ParticleBatch(batch.blend, batch.sheet);
      this.batches.push(made);
      this.root.add(made.mesh);
    }
    this.cursors = new Int32Array(this.batches.length);
    this.needed = new Int32Array(this.batches.length);
    this.families = new Int32Array(registry.batches.map((batch) => batch.family));
    this.order = new Int32Array(this.system.pool.capacity);
    this.depth = new Float32Array(this.system.pool.capacity);

    if (options.lights !== false) {
      for (let i = 0; i < LIGHT_POOL; i++) {
        // A fixed pool, created once. A scene whose light count changes between
        // frames is a scene that recompiles every material it owns, which is a
        // far worse frame spike than the lights are worth.
        const light = new THREE.PointLight(0xffffff, 0, 100);
        light.visible = false;
        this.pointLights.push(light);
        this.root.add(light);
      }
    }
  }

  /** Start an effect. The one call a caller ever needs. */
  play(id: string, options: PlayOptions): number {
    return this.system.play(id, options);
  }

  /**
   * Throw paint where a blow landed (spec 158).
   *
   * The convenience over `play` that the painted vocabulary earns, because its
   * inputs are the ones a *combat* call site has -- a point, a surface, the
   * direction the blow was going -- rather than the rotation-about-Y and scale
   * `PlayOptions` speaks in. The conversion is `bloodHitRequest`, which is pure
   * and asserted in Node; this is the two lines that cannot be.
   */
  spawnBloodHit(input: BloodHitInput): number {
    return this.playRequest(bloodHitRequest(input));
  }

  /** The same, for an explosion: a point, how far it should reach, how hard. */
  spawnBrushExplosion(input: BrushExplosionInput): number {
    return this.playRequest(brushExplosionRequest(input));
  }

  private playRequest(request: SpawnRequest): number {
    return this.system.play(request.id, {
      x: request.x,
      y: request.y,
      z: request.z,
      rotation: request.rotation,
      scale: request.scale,
      seed: request.seed,
    });
  }

  stop(handle: number, hard = false): void {
    this.system.stop(handle, hard);
  }

  /**
   * Advance and upload.
   *
   * `ticks` is the whole 60Hz steps the frame drained, not its elapsed seconds --
   * the same number `UnitMachine` is driven by, and for the same reason.
   */
  update(ticks: number): void {
    this.system.update(ticks);
    this.decals.update(ticks);
    this.sync();
    this.decalView.sync();
  }

  /** 0 off, 1 reduced, 2 full. Off removes the work, not just the pixels. */
  setGore(level: GoreLevel): void {
    this.decals.setGore(level);
    this.decalView.sync();
  }

  /**
   * How many instances each batch needs this frame.
   *
   * A pass of its own because a ribbon particle is not one instance: it is a
   * link per trail sample, and sizing a batch to `pool.count` would overflow it.
   * The alternative -- growing every ribbon batch to the worst case -- allocates
   * a megabyte of buffers for a fight that never happens, and the count is a walk
   * over three typed arrays with no lookups in it.
   */
  private countInstances(count: number): void {
    const pool = this.system.pool;
    this.needed.fill(0);
    for (let i = 0; i < count; i++) {
      const batchIndex = pool.batch[i] ?? 0;
      if (batchIndex < 0 || batchIndex >= this.needed.length) continue;
      let instances = 1;
      if (this.families[batchIndex] === FAMILY.ribbon) {
        const track = pool.ribbon[i] ?? -1;
        const held = track >= 0 ? (pool.ribbonCount[track] ?? 0) : 0;
        // One link per sample, plus the head; a trail-less particle draws the
        // single fallback stub.
        instances = held > 0 ? Math.min(held, MAX_SEGMENTS) : 1;
      }
      this.needed[batchIndex] = (this.needed[batchIndex] ?? 0) + instances;
    }
  }

  /** Copy the particle field into the instanced attributes. */
  private sync(): void {
    const pool = this.system.pool;
    this.cursors.fill(0);

    this.countInstances(pool.count);
    for (let i = 0; i < this.batches.length; i++) this.batches[i]?.begin(this.needed[i] ?? 0);

    const walk = this.sortForDepth(pool.count);
    for (let n = 0; n < pool.count; n++) {
      const i = walk[n] ?? 0;
      const batchIndex = pool.batch[i] ?? 0;
      const batch = this.batches[batchIndex];
      if (!batch) continue;
      const emitter = this.system.emitterAt(i);
      if (!emitter) continue;
      const at = this.cursors[batchIndex] ?? 0;
      // The decay mode travels with the emitter rather than the particle, the
      // same way `modeCode` and `stretch` do for the quad batches below: it is a
      // property of what was authored, not of how far through its life a mark is.
      if (batch instanceof MeshParticleBatch) batch.write(at, pool, i, emitter.strokeDecay);
      else if (this.families[batchIndex] === FAMILY.ribbon) {
        this.cursors[batchIndex] = at + this.writeRibbon(batch, pool, i, at, emitter.ribbonTaper);
        continue;
      } else batch.write(at, pool, i, modeCode(emitter.render), emitter.stretch);
      this.cursors[batchIndex] = at + 1;
    }

    this.drawCalls = 0;
    for (let i = 0; i < this.batches.length; i++) {
      const count = this.cursors[i] ?? 0;
      this.batches[i]?.end(count);
      if (count > 0) this.drawCalls += 1;
    }

    this.syncLights();
  }

  /**
   * Write one particle's streak, and say how many instances it took (spec 139).
   *
   * The arithmetic is `ribbon.ts` and is tested in Node; this hands it the
   * track the sim has been filling and copies what comes back.
   */
  private writeRibbon(batch: ParticleBatch, pool: ParticlePool, i: number, at: number, taper: number): number {
    const track = pool.ribbon[i] ?? -1;
    const held = track >= 0 ? (pool.ribbonCount[track] ?? 0) : 0;
    const width = pool.size[i] ?? 0;
    const count =
      held > 0
        ? ribbonSegments(
            pool.ribbonXyz,
            track * RIBBON_SAMPLES * 3,
            held,
            pool.x[i] ?? 0,
            pool.y[i] ?? 0,
            pool.z[i] ?? 0,
            width,
            taper,
            this.segments,
          )
        : fallbackSegment(
            pool.x[i] ?? 0,
            pool.y[i] ?? 0,
            pool.z[i] ?? 0,
            pool.vx[i] ?? 0,
            pool.vy[i] ?? 0,
            pool.vz[i] ?? 0,
            width,
            taper,
            this.segments,
          );
    for (let s = 0; s < count; s++) batch.writeSegment(at + s, pool, i, this.segments, s * SEGMENT_STRIDE);
    return count;
  }

  /**
   * Particle indices ordered furthest-first along the view direction.
   *
   * The ordering itself is arithmetic and lives in `depth-sort.ts` where it can
   * be replayed in Node; this only supplies the pool and the scratch arrays.
   */
  private sortForDepth(count: number): Int32Array {
    const pool = this.system.pool;
    return depthOrder(count, pool.x, pool.y, pool.z, this.viewX, this.viewY, this.viewZ, this.order, this.depth);
  }

  private syncLights(): void {
    if (this.pointLights.length === 0) return;
    const count = Math.min(this.system.collectLights(), this.pointLights.length);
    const data = this.system.lights;
    for (let i = 0; i < this.pointLights.length; i++) {
      const light = this.pointLights[i];
      if (!light) continue;
      if (i >= count) {
        light.visible = false;
        light.intensity = 0;
        continue;
      }
      const at = i * 8;
      light.position.set(data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0);
      // The colour is already linear -- `palette.ts` decodes on the way in -- so
      // it is written straight rather than through `setHex`, which would decode
      // a second time and wash every glow out.
      light.color.setRGB(data[at + 3] ?? 1, data[at + 4] ?? 1, data[at + 5] ?? 1);
      light.intensity = (data[at + 6] ?? 0) * 2;
      light.distance = data[at + 7] ?? 100;
      light.visible = true;
    }
  }

  /** Where the camera is, for distance culling. */
  setViewpoint(x: number, y: number, z: number): void {
    this.system.setViewpoint(x, y, z);
    this.decals.setViewpoint(x, z);
  }

  /**
   * Which way the camera looks, for the transparency sort.
   *
   * A direction rather than a position: the camera is orthographic, so what
   * decides which of two blobs is in front is the projection onto its forward
   * axis and not the distance to its eye.
   */
  setViewDirection(x: number, y: number, z: number): void {
    const length = Math.sqrt(x * x + y * y + z * z) || 1;
    this.viewX = x / length;
    this.viewY = y / length;
    this.viewZ = z / length;
  }

  setIntensity(intensity: number): void {
    this.system.setIntensity(intensity);
    if (intensity === 0) this.sync();
  }

  setPaused(paused: boolean): void {
    this.system.setPaused(paused);
  }

  setTimeScale(scale: number): void {
    this.system.setTimeScale(scale);
  }

  /** What the debug HUD reads. */
  readout(): {
    readonly particles: number;
    readonly effects: number;
    readonly drawCalls: number;
    readonly lights: number;
    readonly refusedBudget: number;
    readonly refusedDistance: number;
    readonly throttled: number;
    readonly decals: number;
    readonly decalBuckets: number;
  } {
    const stats = this.system.stats;
    return {
      particles: stats.liveParticles,
      effects: stats.liveInstances,
      drawCalls: this.drawCalls,
      lights: this.pointLights.filter((light) => light.visible).length,
      refusedBudget: stats.refusedBudget,
      refusedDistance: stats.refusedDistance,
      throttled: stats.throttled,
      decals: this.decals.count,
      decalBuckets: this.decalView.bucketCount,
    };
  }

  dispose(): void {
    this.decalView.dispose();
    this.root.remove(this.decalView.root);
    for (const batch of this.batches) {
      this.root.remove(batch.mesh);
      batch.dispose();
    }
    this.batches.length = 0;
    for (const light of this.pointLights) this.root.remove(light);
    this.pointLights.length = 0;
  }
}

export type { VfxHooks };
