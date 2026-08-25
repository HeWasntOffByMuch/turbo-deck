import * as THREE from 'three';
import { buildPropField, type PropFieldHandle } from '../props.js';
import type { StructureKind } from '../../../terrain/index.js';

/**
 * The building under the cursor, before it is put down (spec 223).
 *
 * Beside `cursor.ts` and `marker-view.ts`: three.js, impure, and the thing a
 * ring cannot say. A footprint circle says *where* a hut will stand and nothing
 * about which way it faces, how far its eaves reach or how it sits against the
 * one beside it -- so laying out a village with the ring alone is place, look,
 * undo, adjust, place again.
 *
 * Three rules, and each is the reason this is not four lines somewhere else.
 *
 * **It is the thing, not a stand-in.** The geometry comes from
 * `buildPropField`, which is the same function every prop in the map goes
 * through, so what is previewed is what lands. A box roughed out here would be
 * a second description of a hut, correct until somebody edits the first one.
 *
 * **Following the cursor is a transform, never a rebuild.** A prop's placement
 * is exactly `T(x, ground, z) · R(yaw) · S(scale)` applied to its parts' local
 * offsets -- which is what `buildRegionInstances` composes, term for term -- so
 * a ghost built once at the origin and moved is the same geometry a ghost
 * rebuilt every frame would be, for the cost of a matrix instead of a field.
 *
 * **The translucency is safe because materials are not shared.** `props.ts`
 * makes one `MeshLambertMaterial` per batch, so a ghost's materials are its
 * own; the same edit against a shared material would turn every tree in the
 * world see-through, and only in the editor, and only for whoever happened to
 * arm this tool.
 */

/** How much of the ground shows through. Enough to read the shape, little
 *  enough to read the colours it is going to be. */
const GHOST_OPACITY = 0.45;

export interface StructureGhostHandle {
  readonly object: THREE.Object3D;
  /** Stand the ghost at a world point, on the ground, turned and sized. */
  showAt(
    kind: StructureKind,
    x: number,
    z: number,
    yawRadians: number,
    scale: number,
    groundAt: (x: number, z: number) => number,
  ): void;
  hide(): void;
  /**
   * What is actually **on the scene graph** right now, or null for nothing.
   *
   * Counted off the graph rather than off what was last asked for, the way the
   * editor's ground and prop readouts are: a ghost built and hung on nothing,
   * or one left visible after the tool was disarmed, has to read as wrong here
   * or the readout is worse than no readout.
   */
  drawn(): { readonly kind: StructureKind; readonly meshes: number; readonly scale: number } | null;
  /** Which kinds have been built. For the test that says each is built once. */
  builtKinds(): readonly StructureKind[];
  dispose(): void;
}

export function createStructureGhost(): StructureGhostHandle {
  const root = new THREE.Group();
  // Nothing here is scenery, so it takes no part in culling decisions made for
  // scenery: the group is moved every frame and its children were built around
  // an origin the group has since left.
  root.frustumCulled = false;
  root.visible = false;
  root.renderOrder = 9;

  const built = new Map<StructureKind, { field: PropFieldHandle; holder: THREE.Group }>();

  function ghostFor(kind: StructureKind): THREE.Group {
    const held = built.get(kind);
    if (held) return held.holder;

    // At the origin, upright, at scale 1: the group transform is what puts it
    // where the cursor is. `() => 0` is the ground under it, so every part's
    // height is its own `offsetY` and nothing else.
    const field = buildPropField([{ kind, x: 0, y: 0, scale: 1, rotation: 0, tint: 0 }], () => 0);
    const holder = new THREE.Group();
    holder.add(field.group);
    field.group.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      // Replaced rather than mutated. The material this drops is the batch's
      // own and is disposed with the field; what matters is that nothing else
      // is holding it, which is what makes the swap local to the ghost.
      const source = node.material as THREE.MeshLambertMaterial;
      node.material = new THREE.MeshLambertMaterial({
        flatShading: source.flatShading,
        transparent: true,
        opacity: GHOST_OPACITY,
        // Off, or the near parts of the ghost hide the far ones and a
        // see-through hut comes out as a solid one with holes in it.
        depthWrite: false,
      });
      // A preview is not in the world yet, so it neither throws shade nor
      // catches it -- a shadow under a building nobody has placed is the one
      // part of this that would still be on screen after the cursor left.
      node.castShadow = false;
      node.receiveShadow = false;
      node.frustumCulled = false;
    });
    built.set(kind, { field, holder });
    root.add(holder);
    return holder;
  }

  return {
    object: root,

    showAt(kind, x, z, yawRadians, scale, groundAt): void {
      const holder = ghostFor(kind);
      for (const [other, entry] of built) entry.holder.visible = other === kind;
      root.visible = true;
      // Placed exactly as `buildRegionInstances` would: on the ground under the
      // prop's own centre, turned about world up, scaled uniformly.
      holder.position.set(0, 0, 0);
      root.position.set(x, groundAt(x, z), z);
      root.rotation.set(0, yawRadians, 0);
      root.scale.setScalar(scale);
    },

    hide(): void {
      root.visible = false;
    },

    drawn(): { kind: StructureKind; meshes: number; scale: number } | null {
      if (!root.visible) return null;
      for (const [kind, entry] of built) {
        if (!entry.holder.visible) continue;
        let meshes = 0;
        entry.holder.traverse((node) => {
          if (node instanceof THREE.Mesh && node.visible) meshes++;
        });
        return { kind, meshes, scale: root.scale.x };
      }
      return null;
    },

    builtKinds(): readonly StructureKind[] {
      return [...built.keys()];
    },

    dispose(): void {
      for (const { field, holder } of built.values()) {
        holder.traverse((node) => {
          if (node instanceof THREE.Mesh) (node.material as THREE.Material).dispose();
        });
        // The field owns the geometry -- shells over shared attributes, which
        // it knows how to take apart and this does not.
        field.dispose();
        root.remove(holder);
      }
      built.clear();
    },
  };
}
