import * as THREE from 'three';

/**
 * The hover highlight for unit models (spec 095, replacing spec 041's outline).
 *
 * A hovered unit simply gets brighter. The lift is an emissive term proportional
 * to the material's own colour, so the hue and the flat-shaded facets survive it
 * -- a unit reads as *lit up*, not as *selected*, which is the honest thing for
 * a cursor that has selected nothing. It reaches the shadowed side of a body as
 * well as the lit one, so it says the same thing at every camera angle.
 *
 * This replaces a white back-face shell around every mesh. The shell was louder
 * than the thing it was pointing at, and it doubled the rig's draw calls to say
 * it.
 *
 * Purely cosmetic: this decides no game outcome and reads no sim state. The
 * scene builds one handle per rig and toggles it as the cursor moves.
 */

/** How much of its own colour a highlighted unit emits on top of its shading. */
export const HOVER_BRIGHTNESS = 0.35;

export interface HighlightHandle {
  /** Brighten or un-brighten the whole rig. Rigs start un-highlighted. */
  setHighlighted(on: boolean): void;
  /** The materials this handle owns, for tests and for disposal. */
  readonly materials: readonly THREE.MeshLambertMaterial[];
}

/**
 * The emissive term that lifts `base` by `brightness` without shifting its hue.
 *
 * Scaling the colour itself would clamp -- a bright coat is already near 1 on
 * some channel and would drift toward whichever channel had headroom left, so a
 * tan cow would go pink. An additive term of the same colour cannot do that: it
 * is the same hue by construction, and the renderer's own clamp is the only
 * ceiling.
 */
export function highlightEmissive(base: THREE.Color, brightness: number): THREE.Color {
  return base.clone().multiplyScalar(brightness);
}

/** What one owned material needs to remember to be put back the way it was. */
interface Owned {
  readonly material: THREE.MeshLambertMaterial;
  readonly lit: THREE.Color;
  readonly unlit: THREE.Color;
}

/**
 * Attach a highlight to every lit mesh under `root`, off until `setHighlighted`.
 *
 * Only meshes lit by the scene (the flat-shaded Lambert bodies) take part: the
 * unlit `MeshBasicMaterial` pieces are flat ground overlays -- heading arrows,
 * markers, cones -- which are not part of the body and would read as a puddle of
 * light around the feet.
 *
 * Each distinct material found is **cloned**, and the meshes are re-pointed at
 * the copy. That is the whole reason this is a function rather than three lines
 * in the scene: `flatMaterial` in `meshes.ts` caches on colour alone, so every
 * mech rig, tree and prop sharing a brown shares one material object, and an
 * emissive term written into it would light up the scenery. The price is that a
 * rig recoloured after the fact (`CritterRig.setCoat`) writes to materials
 * nothing draws any more -- which is fine, because `setCoat` belongs to the two
 * tuning sandboxes and the Play tab never calls it.
 */
export function attachHighlight(
  root: THREE.Object3D,
  brightness = HOVER_BRIGHTNESS,
): HighlightHandle {
  // Keyed on the original, so two meshes that shared a material inside this rig
  // still share one afterwards -- the clone is per material, not per mesh.
  const owned = new Map<THREE.MeshLambertMaterial, Owned>();

  /** The copy this handle owns of `material`, made on first sight of it. */
  const mine = (material: THREE.Material): THREE.Material => {
    if (!(material instanceof THREE.MeshLambertMaterial)) return material;
    let already = owned.get(material);
    if (!already) {
      const clone = material.clone();
      already = {
        material: clone,
        lit: highlightEmissive(clone.color, brightness),
        unlit: clone.emissive.clone(),
      };
      owned.set(material, already);
    }
    return already.material;
  };

  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    // A rig block wearing more than one coat role arrives as an array of
    // materials, one per group (`critter.ts`). Taking them one at a time is the
    // difference between a cow that brightens and a cow whose face does not.
    const material = node.material;
    node.material = Array.isArray(material) ? material.map(mine) : mine(material);
  });

  const entries = [...owned.values()];
  return {
    materials: entries.map((entry) => entry.material),
    setHighlighted(on: boolean): void {
      for (const entry of entries) entry.material.emissive.copy(on ? entry.lit : entry.unlit);
    },
  };
}
