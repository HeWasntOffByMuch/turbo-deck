import * as THREE from 'three';
import type { Vec2 } from '../../sim/types.js';
import { buildRobePieces, type ClothGeometry } from '../cloth/geometry.js';
import { FIGURE } from '../cloth/figure.js';
import { defaultRobeTuning, sanitizeRobeTuning, type RobeTuning } from '../cloth/params.js';
import { ClothSolver, createStepContext, type ClothStepContext } from '../cloth/solver.js';
import { WindField } from '../cloth/wind.js';
import { Humanoid, type GaitInput, type GaitState } from './humanoid.js';
import { PALETTE } from './palette.js';
import type { SandboxUnit } from './unit.js';

/**
 * The hooded robe character (spec 037): the composition root that binds the
 * cloth simulation to the skeleton.
 *
 * Everything hard already lives elsewhere -- the solver in `cloth/solver.ts`
 * knows physics and nothing about bones, the {@link Humanoid} knows bones and
 * nothing about physics. This class is the seam between them, and its job is
 * three things per frame:
 *
 *  1. **Observe motion.** Derive speed, acceleration and turn rate from the sim
 *     position and heading the scene hands it. Nothing downstream ever asks
 *     "am I running?" -- the numbers just flow into the gait and the forces.
 *  2. **Skin the reference pose.** Turn each particle's bind-pose position into
 *     a world-space target through its bone's current matrix. Pinned particles
 *     are driven to it; free ones are pulled toward it.
 *  3. **Publish the result.** Step each piece, then write world positions back
 *     into the mesh buffers in the rig group's frame.
 *
 * Adding a garment means adding a `build*` in `cloth/geometry.ts`; this file
 * does not change. Nothing here reads or writes sim state.
 */

/** Speed thresholds for the idle blend, matching the humanoid's gait ramp. */
const IDLE_SPEED = 5;
const WALK_SPEED = 34;
/** How fast the observed body velocity and acceleration are smoothed (1/s). */
const VEL_SMOOTH = 22;
const ACC_SMOOTH = 14;
/** A single-frame move further than this (x body scale) is a teleport, not a run. */
const TELEPORT_DISTANCE = 400;
/** Landing speed that produces a full-strength landing impulse. */
const LANDING_REFERENCE_SPEED = 300;

/** What a garment piece exposes to the debug overlay. */
export interface ClothPieceView {
  readonly geo: ClothGeometry;
  readonly solver: ClothSolver;
  /** `3 * count` positions in the rig group's frame: exactly what the mesh draws. */
  readonly local: Float32Array;
  /** `3 * count` world-space skinned reference positions (the spring targets). */
  readonly ref: Float64Array;
}

/** One garment piece, wired end to end from pattern to mesh. */
interface Piece extends ClothPieceView {
  readonly ctx: ClothStepContext;
  /** `3 * count` bind positions pre-expressed in each particle's bone frame. */
  readonly boneLocal: Float64Array;
  readonly mesh: THREE.Mesh;
  readonly posAttr: THREE.BufferAttribute;
  readonly normAttr: THREE.BufferAttribute;
}

/** A read-only per-frame snapshot for the debug viewport. Reused, never allocated. */
export interface RobeDebug {
  readonly pieces: { name: string; count: number; links: number; stretch: number }[];
  particles: number;
  links: number;
  gait: GaitState;
  speed: number;
  accel: number;
  turnRate: number;
  stridePhase: number;
  liftY: number;
  jumpState: string;
  windSpeed: number;
  windHeadingDeg: number;
  idle: number;
  /** Wall-clock milliseconds spent in the solver last frame. */
  solveMs: number;
}

const _inv = new THREE.Matrix4();
const _rot = new THREE.Matrix3();

export class RobeRig implements SandboxUnit {
  /** The unit root the scene positions and yaws. */
  readonly group = new THREE.Group();
  readonly orientsWithGroupYaw = true;
  /** Live-editable tuning; the sandbox panel mutates this object in place. */
  readonly tuning: RobeTuning;
  readonly humanoid: Humanoid;
  readonly wind: WindField;

  private readonly pieces: Piece[] = [];
  /** Cloth meshes live here at identity: their vertices are written in rig-group space. */
  private readonly clothRoot = new THREE.Group();

