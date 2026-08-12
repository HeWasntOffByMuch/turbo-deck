/**
 * A weapon on a socket, through three's own scene graph (spec 140).
 *
 * `items/grip.test.ts` checks the arithmetic and knows nothing about three.
 * `preview-weapon.ts` draws the real mesh at the real pose and reimplements the
 * grip chain as matrices, so it cannot catch a mistake in `attach` -- it would
 * make the same mistake independently and agree with itself.
 *
 * This is the only thing that runs the chain the browser runs: `socketPivot`
 * building a pivot, three composing it under a bone, and a world matrix coming
 * out the far end. No WebGL is involved -- a scene graph is arithmetic.
 *
 * The **bones come from `biped.skeleton.json`'s bind pose, not from the `.glb`**,
 * and that is a limitation worth naming rather than hiding. The pig's mesh
 * carries a texture, so `GLTFLoader` reaches for an image decoder, and there is
 * no DOM in `npm test`; adding jsdom to load one mesh would be a dependency
 * bought for a single assertion. What is lost is small -- the bind pose in that
 * document was measured off exactly this `.glb` and is checked against it
 * elsewhere -- and it is the frame the socket offsets are expressed in anyway.
 * The browser driver (`scripts/preview-sandbox-swing.ts`) is what covers the
 * loaded rig.
 *
 * The weapon meshes themselves *are* loaded, because they have no textures.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { gripTransform } from '../../items/grip.js';
import { validateWeaponDef } from '../../items/validate.js';
import { validateSkeleton } from '../../units/validate.js';
import { socketPivot } from './weapon-rig.js';
import type { WeaponDef } from '../../items/types.js';
import type { Skeleton } from '../../units/types.js';

const UNITS = join(process.cwd(), 'assets', 'units');
const ITEMS = join(process.cwd(), 'assets', 'items');
/** The pig's own import scale, which a socket pivot has to undo. */
const HOST_SCALE = 55.75888947864023;

