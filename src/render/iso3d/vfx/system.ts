/**
 * The particle simulation (spec 118).
 *
 * Pure: no three.js, no DOM, no clock. It is handed a ground sampler and an
 * optional attachment resolver, and it advances in **whole 60Hz ticks**, which is
 * the property everything else here rests on. An effect stepped by elapsed wall
 * time is a different effect at 30fps and at 144fps, and "the same seed
 * reproduces the same look" stops being something a test can assert -- which
 * would make every visual regression in this system invisible.
 *
 * ## Zero allocation, and what that actually means
 *
 * Nothing in `update()` constructs anything. Particles are indices into typed
 * arrays (`pool.ts`), effect instances are indices into a second set of typed
 * arrays here, sub-emitter spawns go through a fixed-size queue, and the scratch
 * buffer is a member. The only objects that exist after construction are the
 * compiled definitions, which are frozen and read-only.
 *
 * The one deliberate exception is `instAttachSocket`, a plain `string[]`.
 * Assigning an existing string reference into an array allocates nothing; it is
 * a slot for a name, not a construction.
 *
 * ## Two things learned the hard way, written down so they stay fixed
 *
 * A continuous emitter carries **its own generator state across ticks**. The
 * obvious version re-seeds from the instance seed each time it emits, which is
 * deterministic and completely wrong: every particle it ever produces is
 * identical, so a fountain fires one drop over and over. It looks like a working
 * emitter until somebody watches it.
 *
 * A particle carries **its own copy of its owner's scale and tint**. Reading
 * them from the instance each tick is one fewer field until an instance is
 * evicted to make room for something more important, at which point every
 * particle it left in the air changes size and colour on that frame.
 *
 * ## Presentation only
 *
 * Nothing here may influence a game outcome. It reads positions and is handed
 * events; it never decides anything the server also decides. The system can be
 * switched off entirely and the game must play identically.
 */

import { sampleCurve, sampleGradient } from './curve.js';
import { tintInto, unpackInto, VFX_PALETTE } from './palette.js';
import { applySpread, sampleShape, SHAPE } from './shapes.js';
import { ParticlePool } from './pool.js';
import { VfxRng } from './rng.js';
import { turbulence3 } from './noise.js';
import { EMISSION, RENDER, type CompiledEmitter, type CompiledRegistry } from './compile.js';
import type { PlayOptions, VfxLimits, VfxStats } from './types.js';
import type { FluidKind } from './splat.js';

/** The fixed timestep. The sim's rate, because an effect times a blow. */
export const VFX_TICK_SECONDS = 1 / 60;

/** Sub-effects may spawn sub-effects, and there it stops. */
export const MAX_SUB_DEPTH = 2;

/** Vertical speed below which a bouncing particle is considered settled. */
const REST_SPEED = 6;

/** How many deferred sub-effect spawns one tick may queue before dropping them. */
const SPAWN_QUEUE = 256;

/** Point lights the renderer is willing to drive from the effect field. */
export const MAX_VFX_LIGHTS = 8;

/** Instances are addressed by a 12-bit slot inside a handle. */
const MAX_ADDRESSABLE_INSTANCES = 0xfff;

export const DEFAULT_LIMITS: VfxLimits = {
  maxParticles: 3000,
  maxInstances: 128,
  pressureFloor: 0.25,
};

/**
 * How much of an effect gets played at each intensity setting. Index is the
 * setting; 0 is off and skips the whole update.
 */
const INTENSITY_SCALE = [0, 0.35, 0.7, 1];

/**
 * The free-capacity fraction below which each priority stops being spawned, as a
 * multiple of `pressureFloor`. Priority 3 is never refused while any capacity
 * remains, because a telegraph nobody can see is a fight nobody can play.
 */
const PRIORITY_PRESSURE = [2, 1, 0.35, 0];

export interface VfxHooks {
  /** Terrain height under a world point. Injected, so nothing here imports terrain. */
  readonly ground: (x: number, z: number) => number;
  /**
   * Where an entity's socket is now. Writes three floats at `out[at]` and returns
   * false when the entity or socket is not currently drawn -- an effect attached
   * to a body that despawned mid-flight has to survive that.
   */
  readonly attach?: (entityId: number, socket: string, out: Float32Array, at: number) => boolean;
  /** A point on an attached body's surface, for `mesh` emitter shapes. */
  readonly surface?: (entityId: number, rng: VfxRng, out: Float32Array, at: number) => boolean;
  /** Fired for `SoundSpec`. A sink today; there is no audio system to wire it to. */
  readonly sound?: (cue: string, x: number, y: number, z: number) => void;
  /**
   * A particle landed and left a stain (spec 120).
   *
   * Injected rather than owned, for the usual reason and one more: a decal
   * outlives every particle in this system and is owned by a map chunk, so the
   * particle sim has no business holding one. It reports the contact and the
   * direction of travel and forgets about it.
   */
  readonly decal?: (
    x: number,
    y: number,
    z: number,
    seed: number,
    fluid: FluidKind,
    size: number,
    dirX: number,
    dirZ: number,
  ) => void;
}

export interface VfxSystemOptions {
  readonly registry: CompiledRegistry;
  readonly hooks: VfxHooks;
  readonly limits?: VfxLimits;
  /**
   * Trail tracks available to ribbon particles. Default {@link DEFAULT_RIBBONS}.
   */
  readonly ribbonCapacity?: number;
}

