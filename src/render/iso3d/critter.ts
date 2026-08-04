import * as THREE from 'three';
import type { Vec2 } from '../../sim/types.js';
import type { FigureTuning } from '../cloth/params.js';
import {
  deriveCoat,
  resolveParts,
  resolveSockets,
  type CoatColors,
  type CoatRole,
  type CritterSpecies,
  type ResolvedPart,
  type ResolvedSocket,
} from '../critters/index.js';
import { Humanoid, type BodyDresser, type GaitState } from './humanoid.js';
import { MotionObserver } from './motion.js';
import type { SandboxUnit } from './unit.js';

/**
 * The three.js half of a critter (spec 049): it builds a species' declared
 * blocks, hangs them off the shared skeleton, and drives the bits of it the
 * walk cycle does not know about -- ears, tails, anything on a socket.
 *
 * **There is no per-species code in this file, and that is the point.** Adding a
 * sheep means adding `critters/sheep.ts`; this class already knows how to build
 * it, colour it and animate it. The moment a `if (species.id === ...)` appears
 * here, the data layer has failed and the fix belongs in `critters/`, not here.
 *
 * Colours are the one thing built per rig rather than shared. Every other mesh
 * in the scene draws from `meshes.ts`'s material cache, keyed by colour -- which
 * is right for terrain and props and catastrophic here, because retinting one
 * player's pig would repaint every object that happened to share its hex. So a
 * critter owns its own {@link THREE.MeshLambertMaterial} per colour role, and
 * `setCoat` mutates those.
 *
 * Nothing here reads or writes sim state; the character is entirely cosmetic.
 */

const TWO_PI = Math.PI * 2;

/** Speed at which the idle sway has fully faded out, matching the gait's ramp. */
const IDLE_SPEED = 5;
const WALK_SPEED = 34;

/** The critter's own cosmetic knobs, on top of the shared figure tuning. */
export interface CritterTuning extends FigureTuning {
  /** Multiplier on every socket's stride-driven swing: floppier ears and tails. */
  wobbleScale: number;
  /** Multiplier on how far sockets are thrown outward by a turn. */
  swishScale: number;
}

export function defaultCritterTuning(): CritterTuning {
  return {
    bodyScale: 1,
    strideScale: 1,
    // Lower than the robe's: these are short-armed animals, and a full human
    // arm swing on them reads as marching.
    armSwing: 0.4,
    jumpHeight: 42,
    gravityMultiplier: 1,
    wobbleScale: 1,
    swishScale: 1,
  };
}

/** Bounds for {@link CritterTuning}, in the same spirit as the robe's. */
export const CRITTER_BOUNDS: Record<keyof CritterTuning, readonly [number, number]> = {
  bodyScale: [0.3, 4],
  strideScale: [0.3, 3],
  armSwing: [0, 2],
  jumpHeight: [0, 400],
  gravityMultiplier: [0, 6],
  wobbleScale: [0, 4],
  swishScale: [0, 4],
};

/** A socket node plus everything needed to animate it, resolved once at build. */
interface LiveSocket {
  readonly node: THREE.Object3D;
  readonly spec: ResolvedSocket;
  /** Rest rotation about the wobble axis; the wobble is an offset from this. */
  readonly rest: number;
  /** The eased current offset, so a socket lags rather than snapping. */
  value: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!(edge1 > edge0)) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Geometry for one part. Shared across every rig of the same shape via a cache
 * keyed on the primitive's parameters: two pigs in different colours are two
 * material sets over one set of buffers.
 */
const geometryCache = new Map<string, THREE.BufferGeometry>();

function partGeometry(part: ResolvedPart): THREE.BufferGeometry {
  const [w, h, d] = part.size;
  const facets = part.facets;
  const key = `${part.shape}|${w},${h},${d}|${part.taper ?? 0}|${facets ?? -1}`;
  const hit = geometryCache.get(key);
  if (hit) return hit;

  let geo: THREE.BufferGeometry;
  if (part.shape === 'box') {
    geo = new THREE.BoxGeometry(w, h, d);
  } else if (part.shape === 'ball') {
    // A unit icosahedron scaled to the part's extents: faceted, and elliptical
    // without needing a separate sphere per axis ratio.
    geo = new THREE.IcosahedronGeometry(0.5, facets ?? 0);
    geo.scale(w, h, d);
  } else {
    // `taper` is the +y radius over the -y base, matching the spec's convention.
    const taper = part.taper ?? 0;
    geo = new THREE.CylinderGeometry(0.5 * taper, 0.5, 1, facets ?? 5, 1, false);
    geo.scale(w, h, d);
  }
  geometryCache.set(key, geo);
  return geo;
}

export class CritterRig implements SandboxUnit {
  /** The unit root the scene positions and yaws. */
  readonly group = new THREE.Group();
  readonly orientsWithGroupYaw = true;
  readonly species: CritterSpecies;
  readonly tuning: CritterTuning;
  readonly humanoid: Humanoid;

  /** One material per colour role, owned by this rig so `setCoat` is local. */
  private readonly materials = new Map<CoatRole, THREE.MeshLambertMaterial>();
  private readonly sockets: LiveSocket[] = [];
  private readonly motion = new MotionObserver();
  private coatHex: number;
  private clock = 0;

