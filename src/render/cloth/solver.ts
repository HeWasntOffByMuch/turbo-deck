import { snoise } from '../noise.js';
import type { CapsuleSet } from './colliders.js';
import type { ClothGeometry } from './geometry.js';
import { LINK_BEND } from './geometry.js';
import { GRAVITY, type RobeTuning } from './params.js';

/**
 * The cloth solver (spec 037): position-based dynamics over one {@link ClothGeometry}.
 *
 * Pure TypeScript over flat `Float64Array`s -- no three.js, no DOM, no clock, no
 * `Math.random`. Everything time-varying comes in through `step`'s arguments, so
 * the same geometry, tuning and input sequence always produces the same
 * positions, and the whole thing runs (and is tested) in Node.
 *
 * ## Why PBD
 *
 * Force-based mass-spring cloth needs stiff springs to look like fabric, and
 * stiff springs need small timesteps or they explode. PBD instead *projects*
 * positions to satisfy constraints, which is unconditionally stable at any
 * timestep: the worst a bad frame can do is make the cloth look soft for a
 * moment. For a character garment that has to survive a variable render `dt`,
 * a paused debug frame and a tab-switch stall, that trade is the right one --
 * "stable simulation over expensive realism", as the brief puts it.
 *
 * ## Why world space
 *
 * The particles live in **world space**; only the attachment rings are driven by
 * the skeleton. Nothing in here knows what "running" or "turning" or "landing"
 * is -- the character simply moves its pins, and lag, inertia, overshoot, sway
 * and settling all fall out of the solve. That is the difference between fabric
 * and a set of per-motion animations, and it is why the piece list can grow
 * without the motion code growing with it.
 *
 * ## Per-frame allocation
 *
 * Every buffer is allocated in the constructor and reused. `step` allocates
 * nothing: no closures, no temporaries, no array literals. Reads out of the
 * typed arrays are cast (`as number`) rather than defaulted, because
 * `noUncheckedIndexedAccess` would otherwise make every read a branch -- the
 * indices are all derived from `count`/`linkCount` and cannot be out of range.
 */

/** Everything the outside world tells the solver about this frame. */
export interface ClothStepContext {
  /**
   * `3 * count` world-space **skinned reference positions**: where each particle
   * would be if the garment were rigidly attached to the bones. Pinned particles
   * are driven to it exactly; free ones are pulled toward it by `springStrength`
   * / `recoverySpeed`, and it is the recovery state for any particle that goes
   * non-finite.
   */
  readonly ref: Float64Array;
  /** Body capsules to push out of; only those sharing the piece's mask are tested. */
  readonly colliders: CapsuleSet;
  /** World wind velocity (units/s) and its 0..1 per-particle variation. */
  windX: number;
  windY: number;
  windZ: number;
  windTurbulence: number;
  /** The character's world velocity (units/s), for `movementInfluence`. */
  bodyVelX: number;
  bodyVelY: number;
  bodyVelZ: number;
  /** The character's world acceleration (units/s^2), for `inertiaMultiplier`. */
  bodyAccX: number;
  bodyAccY: number;
  bodyAccZ: number;
  /** 0..1, 1 when the character is standing still: gates idle sway and recovery. */
  idle: number;
  /** Ground height the cloth may not pass through. */
  groundY: number;
  /** Monotonic seconds, for the noise streams. Never read from a clock in here. */
  time: number;
  /** The figure's uniform scale, so rest lengths and margins scale with the body. */
  scale: number;
}

/** A fresh, zeroed step context the rig fills in each frame. */
export function createStepContext(ref: Float64Array, colliders: CapsuleSet): ClothStepContext {
  return {
    ref,
    colliders,
    windX: 0,
    windY: 0,
    windZ: 0,
    windTurbulence: 0,
    bodyVelX: 0,
    bodyVelY: 0,
    bodyVelZ: 0,
    bodyAccX: 0,
    bodyAccY: 0,
    bodyAccZ: 0,
    idle: 1,
    groundY: 0,
    time: 0,
    scale: 1,
  };
}

/** Largest frame the solver will integrate in one go; longer stalls are dropped. */
const MAX_FRAME_DT = 0.05;
/** Speed ceiling (world units/s at scale 1) so nothing can be flung off-screen. */
const MAX_SPEED = 2500;
/** How far above the ground plane the fabric is held, at scale 1. */
const GROUND_CLEARANCE = 0.4;