  private prevX: number | null = null;
  private prevZ = 0;
  private prevRy = 0;
  private velX = 0;
  private velZ = 0;
  private accX = 0;
  private accZ = 0;
  private speed = 0;
  private turnRate = 0;
  private clock = 0;
  private idle = 1;
  private solveMs = 0;
  private readonly gait: GaitInput = { speed: 0, accel: 0, turnRate: 0, distance: 0 };
  private readonly debug: RobeDebug = {
    pieces: [],
    particles: 0,
    links: 0,
    gait: 'idle',
    speed: 0,
    accel: 0,
    turnRate: 0,
    stridePhase: 0,
    liftY: 0,
    jumpState: 'grounded',
    windSpeed: 0,
    windHeadingDeg: 0,
    idle: 1,
    solveMs: 0,
  };

  constructor(opts: { tuning?: RobeTuning; windSeed?: number } = {}) {
    this.tuning = opts.tuning ?? defaultRobeTuning();
    this.wind = new WindField(opts.windSeed ?? 1337);
    this.humanoid = new Humanoid(FIGURE);
    this.group.add(this.humanoid.group, this.clothRoot);

    for (const geo of buildRobePieces(FIGURE)) this.pieces.push(this.makePiece(geo));
    for (const p of this.pieces) {
      this.debug.pieces.push({ name: p.geo.name, count: p.geo.count, links: p.geo.linkCount, stretch: 1 });
      this.debug.particles += p.geo.count;
      this.debug.links += p.geo.linkCount;
    }
  }

  /** The figure's gait, for the sandbox status line. */
  get locomotionState(): string {
    return this.humanoid.gaitState;
  }

  /**
   * The live pieces, for the debug overlay. `local` is the same buffer the mesh
   * draws from -- positions already transformed into the rig group's frame -- so
   * an overlay parented to `group` can read it straight out with no maths of its
   * own, and can never drift a frame out of step with what is on screen.
   */
  get clothPieces(): readonly ClothPieceView[] {
    return this.pieces;
  }

  /** Show or hide the simulated garments (the solid figure keeps rendering). */
  setClothVisible(visible: boolean): void {
    this.clothRoot.visible = visible;
  }

  /** Show or hide the solid figure under the robe. */
  setBodyVisible(visible: boolean): void {
    this.humanoid.group.visible = visible;
  }

  /** Start the cosmetic hop; ignored if already airborne. */
  jump(): boolean {
    return this.humanoid.triggerJump(this.tuning);
  }

  /** Drop the figure from a height, to watch a long fall. */
  drop(height = 220): boolean {
    return this.humanoid.triggerDrop(height);
  }

  /** Fire a one-shot wind gust. */
  gust(strength = 320): void {
    this.wind.gust(strength);
  }

  /** Drop every piece back onto its rest pose, at rest. Used after a big retune. */
  resettle(): void {
    for (const p of this.pieces) {
      this.skinReference(p);
      p.solver.reset(p.ctx.ref);
    }
  }

  // --- construction -------------------------------------------------------

