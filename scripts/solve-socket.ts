/**
 * Where a weapon actually points, and what socket rotation would point it
 * somewhere else (spec 165).
 *
 *   npx tsx scripts/solve-socket.ts                                  # report the sword
 *   WEAPON=bow_recurve CLIP=shoot AT=anchor npx tsx scripts/solve-socket.ts
 *   WEAPON=bow_recurve CLIP=shoot AT=anchor WANT=point:up,edge:-forward \
 *     npx tsx scripts/solve-socket.ts --write
 *
 * `weapon.main` was calibrated by sweeping candidate rotations through
 * `preview-weapon.ts` and looking at four pictures at a time (spec 140). That
 * works and it is slow, and it only ever answers "which of these four", so the
 * numbers it produces are the best of what was tried rather than the right ones.
 *
 * This states the requirement in the frame it is about -- **where the weapon's
 * own axes should point, in the body's axes** -- and solves the socket for it,
 * the same shape as `aim-blade.ts` one directory over. The reportable half
 * matters as much as the solve: run it with no `WANT` and it prints where each
 * axis currently goes, which is the measurement nobody had for the sword.
 *
 * ## The pose is part of the question
 *
 * A socket calibration is exactly right at one pose and approximately right
 * everywhere else -- that is spec 143's whole lesson, learned when `weapon.main`
 * was solved against the swing's guard key and the blade hung at the floor for
 * the rest of the clip. So `CLIP` and `AT` are required inputs rather than
 * conveniences, and the report prints every key so the spread is visible instead
 * of one number that flatters itself.
 *
 * Nothing here reimplements the chain: the euler goes through the same
 * `eulerQuat` order `socketPivot` uses, the mesh goes through the same
 * `gripTransform`, and the residual after the solve is printed so a convention
 * mismatch shows up as a number rather than as a wrong picture.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { poseAt } from '../src/units/clip-author.js';
import { readNodeTree, splitGlb } from '../src/units/glb-read.js';
import { PIG_SHOT, SHOT_KEY_MS } from '../src/units/pig-shot.js';
import { PIG_STRIKE, STRIKE_KEY_MS } from '../src/units/pig-strike.js';
import { bodyFrame, namingOf, type BodyFrame, type Vec3 } from '../src/units/pose.js';
import { poseWorldMatrices } from '../src/units/skin.js';
import { validateSkeleton } from '../src/units/validate.js';
import { axisVector, cross, edgeAxis, normalize } from '../src/items/grip.js';
import { validateWeaponDef } from '../src/items/validate.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = join(repoRoot, 'assets', 'units', 'pig_a_pose_full');
const SKELETON = join(repoRoot, 'assets', 'units', 'biped.skeleton.json');

const WEAPON = process.env['WEAPON'] ?? 'sword_jian';
const SHOOTING = (process.env['CLIP'] ?? 'slash') === 'shoot';
const CLIP = SHOOTING ? PIG_SHOT : PIG_STRIKE;
const KEY_MS: Readonly<Record<string, number>> = SHOOTING ? SHOT_KEY_MS : STRIKE_KEY_MS;

type Matrix3 = readonly [Vec3, Vec3, Vec3];

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** A body-axis name to a world direction. The vocabulary `WANT` is written in. */
function bodyDirection(frame: BodyFrame, name: string): Vec3 {
  const right: Vec3 = [-frame.lateral[0], -frame.lateral[1], -frame.lateral[2]];
  const table: Record<string, Vec3> = {
    up: frame.up,
    down: [-frame.up[0], -frame.up[1], -frame.up[2]],
    forward: frame.forward,
    back: [-frame.forward[0], -frame.forward[1], -frame.forward[2]],
    right,
    left: [...frame.lateral] as unknown as Vec3,
  };
  const found = table[name.replace(/^[+]/, '').replace(/^-(.*)$/, '$1')];
  if (!found) throw new Error(`"${name}" is not a body direction; use up/down/forward/back/right/left`);
  return name.startsWith('-') ? ([-found[0], -found[1], -found[2]] as Vec3) : found;
}

/** How a direction reads in the body's own axes, for the report. */
function say(frame: BodyFrame, v: Vec3): string {
  const right = -dot3(v, frame.lateral);
  return `right ${right.toFixed(2).padStart(5)}  up ${dot3(v, frame.up).toFixed(2).padStart(5)}  fwd ${dot3(v, frame.forward).toFixed(2).padStart(5)}`;
}