export class ClothSolver {
  /** `3 * count` current world positions. Read by the renderer; never reallocated. */
  readonly pos: Float64Array;
  /** `3 * count` current world velocities. */
  readonly vel: Float64Array;
  /** `3 * count` unit vertex normals, recomputed each step (drives wind pressure). */
  readonly normal: Float64Array;
  /** `count` inverse masses: 0 pins a particle, 1 frees it. */
  readonly invMass: Float64Array;

  /** Substep-start positions, so velocity can absorb the constraint response. */
  private readonly prevPos: Float64Array;
  /** Last frame's pin targets, so pins interpolate smoothly across substeps. */
  private readonly pinPrev: Float64Array;
  /** Pending one-shot velocity kick (jump/landing), applied on the next step. */
  private impulseX = 0;
  private impulseY = 0;
  private impulseZ = 0;
  private started = false;

  constructor(readonly geo: ClothGeometry) {
    const n = geo.count;
    this.pos = new Float64Array(n * 3);
    this.vel = new Float64Array(n * 3);
    this.normal = new Float64Array(n * 3);
    this.prevPos = new Float64Array(n * 3);
    this.pinPrev = new Float64Array(n * 3);
    this.invMass = new Float64Array(n);
    // Uniform mass: `fabricWeight` divides the *forces* instead of appearing
    // here, so changing it never changes how the constraint solve distributes
    // corrections. Pins are infinitely heavy (invMass 0) by definition.
    for (let i = 0; i < n; i++) this.invMass[i] = geo.pinned[i] ? 0 : 1;
  }

  /** Drop the whole piece onto its reference pose, at rest. */
  reset(ref: Float64Array): void {
    this.pos.set(ref);
    this.prevPos.set(ref);
    this.pinPrev.set(ref);
    this.vel.fill(0);
    this.impulseX = 0;
    this.impulseY = 0;
    this.impulseZ = 0;
    this.started = true;
    this.computeNormals();
  }

  /**
   * Add a one-shot velocity kick to every free particle, applied at the start of
   * the next step. Used for the discrete events physics cannot infer from pin
   * motion alone: the push-off of a jump and the slap of a landing.
   */
  addImpulse(x: number, y: number, z: number): void {
    if (!Number.isFinite(x + y + z)) return;
    this.impulseX += x;
    this.impulseY += y;
    this.impulseZ += z;
  }

  /** Worst current stretch as a multiple of rest length, for the debug readout. */
  maxStretchRatio(): number {
    const { link, linkRest, linkCount } = this.geo;
    const p = this.pos;
    let worst = 1;
    for (let k = 0; k < linkCount; k++) {
      const rest = linkRest[k] as number;
      if (rest < 1e-9) continue;
      const a = (link[k * 2] as number) * 3;
      const b = (link[k * 2 + 1] as number) * 3;
      const len = Math.hypot(
        (p[b] as number) - (p[a] as number),
        (p[b + 1] as number) - (p[a + 1] as number),
        (p[b + 2] as number) - (p[a + 2] as number),
      );
      // Rest lengths are stored at scale 1; compare against the scaled length by
      // dividing out the scale the caller last simulated at (see `lastScale`).
      const ratio = len / (rest * this.lastScale);
      if (ratio > worst) worst = ratio;
    }
    return worst;
  }

  /** Total kinetic energy (mass-normalised), for settling tests and diagnostics. */
  kineticEnergy(): number {
    const v = this.vel;
    let sum = 0;
    for (let i = 0; i < v.length; i += 3) {
      sum += (v[i] as number) ** 2 + (v[i + 1] as number) ** 2 + (v[i + 2] as number) ** 2;
    }
    return sum * 0.5;
  }

  private lastScale = 1;