  /**
   * Wire one pattern into a solver and a mesh. The mesh's `position` attribute
   * *is* the simulation output: there is no intermediate representation and no
   * per-frame geometry rebuild, just a buffer upload.
   */
  private makePiece(geo: ClothGeometry): Piece {
    const solver = new ClothSolver(geo);
    const ref = new Float64Array(geo.count * 3);
    const ctx = createStepContext(ref, this.humanoid.colliders);

    // Pre-express every bind position in its bone's frame, so the per-frame
    // reference pose is one matrix-vector product per particle and no more.
    const boneLocal = new Float64Array(geo.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < geo.count; i++) {
      const bone = geo.bone[i] as number;
      v.set(geo.bind[i * 3] as number, geo.bind[i * 3 + 1] as number, geo.bind[i * 3 + 2] as number);
      v.applyMatrix4(this.humanoid.bindInverse[bone] as THREE.Matrix4);
      boneLocal[i * 3] = v.x;
      boneLocal[i * 3 + 1] = v.y;
      boneLocal[i * 3 + 2] = v.z;
    }

    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(new Float32Array(geo.count * 3), 3);
    const normAttr = new THREE.BufferAttribute(new Float32Array(geo.count * 3), 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    normAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('normal', normAttr);
    geometry.setIndex(new THREE.BufferAttribute(geo.index, 1));

    // Flat-shaded and double-sided: it matches the scene's faceted look, and
    // cloth is a surface with no inside, so back faces must light too. The outer
    // layers are a shade darker than the inner ones, which is the only cue that
    // separates them in silhouette -- there is no cloth-vs-cloth collision, so
    // the layering has to read tonally rather than geometrically.
    const material = new THREE.MeshLambertMaterial({
      color: geo.name === 'cape' || geo.name.startsWith('sleeve') ? PALETTE.robeDeep : PALETTE.robeCloth,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    // Vertices are already in the rig group's frame, and the cloth can swing
    // well outside any bounding sphere computed from one frame.
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    this.clothRoot.add(mesh);

    return {
      geo,
      solver,
      ctx,
      ref,
      local: posAttr.array as Float32Array,
      boneLocal,
      mesh,
      posAttr,
      normAttr,
    };
  }

  // --- per-frame ----------------------------------------------------------

  /**
   * Pose the figure and step its cloth. `dt` is elapsed sim time, so the debug
   * view's slow motion slows the fabric too, and a paused frame holds it.
   */
  update(dt: number, worldPos: Vec2, ry: number): void {
    sanitizeRobeTuning(this.tuning);
    const t = this.tuning;
    const h = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;
    const wx = Number.isFinite(worldPos.x) ? worldPos.x : this.prevX ?? 0;
    const wz = Number.isFinite(worldPos.y) ? worldPos.y : this.prevZ;
    const yaw = Number.isFinite(ry) ? ry : this.prevRy;

    const teleported = this.observeMotion(h, wx, wz, yaw, t);
    this.clock += h;

    // The scene has already set position/rotation on `group`; refresh the world
    // matrices before anything reads a bone's world transform.
    this.group.updateMatrixWorld(true);
    this.humanoid.update(h, this.gait, t);

    this.wind.update(h, t);
    this.stepCloth(h, t, teleported);
    this.writeMeshes();
  }

  /**
   * Derive smoothed velocity, acceleration and turn rate from the sim position
   * and heading. Smoothing matters: the sim advances in whole 60 Hz ticks while
   * the render frame does not, so raw per-frame differences are noisy enough to
   * make the inertia term buzz. The rates are gentle so a genuine direction
   * change still whips the fabric.
   *
   * Returns true if this frame was a teleport rather than movement.
   */
  private observeMotion(h: number, wx: number, wz: number, ry: number, t: RobeTuning): boolean {
    if (this.prevX === null) {
      this.prevX = wx;
      this.prevZ = wz;
      this.prevRy = ry;
      return true;
    }
    const dx = wx - this.prevX;
    const dz = wz - this.prevZ;
    const distance = Math.hypot(dx, dz);
    const teleported = distance > TELEPORT_DISTANCE * t.bodyScale;

    if (h > 0) {
      const rawVX = teleported ? 0 : dx / h;
      const rawVZ = teleported ? 0 : dz / h;
      const kv = 1 - Math.exp(-VEL_SMOOTH * h);
      const nextVX = this.velX + (rawVX - this.velX) * kv;
      const nextVZ = this.velZ + (rawVZ - this.velZ) * kv;
      const ka = 1 - Math.exp(-ACC_SMOOTH * h);
      this.accX += ((nextVX - this.velX) / h - this.accX) * ka;
      this.accZ += ((nextVZ - this.velZ) / h - this.accZ) * ka;
      this.velX = nextVX;
      this.velZ = nextVZ;

      let dRy = (ry - this.prevRy) % (Math.PI * 2);
      if (dRy > Math.PI) dRy -= Math.PI * 2;
      if (dRy < -Math.PI) dRy += Math.PI * 2;
      const kr = 1 - Math.exp(-VEL_SMOOTH * h);
      this.turnRate += (dRy / h - this.turnRate) * kr;
    }

    this.prevX = wx;
    this.prevZ = wz;
    this.prevRy = ry;
    this.speed = Math.hypot(this.velX, this.velZ);
    // Acceleration *along the direction of travel*: positive is speeding up,
    // negative is braking. That signed value is what the forward lean wants.
    const along = this.speed > 1e-3 ? (this.accX * this.velX + this.accZ * this.velZ) / this.speed : 0;

    this.gait.speed = this.speed;
    this.gait.accel = along;
    this.gait.turnRate = this.turnRate;
    this.gait.distance = teleported ? 0 : distance;
    this.idle = 1 - smoothstep(IDLE_SPEED, WALK_SPEED, this.speed);
    if (this.humanoid.jump.airborne) this.idle = 0;
    return teleported;
  }

  /** Skin every particle's bind position into world space through its bone. */
  private skinReference(p: Piece): void {
    const { geo, boneLocal, ctx } = p;
    const ref = ctx.ref;
    const bones = this.humanoid.bones;
    for (let i = 0; i < geo.count; i++) {
      const m = (bones[geo.bone[i] as number] as THREE.Object3D).matrixWorld.elements;
      const i3 = i * 3;
      const x = boneLocal[i3] as number;
      const y = boneLocal[i3 + 1] as number;
      const z = boneLocal[i3 + 2] as number;
      // Column-major 4x4 applied to a point; inlined so this allocates nothing.
      ref[i3] = (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number);
      ref[i3 + 1] = (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number);
      ref[i3 + 2] = (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number);
    }
  }

  /** Fill each piece's step context from this frame's world state and solve it. */
  private stepCloth(h: number, t: RobeTuning, teleported: boolean): void {
    // The hop's discrete events become impulses. Everything else the cloth feels
    // about jumping -- the lag on the way up, the overshoot at the apex -- comes
    // out of the pins moving, and needs no special case.
    const { launched, landingSpeed } = this.humanoid.jump.lastEvents;

    const start = performance.now();
    for (const p of this.pieces) {
      this.skinReference(p);
      if (teleported) {
        p.solver.reset(p.ctx.ref);
        continue;
      }
      if (launched) p.solver.addImpulse(0, -t.jumpImpulse, 0);
      if (landingSpeed > 0) {
        p.solver.addImpulse(0, t.landImpulse * Math.min(1, landingSpeed / LANDING_REFERENCE_SPEED), 0);
      }

      const ctx = p.ctx;
      ctx.windX = this.wind.vx;
      ctx.windY = this.wind.vy;
      ctx.windZ = this.wind.vz;
      ctx.windTurbulence = this.wind.turbulence;
      ctx.bodyVelX = this.velX;
      ctx.bodyVelY = 0;
      ctx.bodyVelZ = this.velZ;
      ctx.bodyAccX = this.accX;
      ctx.bodyAccY = 0;
      ctx.bodyAccZ = this.accZ;
      ctx.idle = this.idle;
      ctx.groundY = 0;
      ctx.time = this.clock;
      ctx.scale = t.bodyScale;
      p.solver.step(h, t, ctx);
    }
    this.solveMs = performance.now() - start;
  }

  /**
   * Copy the solved world positions into the mesh buffers, transformed into the
   * rig group's frame (the meshes are parented there, so they must be). One
   * inverse matrix per frame, then a flat loop -- no `Vector3` per vertex.
   */
  private writeMeshes(): void {
    _inv.copy(this.group.matrixWorld).invert();
    _rot.setFromMatrix4(_inv);
    const m = _inv.elements;
    const r = _rot.elements;
    for (const p of this.pieces) {
      const src = p.solver.pos;
      const nsrc = p.solver.normal;
      const dst = p.posAttr.array as Float32Array;
      const ndst = p.normAttr.array as Float32Array;
      for (let i = 0; i < src.length; i += 3) {
        const x = src[i] as number;
        const y = src[i + 1] as number;
        const z = src[i + 2] as number;
        dst[i] = (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number);
        dst[i + 1] = (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number);
        dst[i + 2] = (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number);
        const nx = nsrc[i] as number;
        const ny = nsrc[i + 1] as number;
        const nz = nsrc[i + 2] as number;
        ndst[i] = (r[0] as number) * nx + (r[3] as number) * ny + (r[6] as number) * nz;
        ndst[i + 1] = (r[1] as number) * nx + (r[4] as number) * ny + (r[7] as number) * nz;
        ndst[i + 2] = (r[2] as number) * nx + (r[5] as number) * ny + (r[8] as number) * nz;
      }
      p.posAttr.needsUpdate = true;
      p.normAttr.needsUpdate = true;
    }
  }

  /**
   * A reusable snapshot for the debug viewport. The rig already has all of it;
   * this only surfaces it, and allocates nothing per call.
   */
  debugSnapshot(): RobeDebug {
    const d = this.debug;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i] as Piece;
      const row = d.pieces[i];
      if (row) row.stretch = p.solver.maxStretchRatio();
    }
    d.gait = this.humanoid.gaitState;
    d.speed = this.speed;
    d.accel = this.gait.accel;
    d.turnRate = this.turnRate;
    d.stridePhase = this.humanoid.stridePhase;
    d.liftY = this.humanoid.liftY;
    d.jumpState = this.humanoid.jump.state;
    d.windSpeed = this.wind.strength;
    d.windHeadingDeg = this.wind.headingDeg;
    d.idle = this.idle;
    d.solveMs = this.solveMs;
    return d;
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!(edge1 > edge0)) return x >= edge1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