/**
 * Trail tracks the system keeps by default.
 *
 * It was 128 while nothing in the library rendered as a ribbon. Blood does since
 * spec 139, and one killing blow alone asks for 24 -- so at 128 a fight with six
 * deaths in it would hand the rest -1 and quietly draw them as the short stub
 * instead of as streaks. A track is 12 samples of three floats: 512 of them is
 * 73KB, allocated once, which is the cheaper side of that trade by a distance.
 */
const DEFAULT_RIBBONS = 512;

const ATTACH = { world: 0, entity: 1, socket: 2, detach: 3 } as const;

export class VfxSystem {
  readonly pool: ParticlePool;
  readonly registry: CompiledRegistry;
  readonly limits: VfxLimits;

  /** Every emitter in the registry, flattened. `pool.emitter` indexes this. */
  private readonly emitters: readonly CompiledEmitter[];
  /** Where each effect's emitters begin in {@link emitters}. */
  private readonly emitterStart: Int32Array;

  private readonly hooks: VfxHooks;

  // --- effect instances, as arrays for the same reason particles are ---------
  private readonly maxInstances: number;
  private readonly stride: number;
  private readonly instEffect: Int32Array;
  private readonly instAge: Float32Array;
  private readonly instX: Float32Array;
  private readonly instY: Float32Array;
  private readonly instZ: Float32Array;
  private readonly instPrevX: Float32Array;
  private readonly instPrevY: Float32Array;
  private readonly instPrevZ: Float32Array;
  private readonly instRotation: Float32Array;
  private readonly instScale: Float32Array;
  private readonly instTint: Float32Array;
  private readonly instTintStrength: Float32Array;
  private readonly instAttachKind: Int32Array;
  private readonly instAttachEntity: Int32Array;
  private readonly instAttachSocket: string[];
  private readonly instStopping: Uint8Array;
  private readonly instDepth: Int32Array;
  private readonly instRefs: Int32Array;
  private readonly instGeneration: Int32Array;
  private readonly instPriority: Int32Array;
  /** Fractional particles each emitter is owed, `maxInstances * stride`. */
  private readonly instOwed: Float32Array;
  /** 1 once a burst has fired, so it fires exactly once. */
  private readonly instFired: Uint8Array;
  /** Each emitter's live generator state, carried across ticks. */
  private readonly instRngState: Int32Array;
  private liveInstances = 0;

  // --- deferred sub-effect spawns -------------------------------------------
  private readonly queueEffect = new Int32Array(SPAWN_QUEUE);
  private readonly queueXyz = new Float32Array(SPAWN_QUEUE * 3);
  private readonly queueSeed = new Int32Array(SPAWN_QUEUE);
  private readonly queueDepth = new Int32Array(SPAWN_QUEUE);
  private readonly queueTint = new Float32Array(SPAWN_QUEUE * 4);
  private queued = 0;

  // --- scratch ---------------------------------------------------------------
  /**
   * The one scratch buffer, with a fixed layout so two users cannot quietly
   * share a slot:
   *
   *   0..5   emit: spawn offset, then unit direction
   *   8..10  writeAppearance: the sampled gradient colour
   *   12..14 resolveAttachment: the socket's world position
   *   16..18 updateParticles: the turbulence vector
   *
   * Regions rather than a tightly packed array on purpose. Turbulence sat at
   * 4..6 for one draft, overlapping the direction `emit` had just written --
   * harmless only because the two never run in the same phase, which is not a
   * property anybody should have to re-derive before adding a field.
   */
  private readonly scratch = new Float32Array(24);
  private readonly rng = new VfxRng(1);
  private readonly lightData = new Float32Array(MAX_VFX_LIGHTS * 8);
  private lightCount = 0;

  private viewX = 0;
  private viewY = 0;
  private viewZ = 0;
  private hasViewpoint = false;

  private intensity = 3;
  private timeScale = 1;
  private tickDebt = 0;
  private paused = false;

  readonly stats: VfxStats = {
    liveParticles: 0,
    liveInstances: 0,
    refusedBudget: 0,
    refusedDistance: 0,
    refusedUnknown: 0,
    throttled: 0,
  };

  constructor(options: VfxSystemOptions) {
    this.registry = options.registry;
    this.hooks = options.hooks;
    this.limits = options.limits ?? DEFAULT_LIMITS;

    const flat: CompiledEmitter[] = [];
    this.emitterStart = new Int32Array(this.registry.effects.length);
    let maxEmitters = 1;
    this.registry.effects.forEach((effect, index) => {
      this.emitterStart[index] = flat.length;
      for (const emitter of effect.emitters) flat.push(emitter);
      maxEmitters = Math.max(maxEmitters, effect.emitters.length);
    });
    this.emitters = flat;
    this.stride = maxEmitters;

    this.pool = new ParticlePool(this.limits.maxParticles, options.ribbonCapacity ?? DEFAULT_RIBBONS);

    const n = Math.max(1, Math.min(MAX_ADDRESSABLE_INSTANCES, this.limits.maxInstances));
    this.maxInstances = n;
    this.instEffect = new Int32Array(n).fill(-1);
    this.instAge = new Float32Array(n);
    this.instX = new Float32Array(n);
    this.instY = new Float32Array(n);
    this.instZ = new Float32Array(n);
    this.instPrevX = new Float32Array(n);
    this.instPrevY = new Float32Array(n);
    this.instPrevZ = new Float32Array(n);
    this.instRotation = new Float32Array(n);
    this.instScale = new Float32Array(n);
    this.instTint = new Float32Array(n * 3);
    this.instTintStrength = new Float32Array(n);
    this.instAttachKind = new Int32Array(n);
    this.instAttachEntity = new Int32Array(n);
    this.instAttachSocket = new Array<string>(n).fill('');
    this.instStopping = new Uint8Array(n);
    this.instDepth = new Int32Array(n);
    this.instRefs = new Int32Array(n);
    this.instGeneration = new Int32Array(n);
    this.instPriority = new Int32Array(n);
    this.instOwed = new Float32Array(n * maxEmitters);
    this.instFired = new Uint8Array(n * maxEmitters);
    this.instRngState = new Int32Array(n * maxEmitters);
  }