function read(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function loadScene(path: string): Promise<THREE.Group> {
  const gltf = await new GLTFLoader().parseAsync(read(path), '');
  return gltf.scene;
}

/**
 * The pig's rig, built from the bind pose the skeleton document records.
 *
 * Parent-before-child is a contract of the format, so one pass suffices. Bones
 * rather than plain objects, because that is what a socket is attached under in
 * the browser and `THREE.Bone` has different update semantics.
 */
function buildRig(skeleton: Skeleton): THREE.Group {
  const root = new THREE.Group();
  root.scale.setScalar(HOST_SCALE);
  const bones = new Map<string, THREE.Bone>();
  const pose = skeleton.bindPose;
  if (!pose) throw new Error('the pig skeleton has no bind pose');

  for (const entry of pose.bones) {
    const bone = new THREE.Bone();
    bone.name = entry.name;
    bone.position.set(...entry.translation);
    bone.quaternion.set(...entry.rotation);
    bone.scale.set(...entry.scale);
    bones.set(entry.name, bone);
    const parentName = skeleton.bones.find((declared) => declared.name === entry.name)?.parent ?? null;
    const parent = parentName === null ? null : bones.get(parentName);
    (parent ?? root).add(bone);
  }
  root.updateMatrixWorld(true);
  return root;
}

function weaponDoc(id: string): WeaponDef {
  const result = validateWeaponDef(JSON.parse(readFileSync(join(ITEMS, id, `${id}.weapondef.json`), 'utf8')));
  if (!result.value) throw new Error(`${id} does not validate`);
  return result.value;
}

/**
 * The three-node chain `WeaponRig` builds, assembled here from the same parts.
 *
 * Built rather than imported because `WeaponRig.load` fetches a URL, and what is
 * being checked is the *transform*, not the fetch.
 */
function heldObject(weapon: WeaponDef, mesh: THREE.Object3D): THREE.Group {
  const box = new THREE.Box3().setFromObject(mesh);
  const grip = gripTransform(weapon, {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  });
  const outer = new THREE.Group();
  const align = new THREE.Group();
  align.quaternion.set(...grip.rotation);
  align.scale.setScalar(grip.scale);
  mesh.position.set(...grip.meshOffset);
  align.add(mesh);
  outer.add(align);
  return outer;
}

describe('a weapon hung off a pig', () => {
  let pig: THREE.Group;
  let skeleton: Skeleton;

  beforeAll(() => {
    const parsed = validateSkeleton(JSON.parse(readFileSync(join(UNITS, 'biped.skeleton.json'), 'utf8')));
    if (!parsed.value) throw new Error('biped.skeleton.json does not validate');
    skeleton = parsed.value;
    pig = buildRig(skeleton);
  });

  /** Attaches by hand the way `UnitRig.attach` does, and returns the pivot. */
  function attach(socketId: string, object: THREE.Object3D): THREE.Group {
    const socket = skeleton.sockets.find((entry) => entry.id === socketId);
    if (!socket) throw new Error(`no socket ${socketId}`);
    const bone = pig.getObjectByName(socket.bone);
    if (!bone) throw new Error(`no bone ${socket.bone}`);
    const pivot = socketPivot(socket.offset, socket.rotationDeg, HOST_SCALE);
    pivot.add(object);
    bone.add(pivot);
    pig.updateMatrixWorld(true);
    return pivot;
  }

  it('has the sockets a weapon names, on bones the rig has', () => {
    for (const id of ['weapon.main', 'weapon.stow']) {
      const socket = skeleton.sockets.find((entry) => entry.id === id);
      expect(socket, `${id} is missing from the skeleton`).toBeDefined();
      expect(pig.getObjectByName(socket?.bone ?? ''), `${socket?.bone} is not in the rig`).toBeDefined();
    }
  });

  it('puts the grip in the hand and the tip a weapon-length away', async () => {
    const weapon = weaponDoc('sword_jian');
    const mesh = await loadScene(join(ITEMS, 'sword_jian', weapon.meshRef));
    const box0 = new THREE.Box3().setFromObject(mesh);
    const grip = gripTransform(weapon, {
      min: [box0.min.x, box0.min.y, box0.min.z],
      max: [box0.max.x, box0.max.y, box0.max.z],
    });
    const held = heldObject(weapon, mesh);
    const pivot = attach('weapon.main', held);

    // The grip -- the object's own origin, by construction -- sits where the
    // socket does. Within a world unit on a body 55 tall.
    const gripAt = new THREE.Vector3().setFromMatrixPosition(held.matrixWorld);
    const socketAt = new THREE.Vector3().setFromMatrixPosition(pivot.matrixWorld);
    expect(gripAt.distanceTo(socketAt)).toBeLessThan(1);

    // And the drawn thing is the length its document asked for, whatever the
    // mesh was authored at and whatever scale the bone chain carries.
    //
    // Measured tip to butt along the object's own +Y rather than off a bounding
    // box: a box is axis-aligned in world space and a held sword is diagonal, so
    // its widest side is shorter than the blade and the assertion would fail on
    // a weapon that was drawn perfectly.
    const box = new THREE.Box3().setFromObject(held);
    const tip = new THREE.Vector3(0, grip.tipDistance, 0).applyMatrix4(held.matrixWorld);
    const butt = new THREE.Vector3(0, -grip.buttDistance, 0).applyMatrix4(held.matrixWorld);
    expect(tip.distanceTo(butt)).toBeCloseTo(weapon.lengthWorld, 1);
    // And the box is at least big enough to contain it, which catches a mesh
    // that was scaled to nothing while the maths still said 38.
    expect(box.getSize(new THREE.Vector3()).length()).toBeGreaterThan(weapon.lengthWorld * 0.8);
  });

  it('undoes the host scale, so a sword is one size whatever holds it', async () => {
    // The failure this catches is a sword drawn 55 times too big, which is what
    // happens when a world-unit length is hung under a bone that already carries
    // the import scale.
    const weapon = weaponDoc('stick_knot');
    const mesh = await loadScene(join(ITEMS, 'stick_knot', weapon.meshRef));
    const held = heldObject(weapon, mesh);
    attach('weapon.main', held);

    const scale = new THREE.Vector3();
    held.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    const box = new THREE.Box3().setFromObject(held);
    expect(box.max.y - box.min.y).toBeLessThan(weapon.lengthWorld * 1.1);
    expect(scale.x).toBeGreaterThan(0);
  });

  it('points the blade out of the hand rather than into the pig', async () => {
    const weapon = weaponDoc('sword_jian');
    const mesh = await loadScene(join(ITEMS, 'sword_jian', weapon.meshRef));
    const held = heldObject(weapon, mesh);
    attach('weapon.main', held);

    // Canonical weapon space runs the blade along +Y, so the tip is that far
    // along the object's own +Y in world space.
    const grip = new THREE.Vector3().setFromMatrixPosition(held.matrixWorld);
    const tip = new THREE.Vector3(0, 1, 0).applyMatrix4(held.matrixWorld);
    const chest = pig.getObjectByName('Spine02');
    expect(chest).toBeDefined();
    const chestAt = new THREE.Vector3().setFromMatrixPosition(chest?.matrixWorld ?? new THREE.Matrix4());
    // The tip is further from the body's middle than the grip is: a blade that
    // came out backwards would fail this and look, at a glance, merely odd.
    expect(tip.distanceTo(chestAt)).toBeGreaterThan(grip.distanceTo(chestAt));
  });

  it('puts a stowed weapon on the back, not in the hand', async () => {
    const weapon = weaponDoc('sword_jian');
    const hand = pig.getObjectByName('R_Hand');
    const stowed = heldObject(weapon, await loadScene(join(ITEMS, 'sword_jian', weapon.meshRef)));
    const pivot = attach('weapon.stow', stowed);
    expect(pivot.parent?.name).toBe('Spine02');
    expect(pivot.parent?.name).not.toBe(hand?.name);

    const at = new THREE.Vector3().setFromMatrixPosition(stowed.matrixWorld);
    const handAt = new THREE.Vector3().setFromMatrixPosition(hand?.matrixWorld ?? new THREE.Matrix4());
    // Well clear of the hand -- otherwise "sheathed" is a word rather than a
    // place.
    expect(at.distanceTo(handAt)).toBeGreaterThan(5);
  });

  it('rides the pose: moving the bone moves the weapon', async () => {
    const weapon = weaponDoc('sword_jian');
    const held = heldObject(weapon, await loadScene(join(ITEMS, 'sword_jian', weapon.meshRef)));
    attach('weapon.main', held);

    const before = new THREE.Vector3().setFromMatrixPosition(held.matrixWorld);
    const shoulder = pig.getObjectByName('R_Upperarm');
    expect(shoulder).toBeDefined();
    shoulder?.rotateX(1);
    pig.updateMatrixWorld(true);
    const after = new THREE.Vector3().setFromMatrixPosition(held.matrixWorld);

    // Parented, not copied: no per-frame code ran between these two lines.
    expect(after.distanceTo(before)).toBeGreaterThan(1);
    shoulder?.rotateX(-1);
    pig.updateMatrixWorld(true);
  });
});
