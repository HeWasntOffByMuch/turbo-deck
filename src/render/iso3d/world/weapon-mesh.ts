/**
 * The three.js half of a held weapon (spec 121).
 *
 * `weapon-shape.ts` says how big each piece is; this turns that into meshes.
 * Everything here is presentation: what a weapon *does* is the item table's
 * business and it is decided on the server, so nothing worked out in this file
 * is ever sent anywhere.
 *
 * Built along `+y` with the grip at the origin, because that is the frame the
 * profile is authored in. Where the hand points it is the socket's business.
 */

import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { weaponProfile, type WeaponKind, type WeaponProfile } from './weapon-shape.js';

/**
 * What each weapon is made of.
 *
 * Two materials at most: at the size a body is drawn, a third reads as noise.
 * The haft is the wood the arrow shaft already uses and the business end is the
 * steel the shuriken already uses -- a weapon in a hand should look like it came
 * out of the same box as the arrow that flies out of the bow.
 */
const HAFT = PALETTE.arrowShaft;
const STEEL = PALETTE.shurikenSteel;

/** Low segment counts on purpose: these are a few pixels wide in play. */
const SIDES = 6;

function part(
  geometry: THREE.BufferGeometry,
  color: number,
  y: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color }));
  mesh.position.y = y;
  mesh.castShadow = true;
  return mesh;
}

/**
 * A weapon, built at the size the profile says.
 *
 * The caller owns disposing it -- `UnitRig.attach` replacing an occupant takes
 * it out of the scene graph but does not free its buffers, because a rig has no
 * business deciding whether something it was handed is still wanted.
 */
export function buildWeapon(kind: WeaponKind, bodyHeight: number): THREE.Group {
  const profile = weaponProfile(kind, bodyHeight);
  const group = new THREE.Group();
  group.name = `weapon.${kind}`;

  // The shaft, from the butt of the grip to wherever the head starts. A bow's
  // "shaft" is its whole limb and a sword's is its blade -- one cylinder covers
  // all of them, and what makes them read differently is what is on the end.
  const shaftEnd = profile.headLength > 0 ? profile.length * profile.headAt : profile.length;
  const shaftLength = shaftEnd + profile.gripOffset;
  group.add(
    part(
      new THREE.CylinderGeometry(profile.shaftRadius, profile.shaftRadius, shaftLength, SIDES),
      bladeLike(kind) ? STEEL : HAFT,
      shaftLength / 2 - profile.gripOffset,
    ),
  );

  if (profile.headLength > 0) {
    // Sat at the top of the shaft rather than centred on it, so a maul's weight
    // is at the end where it belongs.
    group.add(
      part(
        new THREE.CylinderGeometry(profile.headRadius, profile.headRadius, profile.headLength, SIDES),
        STEEL,
        shaftEnd + profile.headLength / 2,
      ),
    );
  }

  if (profile.guardSpan > 0) {
    // Across the blade, which is what makes the silhouette read as a sword
    // rather than as a stick with a point on it.
    const guard = part(
      new THREE.BoxGeometry(profile.guardSpan * 2, profile.shaftRadius * 1.2, profile.shaftRadius * 2),
      STEEL,
      0,
    );
    group.add(guard);
  }

  // A grip of a different material on anything held by a haft, so the hand end
  // is distinguishable from the business end at a glance.
  if (!bladeLike(kind) && profile.gripOffset > 0) {
    group.add(
      part(
        new THREE.CylinderGeometry(profile.shaftRadius * 1.25, profile.shaftRadius * 1.25, profile.gripOffset * 1.6, SIDES),
        HAFT,
        0,
      ),
    );
  }

  return group;
}

/** Whether the shaft itself is the metal part. */
function bladeLike(kind: WeaponKind): boolean {
  return kind === 'sword' || kind === 'thrown';
}

/** Frees a built weapon's buffers and materials. */
export function disposeWeapon(object: THREE.Object3D): void {
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry.dispose();
    const material = node.material as THREE.Material | THREE.Material[];
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
    else material.dispose();
  });
}

export type { WeaponProfile };