  // --- settings --------------------------------------------------------------

  /** 0 off, 1 low, 2 medium, 3 full. 0 clears the field and skips the update. */
  setIntensity(intensity: number): void {
    const next = Math.max(0, Math.min(3, Math.round(intensity)));
    if (next === this.intensity) return;
    this.intensity = next;
    if (next === 0) this.clear();
  }

  getIntensity(): number {
    return this.intensity;
  }

  setTimeScale(scale: number): void {
    this.timeScale = Math.max(0, scale);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Where the camera is, for distance culling. Unset culls nothing. */
  setViewpoint(x: number, y: number, z: number): void {
    this.viewX = x;
    this.viewY = y;
    this.viewZ = z;
    this.hasViewpoint = true;
  }

  clear(): void {
    this.pool.clear();
    this.instEffect.fill(-1);
    this.instRefs.fill(0);
    this.instOwed.fill(0);
    this.instFired.fill(0);
    this.liveInstances = 0;
    this.queued = 0;
    this.lightCount = 0;
    this.tickDebt = 0;
    this.refreshStats();
  }

  resetCounters(): void {
    this.stats.refusedBudget = 0;
    this.stats.refusedDistance = 0;
    this.stats.refusedUnknown = 0;
    this.stats.throttled = 0;
  }

  // --- playing ---------------------------------------------------------------

  /**
   * Start an effect. Returns a handle, or 0 when nothing was started.
   *
   * A refusal is a normal outcome, not an error: over budget, too far away, or
   * an id nothing provides. The counters in {@link stats} say which, because "my
   * effect did not appear" has three different fixes.
   */
  play(id: string, options: PlayOptions): number {
    const index = this.registry.byId.get(id);
    if (index === undefined) {
      this.stats.refusedUnknown += 1;
      return 0;
    }
    const slot = this.start(index, options.x, options.y, options.z, options.seed, 0, options);
    return slot < 0 ? 0 : this.handleFor(slot);
  }

  /** Whether an id is in the registry at all -- what a wire adapter checks. */
  has(id: string): boolean {
    return this.registry.byId.has(id);
  }

  /**
   * Stop an effect.
   *
   * Soft by default: emitters switch off and the particles already in the air
   * finish their lives, which is what "put the torch out" means. `hard` kills
   * them where they stand, which is what an entity despawning means.
   *
   * An effect may insist on hard (spec 124). A thing that was *thrown* should
   * finish falling; a thing that is *shown* ends when the state it shows ends,
   * and an aura holds one particle for ten minutes, so a soft stop would leave
   * its sigil on the ground long after the status was gone.
   */
  stop(handle: number, hard = false): void {
    const slot = this.slotFor(handle);
    if (slot < 0) return;
    this.instStopping[slot] = 1;
    const effect = this.registry.effects[this.instEffect[slot] ?? -1];
    if (!hard && !effect?.hardStop) return;
    for (let i = this.pool.count - 1; i >= 0; i--) {
      if ((this.pool.instance[i] ?? -1) === slot) this.pool.kill(i);
    }
    this.instRefs[slot] = 0;
    this.retire(slot);
    this.refreshStats();
  }

  /** True while the handle names a live instance. */
  isLive(handle: number): boolean {
    return this.slotFor(handle) >= 0;
  }

  /** Move a world-space effect, for a caller driving its own attachment. */
  move(handle: number, x: number, y: number, z: number): void {
    const slot = this.slotFor(handle);
    if (slot < 0) return;
    this.instX[slot] = x;
    this.instY[slot] = y;
    this.instZ[slot] = z;
  }

  // --- the tick --------------------------------------------------------------

  /**
   * Advance by whole ticks.
   *
   * `ticks` is what the frame loop actually drained, so an effect's timing is a
   * function of the simulation's clock rather than of how often the browser
   * painted. The time scale goes through a debt accumulator so that half speed
   * over 2N ticks is exactly full speed over N -- not approximately.
   */
  update(ticks: number): void {
    if (this.paused || this.intensity === 0 || ticks <= 0) return;
    this.tickDebt += ticks * this.timeScale;
    let steps = Math.floor(this.tickDebt);
    if (steps <= 0) return;
    this.tickDebt -= steps;
    // A pathological catch-up must not become a freeze; the frame loop clamps
    // its own tick count for exactly the same reason.
    if (steps > 300) steps = 300;
    for (let i = 0; i < steps; i++) this.step();
    this.refreshStats();
  }

  private step(): void {
    this.updateInstances();
    this.updateParticles();
    this.flushQueue();
  }

  // --- instances -------------------------------------------------------------

  private updateInstances(): void {
    const scale = INTENSITY_SCALE[this.intensity] ?? 1;
    for (let slot = 0; slot < this.maxInstances; slot++) {
      const effectIndex = this.instEffect[slot] ?? -1;
      if (effectIndex < 0) continue;
      const effect = this.registry.effects[effectIndex];
      if (!effect) continue;

      this.instPrevX[slot] = this.instX[slot] ?? 0;
      this.instPrevY[slot] = this.instY[slot] ?? 0;
      this.instPrevZ[slot] = this.instZ[slot] ?? 0;
      this.resolveAttachment(slot);

      const age = (this.instAge[slot] ?? 0) + 1;
      this.instAge[slot] = age;
      if (effect.durationTicks > 0 && age >= effect.durationTicks) this.instStopping[slot] = 1;

      const stopping = this.instStopping[slot] === 1;
      const start = this.emitterStart[effectIndex] ?? 0;
      const base = slot * this.stride;
      let emissionDone = true;

      for (let e = 0; e < effect.emitters.length; e++) {
        const emitter = this.emitters[start + e];
        if (!emitter) continue;
        const at = base + e;

        if (emitter.emissionKind === EMISSION.burst) {
          if ((this.instFired[at] ?? 0) === 1) continue;
          if (stopping) {
            this.instFired[at] = 1;
            continue;
          }
          if (age <= emitter.delayTicks) {
            emissionDone = false;
            continue;
          }
          const count = Math.max(1, Math.round(emitter.burstCount * scale));
          this.emit(slot, at, start + e, emitter, count);
          this.instFired[at] = 1;
          if (emitter.soundOn === 2) {
            this.hooks.sound?.(emitter.soundCue, this.instX[slot] ?? 0, this.instY[slot] ?? 0, this.instZ[slot] ?? 0);
          }
          continue;
        }

        if (emitter.emissionKind === EMISSION.ramp) {
          if (age > emitter.rampTicks) continue;
          emissionDone = false;
          if (stopping) continue;
          const t = emitter.rampTicks > 0 ? age / emitter.rampTicks : 1;
          this.accrue(at, sampleCurve(emitter.rampCurve, t) * scale);
        } else if (!stopping) {
          // A rate emitter never finishes on its own; that is what `stop` is for.
          emissionDone = false;
          this.accrue(at, emitter.ratePerSecond * scale);
        }

        let owed = this.instOwed[at] ?? 0;
        while (owed >= 1) {
          if (this.emit(slot, at, start + e, emitter, 1) === 0) {
            // Out of capacity: drop what is owed rather than banking it, or the
            // moment capacity returns the emitter fires its whole backlog at once.
            this.stats.throttled += 1;
            owed = 0;
            break;
          }
          owed -= 1;
        }
        this.instOwed[at] = owed;
      }

      if (emissionDone && (this.instRefs[slot] ?? 0) <= 0) this.retire(slot);
    }
  }

  private accrue(at: number, perSecond: number): void {
    if (perSecond <= 0) return;
    this.instOwed[at] = (this.instOwed[at] ?? 0) + perSecond * VFX_TICK_SECONDS;
  }

  /**
   * Emit `count` particles from one emitter. Returns how many were born.
   *
   * `stateAt` indexes the emitter's own generator state, which is restored on
   * entry and written back on exit. That is what makes a continuous emitter's
   * hundredth particle different from its first while still being a function of
   * the instance seed alone.
   */
  private emit(slot: number, stateAt: number, emitterIndex: number, emitter: CompiledEmitter, count: number): number {
    const scratch = this.scratch;
    const rng = this.rng;
    rng.restore(this.instRngState[stateAt] ?? 1);

    const instX = this.instX[slot] ?? 0;
    const instY = this.instY[slot] ?? 0;
    const instZ = this.instZ[slot] ?? 0;
    const instScale = this.instScale[slot] ?? 1;
    const rotation = this.instRotation[slot] ?? 0;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const depth = this.instDepth[slot] ?? 0;
    const tintBase = slot * 3;
    const tintStrength = this.instTintStrength[slot] ?? 0;

    let born = 0;
    for (let i = 0; i < count; i++) {
      const index = this.pool.spawn();
      if (index < 0) break;
      born += 1;

      if (emitter.shape.kind === SHAPE.mesh && this.hooks.surface && (this.instAttachKind[slot] ?? 0) !== ATTACH.world) {
        if (!this.hooks.surface(this.instAttachEntity[slot] ?? 0, rng, scratch, 0)) {
          scratch[0] = 0;
          scratch[1] = 0;
          scratch[2] = 0;
        }
        scratch[3] = 0;
        scratch[4] = 1;
        scratch[5] = 0;
      } else {
        sampleShape(emitter.shape, rng, scratch, 0, i, count);
      }
      applySpread(rng, scratch, 3, emitter.spread);

      // The emitter's local frame, turned by the effect's rotation about Y.
      const lx = (scratch[0] ?? 0) + emitter.offsetX;
      const ly = (scratch[1] ?? 0) + emitter.offsetY;
      const lz = (scratch[2] ?? 0) + emitter.offsetZ;
      const dx = scratch[3] ?? 0;
      const dy = scratch[4] ?? 0;
      const dz = scratch[5] ?? 0;

      const px = instX + (lx * cos - lz * sin) * instScale;
      const py = instY + ly * instScale;
      const pz = instZ + (lx * sin + lz * cos) * instScale;
      const ddx = dx * cos - dz * sin;
      const ddz = dx * sin + dz * cos;

      const speed = rng.range(emitter.speedMin, emitter.speedMax);
      const pool = this.pool;
      pool.x[index] = px;
      pool.y[index] = py;
      pool.z[index] = pz;
      pool.vx[index] = ddx * speed;
      pool.vy[index] = dy * speed;
      pool.vz[index] = ddz * speed;
      pool.life[index] = Math.max(1, Math.floor(rng.range(emitter.lifeMin, emitter.lifeMax + 1)));
      pool.rot[index] = 0;
      pool.rotVel[index] = rng.range(emitter.angMin, emitter.angMax);
      pool.frame[index] = emitter.randomStartFrame ? Math.floor(rng.float() * emitter.frames) : 0;
      pool.seed[index] = (rng.float() * 0x7fffffff) | 0;
      pool.emitter[index] = emitterIndex;
      pool.instance[index] = slot;
      pool.batch[index] = emitter.batch;
      pool.scale[index] = instScale;
      pool.tintR[index] = this.instTint[tintBase] ?? 1;
      pool.tintG[index] = this.instTint[tintBase + 1] ?? 1;
      pool.tintB[index] = this.instTint[tintBase + 2] ?? 1;
      pool.tintStrength[index] = tintStrength;

      if (emitter.render === RENDER.ribbon) {
        const track = pool.claimRibbon();
        pool.ribbon[index] = track;
        if (track >= 0) pool.pushRibbon(track, px, py, pz);
      }

      this.writeAppearance(index, emitter, 0);
      this.instRefs[slot] = (this.instRefs[slot] ?? 0) + 1;

      if (emitter.onSpawnEffect >= 0 && depth < MAX_SUB_DEPTH) {
        this.enqueue(emitter.onSpawnEffect, px, py, pz, pool.seed[index] ?? 0, depth + 1, slot);
      }
    }

    this.instRngState[stateAt] = rng.peek() | 0;
    return born;
  }

  // --- particles -------------------------------------------------------------

  private updateParticles(): void {
    const pool = this.pool;
    const dt = VFX_TICK_SECONDS;

    for (let i = pool.count - 1; i >= 0; i--) {
      const emitter = this.emitters[pool.emitter[i] ?? 0];
      if (!emitter) {
        pool.kill(i);
        continue;
      }
      const slot = pool.instance[i] ?? -1;
      const depth = slot >= 0 ? this.instDepth[slot] ?? 0 : MAX_SUB_DEPTH;

      const age = (pool.age[i] ?? 0) + 1;
      const life = pool.life[i] ?? 1;
      if (age >= life) {
        if (emitter.onDeathEffect >= 0 && depth < MAX_SUB_DEPTH) {
          this.enqueue(emitter.onDeathEffect, pool.x[i] ?? 0, pool.y[i] ?? 0, pool.z[i] ?? 0, pool.seed[i] ?? 0, depth + 1, slot);
        }
        this.release(slot);
        pool.kill(i);
        continue;
      }
      pool.age[i] = age;
      const t = age / life;

      // A parented particle rides its owner's movement. Stored in world space and
      // displaced by the owner's delta, rather than stored in local space:
      // integration, collision and the renderer then all work in one frame.
      if (!emitter.worldSpace && slot >= 0) {
        pool.x[i] = (pool.x[i] ?? 0) + (this.instX[slot] ?? 0) - (this.instPrevX[slot] ?? 0);
        pool.y[i] = (pool.y[i] ?? 0) + (this.instY[slot] ?? 0) - (this.instPrevY[slot] ?? 0);
        pool.z[i] = (pool.z[i] ?? 0) + (this.instZ[slot] ?? 0) - (this.instPrevZ[slot] ?? 0);
      }

      let vx = pool.vx[i] ?? 0;
      let vy = pool.vy[i] ?? 0;
      let vz = pool.vz[i] ?? 0;
      const resting = pool.resting[i] === 1;

      if (!resting) {
        vy += emitter.gravity * dt;
        vx += emitter.accelX * dt;
        vy += emitter.accelY * dt;
        vz += emitter.accelZ * dt;

        if (emitter.turbAmplitude > 0) {
          const f = emitter.turbFrequency;
          const push = emitter.turbAmplitude * dt;
          turbulence3((pool.x[i] ?? 0) * f, (pool.y[i] ?? 0) * f, (pool.z[i] ?? 0) * f, pool.seed[i] ?? 0, this.scratch, 16);
          vx += (this.scratch[16] ?? 0) * push;
          vy += (this.scratch[17] ?? 0) * push;
          vz += (this.scratch[18] ?? 0) * push;
        }
      }

      if (emitter.drag > 0) {
        const keep = Math.max(0, 1 - emitter.drag * dt);
        vx *= keep;
        vy *= keep;
        vz *= keep;
      }

      // Authored, not physical: it scales the *step*, so it does not compound
      // into the stored velocity the way another drag term would.
      const vScale = emitter.velocityScaleCurve ? sampleCurve(emitter.velocityScaleCurve, t) : 1;
      const px = (pool.x[i] ?? 0) + vx * vScale * dt;
      let py = (pool.y[i] ?? 0) + vy * vScale * dt;
      const pz = (pool.z[i] ?? 0) + vz * vScale * dt;

      if (emitter.hasCollision) {
        const groundY = this.hooks.ground(px, pz);
        if (py <= groundY) {
          py = groundY;
          const impact = Math.abs(vy);

          if (!resting) {
            if (emitter.onCollideEffect >= 0 && depth < MAX_SUB_DEPTH) {
              this.enqueue(emitter.onCollideEffect, px, py, pz, pool.seed[i] ?? 0, depth + 1, slot);
            }
            if (emitter.soundOn === 3) this.hooks.sound?.(emitter.soundCue, px, py, pz);
            pool.bounces[i] = (pool.bounces[i] ?? 0) + 1;

            // The stain, at the moment of contact and only on the first one: a
            // drop that bounces twice has not bled twice.
            if (emitter.decalFluid !== null && this.hooks.decal && (pool.bounces[i] ?? 0) === 1) {
              const seed = pool.seed[i] ?? 0;
              // Drawn from the particle's own seed rather than the shared
              // generator, so a decal is a function of the particle that made it
              // and replaying the effect lays the same stains down.
              this.rng.restore(seed | 0);
              if (this.rng.float() < emitter.decalChance) {
                const size = this.rng.range(emitter.decalMin, emitter.decalMax);
                // Direction of travel across the ground: which way it was thrown.
                this.hooks.decal(px, py, pz, seed, emitter.decalFluid, size, vx, vz);
              }
            }
          }

          const spent = emitter.dieOnCollide || (pool.bounces[i] ?? 0) > emitter.maxBounces;
          if (spent && (emitter.dieOnCollide || impact > REST_SPEED)) {
            this.release(slot);
            pool.kill(i);
            continue;
          }

          const keep = Math.max(0, 1 - emitter.friction);
          vx *= keep;
          vz *= keep;
          const bounced = -vy * emitter.restitution;
          if (Math.abs(bounced) < REST_SPEED) {
            // Settled. Held on the ground rather than integrated through it, so
            // gravity cannot fire a bounce -- and a sub-effect -- every tick for
            // the rest of its life.
            vy = 0;
            pool.resting[i] = 1;
          } else {
            vy = bounced;
          }
        }
      }

      pool.x[i] = px;
      pool.y[i] = py;
      pool.z[i] = pz;
      pool.vx[i] = vx;
      pool.vy[i] = vy;
      pool.vz[i] = vz;
      pool.rot[i] = (pool.rot[i] ?? 0) + (pool.rotVel[i] ?? 0) * dt;

      if (emitter.frames > 1 && emitter.spriteFps > 0) {
        const advanced = (pool.frame[i] ?? 0) + emitter.spriteFps * dt;
        pool.frame[i] = emitter.spriteOnce ? Math.min(advanced, emitter.frames - 1) : advanced % emitter.frames;
      }

      const track = pool.ribbon[i] ?? -1;
      if (track >= 0 && pool.ribbonHeadDistance(track, px, py, pz) >= emitter.ribbonSpacing) {
        pool.pushRibbon(track, px, py, pz);
      }

      this.writeAppearance(i, emitter, t);
    }
  }

  /** One fewer particle referencing an instance. */
  private release(slot: number): void {
    if (slot < 0) return;
    this.instRefs[slot] = Math.max(0, (this.instRefs[slot] ?? 0) - 1);
  }

  /** Size, rotation, colour and alpha at normalized life `t`. */
  private writeAppearance(index: number, emitter: CompiledEmitter, t: number): void {
    const pool = this.pool;
    pool.size[index] = sampleCurve(emitter.sizeCurve, t) * (pool.scale[index] ?? 1);
    pool.a[index] = sampleCurve(emitter.alphaCurve, t);
    if (emitter.rotationCurve) pool.rot[index] = sampleCurve(emitter.rotationCurve, t);

    const scratch = this.scratch;
    sampleGradient(emitter.colorGradient, t, scratch, 8);
    const strength = pool.tintStrength[index] ?? 0;
    if (strength > 0) {
      tintInto(scratch, 8, pool.tintR[index] ?? 1, pool.tintG[index] ?? 1, pool.tintB[index] ?? 1, strength);
    }
    pool.r[index] = scratch[8] ?? 0;
    pool.g[index] = scratch[9] ?? 0;
    pool.b[index] = scratch[10] ?? 0;
  }

  // --- deferred sub-effects --------------------------------------------------

  private enqueue(effectIndex: number, x: number, y: number, z: number, seed: number, depth: number, parentSlot: number): void {
    if (this.queued >= SPAWN_QUEUE) return;
    const i = this.queued;
    this.queued += 1;
    this.queueEffect[i] = effectIndex;
    this.queueXyz[i * 3] = x;
    this.queueXyz[i * 3 + 1] = y;
    this.queueXyz[i * 3 + 2] = z;
    this.queueSeed[i] = seed;
    this.queueDepth[i] = depth;
    // A sub-effect inherits its parent's tint, which is what makes one fire
    // definition tint blue all the way down into its own embers and its smoke.
    const base = i * 4;
    if (parentSlot >= 0) {
      const p = parentSlot * 3;
      this.queueTint[base] = this.instTint[p] ?? 1;
      this.queueTint[base + 1] = this.instTint[p + 1] ?? 1;
      this.queueTint[base + 2] = this.instTint[p + 2] ?? 1;
      this.queueTint[base + 3] = this.instTintStrength[parentSlot] ?? 0;
    } else {
      this.queueTint[base + 3] = 0;
    }
  }

  /**
   * Play everything queued this tick.
   *
   * Deferred rather than played inline so spawning cannot mutate the pool while
   * it is being walked, and so the order sub-effects appear in is a function of
   * the tick rather than of where a swap-with-last happened to land.
   */
  private flushQueue(): void {
    const count = this.queued;
    this.queued = 0;
    for (let i = 0; i < count; i++) {
      const effectIndex = this.queueEffect[i] ?? -1;
      if (effectIndex < 0) continue;
      const slot = this.start(
        effectIndex,
        this.queueXyz[i * 3] ?? 0,
        this.queueXyz[i * 3 + 1] ?? 0,
        this.queueXyz[i * 3 + 2] ?? 0,
        this.queueSeed[i] ?? 0,
        this.queueDepth[i] ?? 1,
        null,
      );
      if (slot < 0) continue;
      const base = i * 4;
      const strength = this.queueTint[base + 3] ?? 0;
      if (strength > 0) {
        const p = slot * 3;
        this.instTint[p] = this.queueTint[base] ?? 1;
        this.instTint[p + 1] = this.queueTint[base + 1] ?? 1;
        this.instTint[p + 2] = this.queueTint[base + 2] ?? 1;
        this.instTintStrength[slot] = strength;
      }
    }
  }

  // --- instance lifecycle ----------------------------------------------------

  /** Create an instance, or -1 when it was refused. The one path in. */
  private start(
    effectIndex: number,
    x: number,
    y: number,
    z: number,
    seed: number,
    depth: number,
    options: PlayOptions | null,
  ): number {
    if (this.intensity === 0) return -1;
    const effect = this.registry.effects[effectIndex];
    if (!effect) return -1;

    if (this.hasViewpoint && Number.isFinite(effect.cullDistance)) {
      const dx = x - this.viewX;
      const dy = y - this.viewY;
      const dz = z - this.viewZ;
      if (dx * dx + dy * dy + dz * dz > effect.cullDistance * effect.cullDistance) {
        this.stats.refusedDistance += 1;
        return -1;
      }
    }

    const freeFraction = this.pool.free / this.pool.capacity;
    const needed = (PRIORITY_PRESSURE[effect.priority] ?? 0) * this.limits.pressureFloor;
    if (this.pool.free <= 0 || (needed > 0 && freeFraction < needed)) {
      this.stats.refusedBudget += 1;
      return -1;
    }

    const slot = this.claimInstance(effect.priority, x, y, z);
    if (slot < 0) {
      this.stats.refusedBudget += 1;
      return -1;
    }

    this.instEffect[slot] = effectIndex;
    this.instAge[slot] = 0;
    this.instX[slot] = x;
    this.instY[slot] = y;
    this.instZ[slot] = z;
    this.instRotation[slot] = options?.rotation ?? 0;
    this.instScale[slot] = options?.scale ?? 1;
    this.instStopping[slot] = 0;
    this.instDepth[slot] = depth;
    this.instRefs[slot] = 0;
    this.instPriority[slot] = effect.priority;
    this.liveInstances += 1;

    const tint = options?.tint;
    if (tint) {
      unpackInto(VFX_PALETTE[tint], this.instTint, slot * 3);
      this.instTintStrength[slot] = options?.tintStrength ?? 1;
    } else {
      this.instTintStrength[slot] = 0;
    }

    const attach = options?.attach;
    if (attach && attach.kind !== 'world') {
      this.instAttachKind[slot] = ATTACH[attach.kind];
      this.instAttachEntity[slot] = attach.entityId;
      const socket = attach.kind === 'socket' ? attach.socket : attach.kind === 'detach' ? attach.socket ?? '' : '';
      this.instAttachSocket[slot] = socket;
      if (attach.kind === 'detach') {
        // Born at the attachment and then left behind: resolved once, here, and
        // never asked again. `resolveAttachment` deliberately skips this kind, so
        // the one lookup it does get is this one.
        if (this.hooks.attach?.(attach.entityId, socket, this.scratch, 12)) {
          this.instX[slot] = this.scratch[12] ?? x;
          this.instY[slot] = this.scratch[13] ?? y;
          this.instZ[slot] = this.scratch[14] ?? z;
        }
      } else {
        this.resolveAttachment(slot);
      }
    } else {
      this.instAttachKind[slot] = ATTACH.world;
      this.instAttachEntity[slot] = 0;
      this.instAttachSocket[slot] = '';
    }

    this.instPrevX[slot] = this.instX[slot] ?? x;
    this.instPrevY[slot] = this.instY[slot] ?? y;
    this.instPrevZ[slot] = this.instZ[slot] ?? z;

    // Each emitter gets its own stream, seeded from the play seed, the effect and
    // its own index -- so the same seed on two effects does not play them in
    // lockstep, and two emitters of one effect do not draw the same numbers.
    const base = slot * this.stride;
    for (let i = 0; i < this.stride; i++) {
      this.instOwed[base + i] = 0;
      this.instFired[base + i] = 0;
      this.rng.reset((Math.imul(seed | 0, 2654435761) ^ Math.imul(effectIndex + 1, 40503) ^ Math.imul(i + 1, 0x9e3779b1)) | 0);
      this.instRngState[base + i] = this.rng.peek() | 0;
    }

    const start = this.emitterStart[effectIndex] ?? 0;
    for (let i = 0; i < effect.emitters.length; i++) {
      const emitter = this.emitters[start + i];
      if (emitter?.soundOn === 1) this.hooks.sound?.(emitter.soundCue, x, y, z);
    }

    this.refreshStats();
    return slot;
  }

  /**
   * A free instance slot, or one taken from something less important.
   *
   * Eviction is by priority first and distance second. The victim's particles are
   * cut loose rather than killed -- they carry their own scale and tint, so they
   * finish their lives looking exactly as they did, and a displaced effect fades
   * instead of vanishing mid-frame.
   */
  private claimInstance(priority: number, x: number, y: number, z: number): number {
    for (let i = 0; i < this.maxInstances; i++) {
      if ((this.instEffect[i] ?? -1) < 0) return i;
    }

    let victim = -1;
    let victimScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.maxInstances; i++) {
      const other = this.instPriority[i] ?? 0;
      if (other > priority) continue;
      const dx = (this.instX[i] ?? 0) - x;
      const dy = (this.instY[i] ?? 0) - y;
      const dz = (this.instZ[i] ?? 0) - z;
      // Lower priority first; among equals, the furthest away.
      const score = (priority - other) * 1e9 + dx * dx + dy * dy + dz * dz;
      if (score > victimScore) {
        victimScore = score;
        victim = i;
      }
    }
    if (victim < 0) return -1;

    for (let i = this.pool.count - 1; i >= 0; i--) {
      if ((this.pool.instance[i] ?? -1) === victim) this.pool.instance[i] = -1;
    }
    this.instRefs[victim] = 0;
    this.retire(victim);
    return victim;
  }

