/**
 * Where a weapon's mesh sits once something is holding it (spec 140).
 *
 * Pure arithmetic over a document and a bounding box: no `.glb` decoding, no
 * three.js, no scene. That split is the point -- the transform a sword is drawn
 * with is the single thing most likely to be subtly wrong, and subtly wrong is
 * exactly what a picture cannot settle. Here it can be asserted.
 *
 * ## Canonical weapon space
 *
 * Stated once, here, because every other file only has to agree with it:
 *
 *  - **+Y** is the way the business end points.
 *  - **+Z** is the flat of the blade's normal.
 *  - **+X** is the edge, and follows from the other two.
 *  - The **origin** is the grip -- the point that sits in the palm.
 *
 * Which axis got which job is arbitrary and had to be written down somewhere.
 * What is *not* arbitrary is that it is a full basis rather than a direction: a
 * weapon aligned by its point axis alone is free to roll about its own length,
 * and nothing downstream would ever pin it.
 *
 * Everything after this is the socket's business: `weapon.main` carries the
 * offset and rotation that put canonical weapon space into a particular pig's
 * palm, so a second weapon costs no calibration and a second *rig* costs one.
 */

import type { Axis, Vec3, WeaponDef } from './types.js';

export type Quat = readonly [number, number, number, number];

/** A mesh's extent, in its own coordinates. */
export interface MeshBounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

const AXIS_VECTORS: Readonly<Record<Axis, Vec3>> = {
  '+X': [1, 0, 0],
  '-X': [-1, 0, 0],
  '+Y': [0, 1, 0],
  '-Y': [0, -1, 0],
  '+Z': [0, 0, 1],
  '-Z': [0, 0, -1],
};