  constructor(species: CritterSpecies, opts: { tuning?: CritterTuning; coat?: number } = {}) {
    this.species = species;
    this.tuning = opts.tuning ?? defaultCritterTuning();
    this.coatHex = opts.coat ?? species.defaultCoat;

    const colors = deriveCoat(species, this.coatHex);
    for (const role of Object.keys(colors) as CoatRole[]) {
      this.materials.set(role, new THREE.MeshLambertMaterial({ color: colors[role], flatShading: true }));
    }

    // The sockets have to exist before the dresser runs, because parts name
    // them; they are built into a map the dresser closes over.
    const socketNodes = new Map<string, THREE.Object3D>();
    const dress: BodyDresser = (bones) => {
      for (const spec of resolveSockets(species)) {
        const node = new THREE.Object3D();
        node.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
        node.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
        const parent = bones[spec.parentBone];
        if (!parent) throw new Error(`${species.id}: socket ${spec.name} hangs off bone ${spec.parentBone}`);
        parent.add(node);
        socketNodes.set(spec.name, node);
        this.sockets.push({
          node,
          spec,
          rest: spec.wobble ? node.rotation[spec.wobble.axis] : 0,
          value: 0,
        });
      }
      for (const part of resolveParts(species)) {
        const parent =
          typeof part.attach === 'number' ? bones[part.attach] : socketNodes.get(part.attach);
        if (!parent) throw new Error(`${species.id}: part ${part.name} has no attachment ${String(part.attach)}`);
        const mesh = new THREE.Mesh(partGeometry(part), this.material(part.role));
        mesh.position.set(part.pos[0], part.pos[1], part.pos[2]);
        mesh.rotation.set(part.rot[0], part.rot[1], part.rot[2]);
        mesh.name = part.name;
        parent.add(mesh);
      }
    };

    this.humanoid = new Humanoid(species.metrics, dress);
    this.group.add(this.humanoid.group);
  }

  /** The species' gait, for the sandbox status line. */
  get locomotionState(): GaitState {
    return this.humanoid.gaitState;
  }

  /** The coat currently applied. */
  get coat(): number {
    return this.coatHex;
  }

  /** Every colour this rig currently draws with, for the panel's swatch state. */
  get colors(): CoatColors {
    return deriveCoat(this.species, this.coatHex);
  }

  /**
   * Recolour in place. Only the rig's own materials change -- no geometry is
   * rebuilt, no other object in the scene is touched -- so this is cheap enough
   * to drive straight off a click in the coat picker.
   */
  setCoat(coat: number): void {
    this.coatHex = coat;
    const colors = deriveCoat(this.species, coat);
    for (const [role, material] of this.materials) material.color.setHex(colors[role]);
  }

  /** Trigger the cosmetic hop. */
  jump(): boolean {
    return this.humanoid.triggerJump(this.tuning);
  }

  /** Drop from `height` so a long fall can be watched in the sandbox. */
  drop(height: number): boolean {
    return this.humanoid.triggerDrop(height);
  }

  /**
   * Pose for this frame. The skeleton does the walk; everything after it is the
   * species' own secondary motion, driven entirely off numbers the walk already
   * produced.
   */
  update(dt: number, worldPos: Vec2, ry: number): void {
    const h = clamp(dt, 0, 0.1);
    this.clock += h;
    const gait = this.motion.observe(h, worldPos, ry);
    this.humanoid.update(h, gait, this.tuning);
    this.poseSockets(h, gait.speed);
    this.group.updateMatrixWorld(true);
  }

  private material(role: CoatRole): THREE.MeshLambertMaterial {
    const m = this.materials.get(role);
    if (!m) throw new Error(`${this.species.id}: no material for role ${role}`);
    return m;
  }

  /**
   * Swing every socket. Three contributions, all from the shared gait:
   *
   *  - the stride cycle, scaled by how fast the character is going, so ears bob
   *    in step with the feet rather than on a timer of their own;
   *  - an idle sway that fades *in* as the character stops, so a standing animal
   *    is never perfectly still;
   *  - a lean out of a turn, which is what throws a tail wide on a hard corner.
   *
   * Each is chased through a per-socket follow rate rather than applied directly,
   * so a heavy tail lags and a light ear does not.
   */
  private poseSockets(h: number, speed: number): void {
    const phase = this.humanoid.stridePhase * TWO_PI;
    const move = smoothstep(IDLE_SPEED, WALK_SPEED, speed);
    const turn = this.motion.turnRate;

    for (const live of this.sockets) {
      const w = live.spec.wobble;
      if (!w) continue;
      const offset = (w.phase ?? 0) * TWO_PI;
      const stride = Math.sin(phase + offset) * w.strideAmp * move;
      const idle = w.idleAmp
        ? Math.sin(this.clock * TWO_PI * (w.idleHz ?? 0.4)) * w.idleAmp * (1 - move)
        : 0;
      // `flip` opposes the pair across the body: both ears swing outward, not
      // both to the left.
      const lean = w.leanAmp ? clamp(-turn * 0.28, -1.6, 1.6) * w.leanAmp : 0;
      const target =
        (stride + idle) * this.tuning.wobbleScale * live.spec.flip +
        lean * this.tuning.swishScale * live.spec.flip;

      const k = Math.min(1, h * (w.follow ?? 8));
      live.value += (target - live.value) * k;
      live.node.rotation[w.axis] = live.rest + live.value;
    }
  }
}
