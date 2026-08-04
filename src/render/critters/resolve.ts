/**
 * Turning a species' declaration into a flat, fully-resolved part list (spec 049).
 *
 * Mirroring, socket parenting and bind-pose placement are all pure arithmetic on
 * the species data, so they live here rather than in the three.js rig. Two very
 * different consumers need exactly this:
 *
 *  - `iso3d/critter.ts` walks the resolved list to build meshes;
 *  - the legibility tests (and `scripts/preview-critters.ts`) walk it to measure
 *    the silhouette without a GL context anywhere in sight.
 *
 * Keeping it here is what makes "does the pig read at 64 px" a question CI can
 * answer.
 */

import { BONE_COUNT, boneRestLayout, type FigureMetrics } from '../cloth/figure.js';
import type { CritterSpecies, PartSpec, WobbleSpec } from './types.js';

/** A socket after mirroring: a concrete node with a resolved parent bone. */
export interface ResolvedSocket {
  readonly name: string;
  readonly parentBone: number;
  readonly pos: readonly [number, number, number];
  readonly rot: readonly [number, number, number];
  readonly wobble?: WobbleSpec;
  /**
   * `-1` on a mirrored socket, `+1` otherwise. Multiplied into x/y-axis wobble
   * so a mirrored ear flaps outward with its twin instead of alongside it.
   */
  readonly flip: number;
}

/** A part after mirroring, with its attachment resolved to a concrete node. */
export interface ResolvedPart extends Omit<PartSpec, 'mirror' | 'pos' | 'rot' | 'attach'> {
  readonly attach: number | string;
  readonly pos: readonly [number, number, number];
  readonly rot: readonly [number, number, number];
}

const NO_ROT: readonly [number, number, number] = [0, 0, 0];

/**
 * Mirror a rotation across the z = 0 plane.
 *
 * With XYZ-order Euler angles and a reflection `M = diag(1, 1, -1)`, the mirrored
 * rotation is `M R M`, which negates the x and y angles and leaves z alone. That
 * is why an ear's outward splay is written as an x rotation and its forward tilt
 * as a z rotation: the first should oppose across the pair, the second should not.
 */
function mirrorRot(rot: readonly [number, number, number]): readonly [number, number, number] {
  return [-rot[0], -rot[1], rot[2]];
}

/** Expand a species' sockets, emitting `${socket}R` for every mirrored one. */
export function resolveSockets(species: CritterSpecies): ResolvedSocket[] {
  const out: ResolvedSocket[] = [];
  for (const s of species.sockets) {
    const rot = s.rot ?? NO_ROT;
    const wobble = s.wobble ? { wobble: s.wobble } : {};
    out.push({ name: s.socket, parentBone: s.parentBone, pos: s.pos, rot, ...wobble, flip: 1 });
    if (s.mirror) {
      out.push({
        name: `${s.socket}R`,
        parentBone: s.parentBone,
        pos: [s.pos[0], s.pos[1], -s.pos[2]],
        rot: mirrorRot(rot),
        ...wobble,
        flip: -1,
      });
    }
  }
  return out;
}

/** Expand a species' parts, emitting the `-z` twin of every mirrored one. */
export function resolveParts(species: CritterSpecies): ResolvedPart[] {
  const out: ResolvedPart[] = [];
  for (const p of species.parts) {
    const rot = p.rot ?? NO_ROT;
    const { mirror, ...rest } = p;
    out.push({ ...rest, rot });
    if (mirror) {
      out.push({
        ...rest,
        name: `${p.name}R`,
        pos: [p.pos[0], p.pos[1], -p.pos[2]],
        rot: mirrorRot(rot),
      });
    }
  }
  return out;
}

/**
 * Every attachment name a part may legally reference: bone indices as numbers,
 * socket names as strings.
 */
export function attachmentNames(species: CritterSpecies): Set<number | string> {
  const names = new Set<number | string>();
  for (let i = 0; i < BONE_COUNT; i++) names.add(i);
  for (const s of resolveSockets(species)) names.add(s.name);
  return names;
}