/** The rotation `socketPivot` builds, as a basis. Three's euler order 'XYZ'. */
function eulerMatrix(deg: readonly [number, number, number]): Matrix3 {
  const d = Math.PI / 180;
  const [x, y, z] = [deg[0] * d, deg[1] * d, deg[2] * d];
  const [a, b] = [Math.cos(x), Math.sin(x)];
  const [c, e2] = [Math.cos(y), Math.sin(y)];
  const [e, f] = [Math.cos(z), Math.sin(z)];
  const ae = a * e;
  const af = a * f;
  const be = b * e;
  const bf = b * f;
  // Columns, matching three's `makeRotationFromEuler` for 'XYZ' exactly.
  return [
    [c * e, af + be * e2, bf - ae * e2],
    [-c * f, ae - bf * e2, be + af * e2],
    [e2, -b * c, a * c],
  ];
}

/** The inverse of {@link eulerMatrix}, in the same convention. */
function eulerFrom(m: Matrix3): [number, number, number] {
  const r = (col: number, row: number): number => (m[col] as Vec3)[row] as number;
  const clamp = (v: number): number => Math.max(-1, Math.min(1, v));
  const y = Math.asin(clamp(r(2, 0)));
  const near = Math.abs(r(2, 0)) < 0.9999999;
  const x = near ? Math.atan2(-r(2, 1), r(2, 2)) : Math.atan2(r(1, 2), r(1, 1));
  const z = near ? Math.atan2(-r(1, 0), r(0, 0)) : 0;
  const deg = 180 / Math.PI;
  return [x * deg, y * deg, z * deg];
}

function multiply3(a: Matrix3, b: Matrix3): Matrix3 {
  const at = (m: Matrix3, col: number, row: number): number => (m[col] as Vec3)[row] as number;
  const out: Vec3[] = [];
  for (let col = 0; col < 3; col += 1) {
    const column: number[] = [];
    for (let row = 0; row < 3; row += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += at(a, k, row) * at(b, col, k);
      column.push(sum);
    }
    out.push(column as unknown as Vec3);
  }
  return out as unknown as Matrix3;
}

function transpose3(m: Matrix3): Matrix3 {
  const at = (col: number, row: number): number => (m[col] as Vec3)[row] as number;
  return [
    [at(0, 0), at(1, 0), at(2, 0)],
    [at(0, 1), at(1, 1), at(2, 1)],
    [at(0, 2), at(1, 2), at(2, 2)],
  ];
}

/** The angle between two rotations, in degrees. Zero means they agree. */
function apartDeg(a: Matrix3, b: Matrix3): number {
  const rel = multiply3(a, transpose3(b));
  const at = (col: number, row: number): number => (rel[col] as Vec3)[row] as number;
  const trace = at(0, 0) + at(1, 1) + at(2, 2);
  return (Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180) / Math.PI;
}