  private retire(slot: number): void {
    if ((this.instEffect[slot] ?? -1) < 0) return;
    this.instEffect[slot] = -1;
    this.instGeneration[slot] = ((this.instGeneration[slot] ?? 0) + 1) & 0x7ffff;
    this.liveInstances = Math.max(0, this.liveInstances - 1);
  }

  private resolveAttachment(slot: number): void {
    const kind = this.instAttachKind[slot] ?? ATTACH.world;
    if (kind === ATTACH.world || kind === ATTACH.detach) return;
    const resolver = this.hooks.attach;
    if (!resolver) return;
    const socket = kind === ATTACH.socket ? this.instAttachSocket[slot] ?? '' : '';
    if (resolver(this.instAttachEntity[slot] ?? 0, socket, this.scratch, 12)) {
      this.instX[slot] = this.scratch[12] ?? 0;
      this.instY[slot] = this.scratch[13] ?? 0;
      this.instZ[slot] = this.scratch[14] ?? 0;
    }
    // A body that stopped being drawn leaves the effect where it was, which is
    // the only sane answer: a torch does not teleport to the origin because the
    // unit carrying it was culled.
  }

  private handleFor(slot: number): number {
    return ((this.instGeneration[slot] ?? 0) << 12) | (slot + 1);
  }