/** A node's bind-pose origin in figure-local space, and the frame it hangs in. */
export interface BindNode {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Bind-pose origins for every bone, keyed by bone index.
 *
 * Bones are placed by parent-relative offsets and are unrotated at rest, so
 * accumulating positions down the hierarchy is the whole transform -- no matrix
 * maths needed, and no three.js.
 */
export function boneOrigins(f: FigureMetrics): BindNode[] {
  const origins: BindNode[] = [];
  for (const rest of boneRestLayout(f)) {
    const parent = rest.parent < 0 ? { x: 0, y: 0, z: 0 } : origins[rest.parent];
    if (!parent) throw new Error(`bone ${rest.bone} declared before its parent ${rest.parent}`);
    origins[rest.bone] = { x: parent.x + rest.x, y: parent.y + rest.y, z: parent.z + rest.z };
  }
  return origins;
}

/** Bind-pose origins for every socket, keyed by resolved socket name. */
export function socketOrigins(species: CritterSpecies): Map<string, BindNode> {
  const bones = boneOrigins(species.metrics);
  const out = new Map<string, BindNode>();
  for (const s of resolveSockets(species)) {
    const b = bones[s.parentBone];
    if (!b) throw new Error(`socket ${s.name} hangs off unknown bone ${s.parentBone}`);
    out.set(s.name, { x: b.x + s.pos[0], y: b.y + s.pos[1], z: b.z + s.pos[2] });
  }
  return out;
}

/** An axis-aligned box in figure-local space. */
export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

function emptyBounds(): Bounds {
  return {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
}

function grow(b: Bounds, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
  b.minX = Math.min(b.minX, cx - hx);
  b.maxX = Math.max(b.maxX, cx + hx);
  b.minY = Math.min(b.minY, cy - hy);
  b.maxY = Math.max(b.maxY, cy + hy);
  b.minZ = Math.min(b.minZ, cz - hz);
  b.maxZ = Math.max(b.maxZ, cz + hz);
}

/**
 * A part's bind-pose bounding box, conservatively: its rotation is folded in by
 * taking the rotated extent of the box that encloses the primitive.
 *
 * Conservative rather than tight because everything this feeds -- silhouette
 * width, standing height, does-the-foot-reach-the-ground -- wants an outer
 * bound, and an approximation that could *under*-report the silhouette would
 * quietly weaken the very tests it exists to support.
 */
export function partBounds(
  part: ResolvedPart,
  origin: BindNode,
  into: Bounds = emptyBounds(),
): Bounds {
  const [sx, sy, sz] = part.size;
  const [rx, ry, rz] = part.rot;
  const half = [sx / 2, sy / 2, sz / 2] as const;

  // Rotated extent of an axis-aligned box: |R| * half, with |R| the elementwise
  // absolute of the rotation matrix.
  const [cx, sxr] = [Math.cos(rx), Math.sin(rx)];
  const [cy, syr] = [Math.cos(ry), Math.sin(ry)];
  const [cz, szr] = [Math.cos(rz), Math.sin(rz)];
  // XYZ-order Euler, matching three.js' default.
  const m = [
    [cy * cz, -cy * szr, syr],
    [sxr * syr * cz + cx * szr, -sxr * syr * szr + cx * cz, -sxr * cy],
    [-cx * syr * cz + sxr * szr, cx * syr * szr + sxr * cz, cx * cy],
  ];
  const ext = m.map((row) => Math.abs(row[0] as number) * half[0] + Math.abs(row[1] as number) * half[1] + Math.abs(row[2] as number) * half[2]);

  grow(
    into,
    origin.x + part.pos[0],
    origin.y + part.pos[1],
    origin.z + part.pos[2],
    ext[0] as number,
    ext[1] as number,
    ext[2] as number,
  );
  return into;
}

/** Where a resolved part hangs, in bind-pose figure-local space. */
export function partOrigin(
  part: ResolvedPart,
  bones: readonly BindNode[],
  sockets: ReadonlyMap<string, BindNode>,
): BindNode {
  if (typeof part.attach === 'number') {
    const bone = bones[part.attach];
    if (!bone) throw new Error(`part ${part.name} attaches to unknown bone ${part.attach}`);
    return bone;
  }
  const socket = sockets.get(part.attach);
  if (!socket) throw new Error(`part ${part.name} attaches to unknown socket "${part.attach}"`);
  return socket;
}

/** The whole species' bind-pose bounding box: the silhouette a unit occupies. */
export function speciesBounds(species: CritterSpecies): Bounds {
  const bones = boneOrigins(species.metrics);
  const sockets = socketOrigins(species);
  const b = emptyBounds();
  for (const part of resolveParts(species)) {
    partBounds(part, partOrigin(part, bones, sockets), b);
  }
  return b;
}

/** Bind-pose bounds of just the parts matching `predicate` (e.g. the head). */
export function boundsOf(species: CritterSpecies, predicate: (p: ResolvedPart) => boolean): Bounds {
  const bones = boneOrigins(species.metrics);
  const sockets = socketOrigins(species);
  const b = emptyBounds();
  for (const part of resolveParts(species)) {
    if (!predicate(part)) continue;
    partBounds(part, partOrigin(part, bones, sockets), b);
  }
  return b;
}
