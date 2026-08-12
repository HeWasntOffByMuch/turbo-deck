/**
 * A loaded weapon, hung off a socket (spec 140).
 *
 * The three.js half of the weapon format, and deliberately the only impure part
 * of it: `src/items/grip.ts` decides *where the mesh goes* as arithmetic that a
 * test can assert, and this turns that arithmetic into a scene graph.
 *
 * ## Three nodes, and why
 *
 * ```
 *   pivot   -- the socket's own offset and rotation, in the bone's local frame
 *     align -- mesh space to canonical weapon space, and the import scale
 *       model -- the .glb, shifted so its grip point lands on the align origin
 * ```
 *
 * Split because the three transforms answer to three different owners. `pivot`
 * belongs to the **skeleton** -- where a grip sits in a pig's palm is a fact
 * about the pig, and one calibration serves every weapon it ever holds.
 * `align` belongs to the **weapon document**. `model` belongs to whoever
 * exported the mesh and happened to put the origin wherever they put it.
 * Folding them into one matrix would mean re-deriving all three every time a
 * slider moved one of them.
 *
 * ## It is parented, never copied
 *
 * The pivot is added as a child of the socket's bone, so a held weapon rides
 * the pose through three's own graph and there is no per-frame code here at all.
 * The alternative -- reading the bone's world matrix each frame and writing it
 * onto a detached object -- would put the weapon on the *renderer's* clock while
 * the pose is on the machine's, and spec 118's LOD throttles how often the pose
 * is applied. A sword one frame behind the hand at close range and four frames
 * behind it at distance is exactly the bug that would produce.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { gripTransform, type GripTransform, type MeshBounds } from '../../items/grip.js';
import type { WeaponDef } from '../../items/types.js';

/** Where a weapon's bytes are. Ids match the document's, not the file names. */
export interface WeaponAssets {
  readonly meshUrl: string;
}

/**
 * The project's flat-shaded look, applied to whatever the exporter felt like.
 *
 * The base colour is kept, because on these meshes it is the only thing
 * distinguishing steel from grip leather from wood, and there is no texture --
 * the supplied weapons carry three and two materials respectively and no maps.
 * Metalness is dropped rather than honoured: the scene has one directional light
 * and no environment map, so a metallic material renders as a black shape.
 */
function retexture(mesh: THREE.Mesh): void {
  const source = mesh.material as THREE.Material & { color?: THREE.Color; map?: THREE.Texture | null };
  mesh.material = new THREE.MeshLambertMaterial({
    color: source.color?.clone() ?? new THREE.Color(0xb0b4bc),
    ...(source.map ? { map: source.map } : {}),
    flatShading: true,
  });
}

/** The mesh's own extent, for the grip arithmetic. */
function boundsOf(object: THREE.Object3D): MeshBounds {
  const box = new THREE.Box3().setFromObject(object);
  return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
}

export class WeaponRig {
  /** The thing to attach to a socket. Always present, empty until `load` resolves. */
  readonly object = new THREE.Group();

  private readonly align = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private failure: string | null = null;
  private transform: GripTransform | null = null;

  constructor(readonly weapon: WeaponDef) {
    this.object.name = `weapon:${weapon.id}`;
    this.object.add(this.align);
  }

  get error(): string | null {
    return this.failure;
  }

  get loaded(): boolean {
    return this.model !== null;
  }

  /** The resolved grip, once the mesh has been measured. Null before that. */
  get grip(): GripTransform | null {
    return this.transform;
  }

  async load(assets: WeaponAssets): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(assets.meshUrl);
      const model = gltf.scene;
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = true;
        object.receiveShadow = true;
        retexture(object);
      });

      // Measured off the loaded model rather than taken from the document,
      // which says only how long the weapon should be *drawn*. The scale that
      // gets there is a quotient of the two, and inventing either half is how a
      // sword ships at the size of a coin.
      const transform = gripTransform(this.weapon, boundsOf(model));
      this.transform = transform;

      this.align.quaternion.set(...transform.rotation);
      this.align.scale.setScalar(transform.scale);
      // In mesh units: `align` carries the scale, so three multiplies this by it
      // on the way out and the grip lands exactly on the align origin.
      model.position.set(...transform.meshOffset);

      this.align.clear();
      this.align.add(model);
      this.model = model;
      this.failure = null;
    } catch (cause) {
      this.failure = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /** How far the tip reaches from the grip, in world units. Zero until loaded. */
  get reach(): number {
    return this.transform?.tipDistance ?? 0;
  }

  dispose(): void {
    this.align.clear();
    this.object.clear();
    this.model = null;
  }
}

/**
 * The socket's own transform, as a node.
 *
 * Built here rather than in `UnitRig` because it is the same arithmetic whether
 * the thing being hung is a weapon, an effect or a hat, and because the euler
 * order has to be stated in exactly one place: **XYZ**, matching what the
 * schema's `rotationDeg` says and what a tuning slider will assume.
 */
export function socketPivot(
  offset: readonly [number, number, number] | undefined,
  rotationDeg: readonly [number, number, number] | undefined,
): THREE.Group {
  const pivot = new THREE.Group();
  if (offset) pivot.position.set(offset[0], offset[1], offset[2]);
  if (rotationDeg) {
    const d = Math.PI / 180;
    pivot.rotation.set(rotationDeg[0] * d, rotationDeg[1] * d, rotationDeg[2] * d, 'XYZ');
  }
  return pivot;
}