export function axisVector(axis: Axis): Vec3 {
  return AXIS_VECTORS[axis];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Unit length, or null for something too short to have a direction. */
export function normalize(v: Vec3): Vec3 | null {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length < 1e-9 ? null : [v[0] / length, v[1] / length, v[2] / length];
}

/** Whether two axes span a plane, which is what a basis needs them to do. */
export function axesArePerpendicular(a: Axis, b: Axis): boolean {
  return dot(axisVector(a), axisVector(b)) === 0;
}

/**
 * The edge direction, in mesh coordinates.
 *
 * `edge x point = flat`, which is what makes (edge, point, flat) right-handed in
 * the order (X, Y, Z) -- so the basis below can be read straight off as a
 * rotation matrix rather than a reflection. A left-handed basis here would draw
 * every weapon mirrored, and a mirrored sword looks fine until it is beside
 * another one.
 */
export function edgeAxis(grip: { readonly point: Axis; readonly flat: Axis }): Vec3 {
  return cross(axisVector(grip.point), axisVector(grip.flat));
}

/**
 * How far the mesh runs along its own point axis: the length of the thing.
 *
 * Along the point axis rather than the longest bounding-box side, because those
 * differ for anything bent -- and one of the two weapons this was written for is
 * a bent stick.
 */
export function measuredLength(bounds: MeshBounds, point: Axis): number {
  const along = axisVector(point);
  let span = 0;
  for (let i = 0; i < 3; i += 1) {
    if ((along[i] ?? 0) === 0) continue;
    span = Math.abs((bounds.max[i] ?? 0) - (bounds.min[i] ?? 0));
  }
  return span;
}

/**
 * The rotation carrying mesh space into canonical weapon space, as a quaternion.
 *
 * Built from the basis rather than from Euler angles, because the three axes are
 * known exactly and any angle decomposition of them is a chance to pick the
 * wrong one of two valid answers.
 */
export function alignRotation(grip: { readonly point: Axis; readonly flat: Axis }): Quat {
  const x = edgeAxis(grip);
  const y = axisVector(grip.point);
  const z = axisVector(grip.flat);
  // Rows are the mesh basis, so the matrix maps each mesh axis onto its
  // canonical one. Column-major, matching glTF and three.
  const m = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  return matrixToQuat(m);
}

/** Shepperd's method: pick the largest diagonal term, so no branch divides by ~0. */
function matrixToQuat(m: readonly number[]): Quat {
  const m00 = m[0] ?? 0;
  const m01 = m[3] ?? 0;
  const m02 = m[6] ?? 0;
  const m10 = m[1] ?? 0;
  const m11 = m[4] ?? 0;
  const m12 = m[7] ?? 0;
  const m20 = m[2] ?? 0;
  const m21 = m[5] ?? 0;
  const m22 = m[8] ?? 0;
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
}

/**
 * The socket rotation that puts a held weapon into a chosen world orientation.
 *
 * The calibration in `pig.skeleton.json` used to be *swept* -- candidate euler
 * triples rendered side by side until one looked right. That is the correct way
 * to answer "which of these looks better" and a poor way to answer "hold it
 * edge-up, pointing forward", because the second question has an exact answer
 * and sweeping finds an approximation of it.
 *
 * So: given the bone's world matrix and the two world directions the weapon is
 * wanted in, this returns the euler degrees the socket needs. The composition it
 * inverts is the one `socketPivot` builds --
 * `boneWorld . pivotRotation . canonicalWeaponSpace` -- so the answer is
 * `boneRotation^-1 * desiredBasis`, and the only fiddly parts are stripping the
 * bone's scale and matching three's XYZ euler order exactly.
 *
 * `flat` is re-orthogonalised against `blade` rather than trusted: a caller
 * asking for a blade 30 degrees off vertical with its flat facing sideways has
 * given two directions that are already perpendicular, but one that names them
 * loosely should get the nearest legal basis rather than a skewed one.
 */
export function socketEulerFor(boneWorld: readonly number[], blade: Vec3, flat: Vec3): Vec3 {
  const y = normalize(blade);
  if (!y) return [0, 0, 0];
  // Gram-Schmidt: drop whatever part of `flat` lies along the blade.
  const along = dot(flat, y);
  const z = normalize([flat[0] - y[0] * along, flat[1] - y[1] * along, flat[2] - y[2] * along]);
  if (!z) return [0, 0, 0];
  const x = cross(y, z);

  // The bone's rotation, with any scale divided out. Columns of a column-major
  // matrix are its basis vectors.
  const bone = [0, 1, 2].map((column) => {
    const axis: Vec3 = [
      boneWorld[column * 4] ?? 0,
      boneWorld[column * 4 + 1] ?? 0,
      boneWorld[column * 4 + 2] ?? 0,
    ];
    return normalize(axis) ?? ([column === 0 ? 1 : 0, column === 1 ? 1 : 0, column === 2 ? 1 : 0] as Vec3);
  });

  // `boneRotation^-1 * desired`, and the inverse of a rotation is its transpose,
  // so each entry is a dot of one bone axis with one desired axis.
  const desired: Vec3[] = [x, y, z];
  const local: number[] = [];
  for (const target of desired) {
    for (const source of bone) local.push(dot(source, target));
  }
  return eulerXyzOf(local);
}

/**
 * Euler XYZ degrees to a quaternion, matching what `socketPivot` builds.
 *
 * The inverse of {@link eulerXyzOf}, and it lives beside it so the two cannot
 * drift into different conventions -- which is the whole failure mode of having
 * an angle triple in a document at all.
 */
export function quatFromEulerXyz(degrees: Vec3): Quat {
  const half = Math.PI / 360;
  const [cx, cy, cz] = [Math.cos(degrees[0] * half), Math.cos(degrees[1] * half), Math.cos(degrees[2] * half)];
  const [sx, sy, sz] = [Math.sin(degrees[0] * half), Math.sin(degrees[1] * half), Math.sin(degrees[2] * half)];
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

/** Turns a vector by a quaternion. */
export function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  const t: Vec3 = [2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])];
  return [
    v[0] + q[3] * t[0] + (q[1] * t[2] - q[2] * t[1]),
    v[1] + q[3] * t[1] + (q[2] * t[0] - q[0] * t[2]),
    v[2] + q[3] * t[2] + (q[0] * t[1] - q[1] * t[0]),
  ];
}