  /**
   * Advance the piece by `dt` seconds. A non-positive or non-finite `dt` (a
   * paused debug frame) holds the current pose rather than integrating garbage.
   */
  step(dt: number, t: RobeTuning, ctx: ClothStepContext): void {
    if (!this.started) this.reset(ctx.ref);
    if (!Number.isFinite(dt) || dt <= 0) return;
    const scale = Number.isFinite(ctx.scale) && ctx.scale > 0 ? ctx.scale : 1;
    this.lastScale = scale;

    // Cap the frame: a tab-switch stall must not integrate half a second of
    // gravity in one go and snap every tether taut.
    const frame = Math.min(dt, MAX_FRAME_DT);
    const substeps = Math.max(1, Math.min(8, Math.round(t.substeps)));
    const h = frame / substeps;
    const iterations = Math.max(1, Math.min(16, Math.round(t.iterations)));

    // Iteration-count-independent stiffness: applying `k` once per iteration
    // compounds, so invert that compounding here. Without it, dragging the
    // `iterations` slider would silently change how stiff the fabric feels.
    const kStretch = 1 - Math.pow(1 - clamp01(t.stiffness), 1 / iterations);
    const kBend = 1 - Math.pow(1 - clamp01(t.bendStiffness), 1 / iterations);

    // Stage order matters. Pins move first so the constraint sweeps propagate
    // outward from where the body actually is; the tether clamp runs *last* so
    // `maxStretch` is a guarantee at the end of every substep rather than
    // something a later stage can undo. Collision and the ground clamp sit just
    // before it: a tether pull-in can in principle drag an overstretched
    // particle back through the body, but that only happens when the fabric has
    // already been flung further than it is allowed to go, and a brief graze is
    // a far cheaper artefact than a visibly ballooning robe.
    for (let s = 0; s < substeps; s++) {
      const alpha = (s + 1) / substeps;
      this.integrate(h, t, ctx, s === 0);
      this.applyPins(ctx, alpha);
      for (let it = 0; it < iterations; it++) this.solveLinks(kStretch, kBend, scale);
      this.solveReference(h, t, ctx);
      this.solveColliders(t, ctx, scale);
      this.solveGround(ctx, scale);
      this.solveTethers(t, scale);
      this.finishVelocities(h, scale);
      this.repairNonFinite(ctx);
    }

    this.pinPrev.set(ctx.ref);
    this.computeNormals();
  }

  // --- step stages --------------------------------------------------------