function main(): void {
  const pig = splitGlb(new Uint8Array(readFileSync(join(UNIT_DIR, 'pig_a_pose_full.glb'))));
  const nodes = readNodeTree(pig);
  const naming = namingOf(nodes);
  if (naming === 'unknown') throw new Error('the pig rig is in no vocabulary this project reads');
  const frame = bodyFrame(nodes, naming);
  if (!frame) throw new Error('the pig rig has no measurable body frame');
  const rig = { nodes, naming } as const;

  const skeletonDoc = JSON.parse(readFileSync(SKELETON, 'utf8')) as Record<string, unknown>;
  const skeleton = validateSkeleton(skeletonDoc).value;
  if (!skeleton) throw new Error('biped.skeleton.json does not validate');

  const weaponDir = join(repoRoot, 'assets', 'items', WEAPON);
  const weapon = validateWeaponDef(
    JSON.parse(readFileSync(join(weaponDir, `${WEAPON}.weapondef.json`), 'utf8')),
  ).value;
  if (!weapon) throw new Error(`${WEAPON} does not validate; run npm run validate:items`);

  const socket = skeleton.sockets.find((entry) => entry.id === weapon.socket);
  if (!socket) throw new Error(`the biped skeleton has no socket "${weapon.socket}"`);
  const bone = nodes.find((node) => node.name === socket.bone);
  if (!bone) throw new Error(`the pig rig has no bone "${socket.bone}"`);

  /**
   * The weapon's own axes as columns, in mesh space, then in canonical space.
   *
   * `align` takes mesh space to canonical, so once the mesh axes are known the
   * weapon's canonical axes are just X, Y, Z -- there is nothing left to do with
   * the document. It is read anyway, because `edgeAxis` is the one part of the
   * basis nobody writes down and everybody has to agree about.
   */
  const meshAxes = {
    point: axisVector(weapon.grip.point),
    flat: axisVector(weapon.grip.flat),
    edge: edgeAxis(weapon.grip),
  };

  /** The bone's world basis at a moment of the clip, normalized. */
  const boneBasisAt = (ms: number): Matrix3 => {
    const m = poseWorldMatrices(nodes, poseAt(CLIP, rig, ms))[bone.index] ?? [];
    const column = (index: number): Vec3 => {
      const raw: Vec3 = [m[index * 4] ?? 0, m[index * 4 + 1] ?? 0, m[index * 4 + 2] ?? 0];
      return normalize(raw) ?? [0, 0, 0];
    };
    return [column(0), column(1), column(2)];
  };

  /** Canonical weapon axes in world space, given a socket rotation. */
  const worldAxes = (ms: number, rotation: readonly [number, number, number]): { point: Vec3; edge: Vec3; flat: Vec3 } => {
    const basis = multiply3(boneBasisAt(ms), eulerMatrix(rotation));
    // Canonical X is the edge, Y the point, Z the flat's normal -- `grip.ts`
    // states that once and this is the only place that has to agree with it.
    const at = (col: number): Vec3 => basis[col] as Vec3;
    return { edge: at(0), point: at(1), flat: at(2) };
  };

  const current = (socket.rotationDeg ?? [0, 0, 0]) as [number, number, number];
  console.log(`\n  ${weapon.name} (${weapon.id}) in ${socket.id} -> ${socket.bone}`);
  console.log(
    `  mesh axes: point ${weapon.grip.point}  flat ${weapon.grip.flat}  edge [${meshAxes.edge.join(', ')}]`,
  );
  console.log(`  clip ${CLIP.id}, socket rotationDeg [${current.join(', ')}]\n`);
  console.log('  where the weapon points, in the body’s axes:\n');
  for (const [label, ms] of Object.entries(KEY_MS)) {
    const axes = worldAxes(ms, current);
    console.log(`  ${label.padEnd(8)} point  ${say(frame, axes.point)}`);
    console.log(`  ${''.padEnd(8)} edge   ${say(frame, axes.edge)}`);
  }

  const want = process.env['WANT'];
  if (want === undefined) {
    console.log('\n  nothing solved. Set WANT=point:up,edge:-forward and AT=<key> to calibrate.');
    return;
  }

  const atLabel = process.env['AT'] ?? Object.keys(KEY_MS)[0] ?? '';
  const atMs = KEY_MS[atLabel];
  if (atMs === undefined) throw new Error(`the ${CLIP.id} clip has no "${atLabel}" key`);

  const asked = new Map(
    want.split(',').map((entry) => {
      const [name, direction] = entry.split(':');
      if (!name || !direction) throw new Error(`"${entry}" is not axis:direction`);
      return [name.trim(), bodyDirection(frame, direction.trim())] as const;
    }),
  );
  const wantPoint = asked.get('point');
  const wantEdge = asked.get('edge');
  if (!wantPoint || !wantEdge) throw new Error('WANT needs both point: and edge:');

  // Orthogonalised rather than trusted: two directions typed by a person are
  // very unlikely to be exactly perpendicular, and a basis that is not
  // orthonormal is a rotation matrix that is not a rotation.
  const edge = normalize(wantEdge);
  if (!edge) throw new Error('the edge direction is degenerate');
  const projected: Vec3 = [
    wantPoint[0] - edge[0] * dot3(wantPoint, edge),
    wantPoint[1] - edge[1] * dot3(wantPoint, edge),
    wantPoint[2] - edge[2] * dot3(wantPoint, edge),
  ];
  const point = normalize(projected);
  if (!point) throw new Error('the point direction is parallel to the edge');
  const flat = cross(edge, point);
  const target: Matrix3 = [edge, point, flat];

  // bone . pivot = target, so pivot = boneᵀ . target. One matrix multiply and
  // no search: the requirement is a rotation and so is the answer.
  const solved = eulerFrom(multiply3(transpose3(boneBasisAt(atMs)), target));
  const rounded = solved.map((value) => Math.round(value * 10) / 10) as [number, number, number];
  const residual = apartDeg(multiply3(boneBasisAt(atMs), eulerMatrix(rounded)), target);

  console.log(`\n  solved at "${atLabel}" for ${want}\n`);
  console.log(`  rotationDeg [${rounded.join(', ')}]   residual ${residual.toFixed(2)} degrees\n`);
  const after = worldAxes(atMs, rounded);
  console.log(`  point  ${say(frame, after.point)}`);
  console.log(`  edge   ${say(frame, after.edge)}`);
  console.log(`  flat   ${say(frame, after.flat)}`);

  if (!process.argv.includes('--write')) {
    console.log('\n  nothing written. Pass --write to put this in biped.skeleton.json.');
    return;
  }
  const sockets = skeletonDoc['sockets'] as { id: string; rotationDeg?: number[] }[];
  const entry = sockets.find((candidate) => candidate.id === socket.id);
  if (!entry) throw new Error(`the skeleton document has no "${socket.id}" socket to write to`);
  entry.rotationDeg = rounded;
  writeFileSync(SKELETON, `${JSON.stringify(skeletonDoc, null, 2)}\n`);
  console.log(`\n  wrote ${SKELETON.slice(repoRoot.length + 1)}`);
}

main();