  private slotFor(handle: number): number {
    if (handle <= 0) return -1;
    const slot = (handle & MAX_ADDRESSABLE_INSTANCES) - 1;
    if (slot < 0 || slot >= this.maxInstances) return -1;
    if ((this.instEffect[slot] ?? -1) < 0) return -1;
    if ((this.instGeneration[slot] ?? 0) !== handle >>> 12) return -1;
    return slot;
  }

  // --- readouts --------------------------------------------------------------

  private refreshStats(): void {
    this.stats.liveParticles = this.pool.count;
    this.stats.liveInstances = this.liveInstances;
  }

  /**
   * The first few particles carrying a light, packed for the renderer as
   * `x, y, z, r, g, b, intensity, radius`. Returns how many were written.
   *
   * A fixed pool rather than a light per ember: a scene whose light count changes
   * between frames is a scene that recompiles every material.
   */
  collectLights(): number {
    this.lightCount = 0;
    const pool = this.pool;
    for (let i = 0; i < pool.count && this.lightCount < MAX_VFX_LIGHTS; i++) {
      const emitter = this.emitters[pool.emitter[i] ?? 0];
      if (!emitter?.hasLight) continue;
      const t = (pool.age[i] ?? 0) / (pool.life[i] ?? 1);
      const intensity = sampleCurve(emitter.lightCurve, t);
      if (intensity <= 0.01) continue;
      const at = this.lightCount * 8;
      this.lightData[at] = pool.x[i] ?? 0;
      this.lightData[at + 1] = pool.y[i] ?? 0;
      this.lightData[at + 2] = pool.z[i] ?? 0;
      this.lightData[at + 3] = emitter.lightR;
      this.lightData[at + 4] = emitter.lightG;
      this.lightData[at + 5] = emitter.lightB;
      this.lightData[at + 6] = intensity;
      this.lightData[at + 7] = emitter.lightRadius;
      this.lightCount += 1;
      if (emitter.lightLeadOnly) {
        // One light for the whole emitter, not one per particle: a shower of
        // forty sparks is one glow, and forty would be forty times the cost for
        // an image nobody could tell apart.
        break;
      }
    }
    return this.lightCount;
  }

  get lights(): Float32Array {
    return this.lightData;
  }

  /** The compiled emitter behind a particle, for the renderer's batching. */
  emitterAt(particleIndex: number): CompiledEmitter | undefined {
    return this.emitters[this.pool.emitter[particleIndex] ?? 0];
  }

  /** How many distinct draw calls the registry can produce. */
  get batchCount(): number {
    return this.registry.batches.length;
  }
}