  /**
   * Apply forces and predict positions. All the aerodynamics live here: drag
   * against the relative air velocity, wind pressure projected onto the surface
   * normal (so a panel broadside to the wind billows and an edge-on one slices),
   * the pseudo-force of the character accelerating underneath, and the idle
   * noise that keeps a standing figure from being perfectly still.
   */
  private integrate(h: number, t: RobeTuning, ctx: ClothStepContext, firstSubstep: boolean): void {
    const { count, seed } = this.geo;
    const p = this.pos;
    const v = this.vel;
    const n = this.normal;
    const prev = this.prevPos;
    const invW = 1 / Math.max(1e-3, t.fabricWeight);
    const gravity = -GRAVITY * t.gravityMultiplier;
    const damp = Math.exp(-t.damping * h);
    const drag = t.airResistance * invW;
    const press = t.windInfluence * invW;
    const sway = t.idleSway * clamp01(ctx.idle);
    const inertia = t.inertiaMultiplier;
    // Extra apparent headwind from the character's own travel (artistic; the
    // cloth's own drag through still air already streams it somewhat).
    const airX = ctx.windX - ctx.bodyVelX * t.movementInfluence;
    const airY = ctx.windY - ctx.bodyVelY * t.movementInfluence;
    const airZ = ctx.windZ - ctx.bodyVelZ * t.movementInfluence;
    const turb = clamp01(ctx.windTurbulence);
    const maxSpeed = MAX_SPEED * ctx.scale;
    const time = ctx.time;

    const kickX = firstSubstep ? this.impulseX : 0;
    const kickY = firstSubstep ? this.impulseY : 0;
    const kickZ = firstSubstep ? this.impulseZ : 0;
    if (firstSubstep) {
      this.impulseX = 0;
      this.impulseY = 0;
      this.impulseZ = 0;
    }

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      prev[i3] = p[i3] as number;
      prev[i3 + 1] = p[i3 + 1] as number;
      prev[i3 + 2] = p[i3 + 2] as number;
      if ((this.invMass[i] as number) === 0) continue;

      let vx = (v[i3] as number) + kickX;
      let vy = (v[i3 + 1] as number) + kickY;
      let vz = (v[i3 + 2] as number) + kickZ;

      // Per-particle gust variation, so a panel is not shoved as one rigid sheet.
      const sd = seed[i] as number;
      const gv = 1 + turb * snoise(sd, time * 0.9);
      const relX = airX * gv - vx;
      const relY = airY * gv - vy;
      const relZ = airZ * gv - vz;

      const nx = n[i3] as number;
      const ny = n[i3 + 1] as number;
      const nz = n[i3 + 2] as number;
      const pressure = press * (nx * relX + ny * relY + nz * relZ);

      let ax = relX * drag + nx * pressure - ctx.bodyAccX * inertia;
      let ay = gravity + relY * drag + ny * pressure - ctx.bodyAccY * inertia;
      let az = relZ * drag + nz * pressure - ctx.bodyAccZ * inertia;

      if (sway > 0) {
        ax += snoise(sd + 101, time * 0.31) * sway;
        ay += snoise(sd + 211, time * 0.23) * sway * 0.35;
        az += snoise(sd + 307, time * 0.27) * sway;
      }

      vx = (vx + ax * h) * damp;
      vy = (vy + ay * h) * damp;
      vz = (vz + az * h) * damp;

      const speed = Math.hypot(vx, vy, vz);
      if (speed > maxSpeed) {
        const k = maxSpeed / speed;
        vx *= k;
        vy *= k;
        vz *= k;
      }

      v[i3] = vx;
      v[i3 + 1] = vy;
      v[i3 + 2] = vz;
      p[i3] = (p[i3] as number) + vx * h;
      p[i3 + 1] = (p[i3 + 1] as number) + vy * h;
      p[i3 + 2] = (p[i3 + 2] as number) + vz * h;
    }
  }

  /** One Gauss-Seidel sweep of the distance constraints. */
  private solveLinks(kStretch: number, kBend: number, scale: number): void {
    const { link, linkRest, linkKind, linkCount } = this.geo;
    const p = this.pos;
    const w = this.invMass;
    for (let k = 0; k < linkCount; k++) {
      const ia = link[k * 2] as number;
      const ib = link[k * 2 + 1] as number;
      const wa = w[ia] as number;
      const wb = w[ib] as number;
      const wsum = wa + wb;
      if (wsum === 0) continue;
      const a = ia * 3;
      const b = ib * 3;
      const dx = (p[b] as number) - (p[a] as number);
      const dy = (p[b + 1] as number) - (p[a + 1] as number);
      const dz = (p[b + 2] as number) - (p[a + 2] as number);
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-9) continue;
      const rest = (linkRest[k] as number) * scale;
      const stiff = (linkKind[k] as number) === LINK_BEND ? kBend : kStretch;
      const corr = ((len - rest) / len) * stiff;
      const ca = (wa / wsum) * corr;
      const cb = (wb / wsum) * corr;
      p[a] = (p[a] as number) + dx * ca;
      p[a + 1] = (p[a + 1] as number) + dy * ca;
      p[a + 2] = (p[a + 2] as number) + dz * ca;
      p[b] = (p[b] as number) - dx * cb;
      p[b + 1] = (p[b + 1] as number) - dy * cb;
      p[b + 2] = (p[b + 2] as number) - dz * cb;
    }
  }

  /**
   * Long-range attachment: hard-clamp every particle's distance from its pinned
   * anchor. The distance constraints alone converge slowly over a long panel, so
   * a hard yank (a teleport, a spike in `dt`) can visibly stretch the robe before
   * they catch up. This one pass makes `maxStretch` a guarantee rather than a
   * tendency, which is what lets the rest of the solve stay soft and cheap.
   */
  private solveTethers(t: RobeTuning, scale: number): void {
    const { count, anchor, anchorRest } = this.geo;
    const p = this.pos;
    const w = this.invMass;
    const maxStretch = Math.max(1, t.maxStretch);
    for (let i = 0; i < count; i++) {
      if ((w[i] as number) === 0) continue;
      const maxLen = (anchorRest[i] as number) * scale * maxStretch;
      const a = (anchor[i] as number) * 3;
      const i3 = i * 3;
      const dx = (p[i3] as number) - (p[a] as number);
      const dy = (p[i3 + 1] as number) - (p[a + 1] as number);
      const dz = (p[i3 + 2] as number) - (p[a + 2] as number);
      const len = Math.hypot(dx, dy, dz);
      if (len <= maxLen || len < 1e-9) continue;
      const k = maxLen / len;
      p[i3] = (p[a] as number) + dx * k;
      p[i3 + 1] = (p[a + 1] as number) + dy * k;
      p[i3 + 2] = (p[a + 2] as number) + dz * k;
    }
  }

  /**
   * Pull each particle toward its skinned reference pose. `springStrength` is
   * always on (the garment's tailoring, holding the silhouette); `recoverySpeed`
   * is added only while the character is idle, so "how much shape is kept while
   * running" and "how fast it settles when you stop" are independent knobs.
   * Applied as a positional blend rather than a force, which cannot overshoot.
   */
  private solveReference(h: number, t: RobeTuning, ctx: ClothStepContext): void {
    const { count, refWeight } = this.geo;
    const p = this.pos;
    const w = this.invMass;
    const ref = ctx.ref;
    const base = t.springStrength + t.recoverySpeed * clamp01(ctx.idle);
    if (base <= 0) return;
    for (let i = 0; i < count; i++) {
      if ((w[i] as number) === 0) continue;
      const rw = refWeight[i] as number;
      if (rw <= 0) continue;
      const alpha = 1 - Math.exp(-base * rw * h);
      const i3 = i * 3;
      p[i3] = (p[i3] as number) + ((ref[i3] as number) - (p[i3] as number)) * alpha;
      p[i3 + 1] = (p[i3 + 1] as number) + ((ref[i3 + 1] as number) - (p[i3 + 1] as number)) * alpha;
      p[i3 + 2] = (p[i3 + 2] as number) + ((ref[i3 + 2] as number) - (p[i3 + 2] as number)) * alpha;
    }
  }

  /** Push every particle out of the body capsules its piece is allowed to touch. */
  private solveColliders(t: RobeTuning, ctx: ClothStepContext, scale: number): void {
    const { count, colliderMask } = this.geo;
    const caps = ctx.colliders;
    const p = this.pos;
    const w = this.invMass;
    const margin = t.collisionRadius * scale;
    for (let j = 0; j < caps.count; j++) {
      if (((caps.mask[j] as number) & colliderMask) === 0) continue;
      const r = (caps.radius[j] as number) + margin;
      if (r <= 0) continue;
      const j3 = j * 3;
      const ax = caps.a[j3] as number;
      const ay = caps.a[j3 + 1] as number;
      const az = caps.a[j3 + 2] as number;
      const abx = (caps.b[j3] as number) - ax;
      const aby = (caps.b[j3 + 1] as number) - ay;
      const abz = (caps.b[j3 + 2] as number) - az;
      const abLenSq = abx * abx + aby * aby + abz * abz;
      const invAb = abLenSq > 1e-9 ? 1 / abLenSq : 0;

      for (let i = 0; i < count; i++) {
        if ((w[i] as number) === 0) continue;
        const i3 = i * 3;
        const px = p[i3] as number;
        const py = p[i3 + 1] as number;
        const pz = p[i3 + 2] as number;
        // Closest point on the capsule's axis segment.
        let s = invAb === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) * invAb;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
        const qx = ax + abx * s;
        const qy = ay + aby * s;
        const qz = az + abz * s;
        const dx = px - qx;
        const dy = py - qy;
        const dz = pz - qz;
        const len = Math.hypot(dx, dy, dz);
        if (len >= r) continue;
        if (len < 1e-6) {
          // Degenerate: the particle is exactly on the axis and has no direction
          // to be pushed along. Lift it out rather than leaving it inside.
          p[i3 + 1] = qy + r;
          continue;
        }
        const k = r / len;
        p[i3] = qx + dx * k;
        p[i3 + 1] = qy + dy * k;
        p[i3 + 2] = qz + dz * k;
      }
    }
  }

  /** Keep the hem out of the floor. */
  private solveGround(ctx: ClothStepContext, scale: number): void {
    const { count } = this.geo;
    const p = this.pos;
    const w = this.invMass;
    const floor = ctx.groundY + GROUND_CLEARANCE * scale;
    for (let i = 0; i < count; i++) {
      if ((w[i] as number) === 0) continue;
      const y = i * 3 + 1;
      if ((p[y] as number) < floor) p[y] = floor;
    }
  }

  /**
   * Drive the pinned particles onto their targets, interpolating from last
   * frame's so a fast-moving character sweeps its attachment rings through the
   * substeps instead of teleporting them on the first one.
   */
  private applyPins(ctx: ClothStepContext, alpha: number): void {
    const { count } = this.geo;
    const p = this.pos;
    const v = this.vel;
    const ref = ctx.ref;
    const from = this.pinPrev;
    for (let i = 0; i < count; i++) {
      if ((this.invMass[i] as number) !== 0) continue;
      const i3 = i * 3;
      p[i3] = (from[i3] as number) + ((ref[i3] as number) - (from[i3] as number)) * alpha;
      p[i3 + 1] = (from[i3 + 1] as number) + ((ref[i3 + 1] as number) - (from[i3 + 1] as number)) * alpha;
      p[i3 + 2] = (from[i3 + 2] as number) + ((ref[i3 + 2] as number) - (from[i3 + 2] as number)) * alpha;
      v[i3] = 0;
      v[i3 + 1] = 0;
      v[i3 + 2] = 0;
    }
  }

  /** Re-derive velocity from the actual position change, so constraints damp it. */
  private finishVelocities(h: number, scale: number): void {
    const { count } = this.geo;
    const p = this.pos;
    const v = this.vel;
    const prev = this.prevPos;
    const inv = 1 / h;
    const maxSpeed = MAX_SPEED * scale;
    for (let i = 0; i < count; i++) {
      if ((this.invMass[i] as number) === 0) continue;
      const i3 = i * 3;
      let vx = ((p[i3] as number) - (prev[i3] as number)) * inv;
      let vy = ((p[i3 + 1] as number) - (prev[i3 + 1] as number)) * inv;
      let vz = ((p[i3 + 2] as number) - (prev[i3 + 2] as number)) * inv;
      const speed = Math.hypot(vx, vy, vz);
      if (speed > maxSpeed) {
        const k = maxSpeed / speed;
        vx *= k;
        vy *= k;
        vz *= k;
      }
      v[i3] = vx;
      v[i3 + 1] = vy;
      v[i3 + 2] = vz;
    }
  }

  /**
   * Last line of defence: park any particle that has gone non-finite back on its
   * reference pose, at rest. Everything upstream is sanitised, but a single NaN
   * loose in a constraint graph spreads to the whole piece within a frame and
   * leaves it permanently invisible, so it is worth one cheap sweep to make that
   * failure self-healing instead of terminal.
   */
  private repairNonFinite(ctx: ClothStepContext): void {
    const { count } = this.geo;
    const p = this.pos;
    const v = this.vel;
    const ref = ctx.ref;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      if (Number.isFinite((p[i3] as number) + (p[i3 + 1] as number) + (p[i3 + 2] as number))) continue;
      p[i3] = ref[i3] as number;
      p[i3 + 1] = ref[i3 + 1] as number;
      p[i3 + 2] = ref[i3 + 2] as number;
      v[i3] = 0;
      v[i3 + 1] = 0;
      v[i3 + 2] = 0;
    }
  }

  /**
   * Area-weighted vertex normals from the current positions. Needed by the wind
   * (pressure is the normal-projected component of the relative air velocity)
   * and uploaded to the mesh, so it is computed once per frame and shared.
   */
  private computeNormals(): void {
    const { index } = this.geo;
    const p = this.pos;
    const n = this.normal;
    n.fill(0);
    for (let k = 0; k < index.length; k += 3) {
      const a = (index[k] as number) * 3;
      const b = (index[k + 1] as number) * 3;
      const c = (index[k + 2] as number) * 3;
      const ux = (p[b] as number) - (p[a] as number);
      const uy = (p[b + 1] as number) - (p[a + 1] as number);
      const uz = (p[b + 2] as number) - (p[a + 2] as number);
      const vx = (p[c] as number) - (p[a] as number);
      const vy = (p[c + 1] as number) - (p[a + 1] as number);
      const vz = (p[c + 2] as number) - (p[a + 2] as number);
      // Un-normalised cross product: its length is twice the triangle area, so
      // accumulating it weights each face by area for free.
      const fx = uy * vz - uz * vy;
      const fy = uz * vx - ux * vz;
      const fz = ux * vy - uy * vx;
      n[a] = (n[a] as number) + fx;
      n[a + 1] = (n[a + 1] as number) + fy;
      n[a + 2] = (n[a + 2] as number) + fz;
      n[b] = (n[b] as number) + fx;
      n[b + 1] = (n[b + 1] as number) + fy;
      n[b + 2] = (n[b + 2] as number) + fz;
      n[c] = (n[c] as number) + fx;
      n[c + 1] = (n[c + 1] as number) + fy;
      n[c + 2] = (n[c + 2] as number) + fz;
    }
    for (let i = 0; i < n.length; i += 3) {
      const x = n[i] as number;
      const y = n[i + 1] as number;
      const z = n[i + 2] as number;
      const len = Math.hypot(x, y, z);
      if (len < 1e-9 || !Number.isFinite(len)) {
        n[i] = 0;
        n[i + 1] = 1;
        n[i + 2] = 0;
        continue;
      }
      n[i] = x / len;
      n[i + 1] = y / len;
      n[i + 2] = z / len;
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