/**
 * Euler XYZ degrees from a column-major 3x3 rotation.
 *
 * The order matters and is not a detail: `socketPivot` sets `rotation.set(x, y,
 * z, 'XYZ')`, the schema's `rotationDeg` says XYZ, and a decomposition in any
 * other order produces numbers that are individually plausible and jointly
 * wrong.
 */
export function eulerXyzOf(m: readonly number[]): Vec3 {
  const at = (row: number, column: number): number => m[column * 3 + row] ?? 0;
  const clamp = (value: number): number => Math.max(-1, Math.min(1, value));
  const degrees = 180 / Math.PI;

  const yAngle = Math.asin(clamp(at(0, 2)));
  // Near a quarter-turn about Y the other two angles trade off against each
  // other and only their sum is determined; pinning Z to zero is the standard
  // choice and the one three makes.
  if (Math.abs(at(0, 2)) < 0.9999999) {
    return [
      Math.atan2(-at(1, 2), at(2, 2)) * degrees,
      yAngle * degrees,
      Math.atan2(-at(0, 1), at(0, 0)) * degrees,
    ];
  }
  return [Math.atan2(at(2, 1), at(1, 1)) * degrees, yAngle * degrees, 0];
}

/** Everything a renderer needs to hang a mesh off a socket. */
export interface GripTransform {
  /** Uniform, from `lengthWorld` over what the mesh actually measures. */
  readonly scale: number;
  /** Mesh space to canonical weapon space. */
  readonly rotation: Quat;
  /**
   * Where the mesh's own origin goes, in **mesh units**, before scaling.
   *
   * The negated grip point, which is the whole of it: moving the grip to the
   * origin is what makes the socket's transform mean "where the hand is" rather
   * than "where the hand is, plus wherever this exporter happened to put 0,0,0".
   */
  readonly meshOffset: Vec3;
  /** How far the tip sits from the grip once drawn, in world units. */
  readonly tipDistance: number;
  /** How far the butt sits from the grip once drawn, in world units. */
  readonly buttDistance: number;
}

/**
 * Resolves a document against the mesh it describes.
 *
 * Refuses nothing: the validator is what refuses, and this runs on documents
 * that already passed it. A zero-length mesh gets a scale of 1 rather than an
 * infinity, so a broken asset draws at the wrong size instead of vanishing --
 * which is the difference between a bug somebody reports and a bug somebody
 * shrugs at.
 */
export function gripTransform(weapon: WeaponDef, bounds: MeshBounds): GripTransform {
  const length = measuredLength(bounds, weapon.grip.point);
  const scale = length > 0 ? weapon.lengthWorld / length : 1;
  const along = axisVector(weapon.grip.point);

  // How far the extremes sit from the grip *along the point axis*, which is the
  // only direction either of them is interesting in.
  let tip = 0;
  let butt = 0;
  for (let i = 0; i < 3; i += 1) {
    const sign = along[i] ?? 0;
    if (sign === 0) continue;
    const lo = bounds.min[i] ?? 0;
    const hi = bounds.max[i] ?? 0;
    const at = weapon.grip.at[i] ?? 0;
    // `sign` is +1 or -1, so the far end in the point direction is whichever of
    // the two bounds it selects.
    tip = Math.abs((sign > 0 ? hi : lo) - at);
    butt = Math.abs((sign > 0 ? lo : hi) - at);
  }

  return {
    scale,
    rotation: alignRotation(weapon.grip),
    meshOffset: [-(weapon.grip.at[0] ?? 0), -(weapon.grip.at[1] ?? 0), -(weapon.grip.at[2] ?? 0)],
    tipDistance: tip * scale,
    buttDistance: butt * scale,
  };
}
