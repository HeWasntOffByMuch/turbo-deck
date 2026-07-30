import * as THREE from 'three';

/**
 * White hover outlines for unit models (spec 039). Every lit mesh in a rig gets
 * a slightly inflated copy of itself drawn back-faces-only, which reads as a
 * crisp white border around the silhouette -- the cheapest outline there is, and
 * it follows the rig's animation for free because each copy is parented to the
 * mesh it outlines.
 *
 * Purely cosmetic: this decides no game outcome and reads no sim state. The
 * scene builds one handle per rig and toggles it as the cursor moves.
 */

/** The shared outline material: unlit white, back faces only. */
const OUTLINE_MATERIAL = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide });

/** How far the outline stands off the model, in world units (~2 screen pixels). */
export const DEFAULT_OUTLINE_THICKNESS = 2.5;

export interface OutlineHandle {
  /** Show or hide the whole outline. Rigs start un-outlined. */
  setVisible(on: boolean): void;
  /** The outline meshes, for tests and for disposal. */
  readonly meshes: readonly THREE.Mesh[];
}

/**
 * Per-axis scale that puts a uniform `thickness` shell around a box of `size`.
 * Scaling uniformly would give a long thin bone a border proportional to its
 * length (a fat halo at the ends, none along the sides), so each axis is
 * inflated by the same absolute amount instead.
 */
export function outlineScale(size: THREE.Vector3, thickness: number): THREE.Vector3 {
  const axis = (extent: number): number => (extent > 1e-6 ? 1 + (2 * thickness) / extent : 1);
  return new THREE.Vector3(axis(size.x), axis(size.y), axis(size.z));
}

/**
 * Attach an outline to every lit mesh under `root`, hidden until `setVisible`.
 *
 * Only meshes lit by the scene (the flat-shaded Lambert bodies) are outlined:
 * the unlit `MeshBasicMaterial` pieces are flat ground overlays -- heading
 * arrows, markers, cones -- which have no silhouette to trace and would just
 * smear white across the ground.
 */
export function attachOutline(root: THREE.Object3D, thickness = DEFAULT_OUTLINE_THICKNESS): OutlineHandle {
  // Collect first, then attach: adding children mid-traversal would outline the
  // outlines.
  const targets: THREE.Mesh[] = [];
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const material = node.material;
    if (Array.isArray(material) || !(material instanceof THREE.MeshLambertMaterial)) return;
    targets.push(node);
  });

  const meshes: THREE.Mesh[] = [];
  const size = new THREE.Vector3();
  for (const target of targets) {
    target.geometry.computeBoundingBox();
    target.geometry.boundingBox?.getSize(size);
    const shell = new THREE.Mesh(target.geometry, OUTLINE_MATERIAL);
    shell.scale.copy(outlineScale(size, thickness));
    shell.visible = false;
    target.add(shell);
    meshes.push(shell);
  }

  return {
    meshes,
    setVisible(on: boolean): void {
      for (const mesh of meshes) mesh.visible = on;
    },
  };
}
