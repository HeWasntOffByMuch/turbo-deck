import * as THREE from 'three';
import { NO_TINT, type LightTint } from './player-lights.js';

/**
 * The local player, taken out of the lights they are carrying (spec 118).
 *
 * The three.js half of `player-lights.ts`, and the only place in the renderer
 * that edits a shader string. It does three things to whichever rig is the
 * local player:
 *
 * - **Kills the point-light term** in every lit material under it, so the torch
 *   and the orb light the world and not the body holding them.
 * - **Lifts the finished shading** by a tint uniform every one of those
 *   materials shares, which is the flat brightening filter the body gets
 *   instead. See {@link patchFragment} for why it is added rather than
 *   multiplied.
 * - **Keeps the body out of point-light shadow maps**, optionally, so the
 *   player's own silhouette does not swing across their feet as the flame
 *   gutters.
 *
 * ## Why a shader patch and not layers
 *
 * `Object3D.layers` looks like the answer and is not. three 0.160 tests a
 * light's layers against the **camera** (`WebGLRenderer.projectObject`), never
 * against the object being lit, so a light is either in the frame or out of it
 * and there is no per-object exclusion to reach for. What is left is rendering
 * the scene twice with different camera layers -- which runs the shadow pass
 * twice for the sake of one rig -- or rewriting the one chunk that reads the
 * point lights. This is the second. The two markers it replaces are asserted by
 * a test, so a three.js upgrade that renames them fails in Node rather than
 * quietly shipping a player lit by their own torch again.
 *
 * ## Why the materials are patched in place
 *
 * Every lit material under a body is already private to that body:
 * `attachHighlight` clones the colour-keyed `flatMaterial` cache per rig, and
 * `UnitRig` builds a fresh `MeshLambertMaterial` per mesh on every load. Cloning
 * them again here would leave the hover highlight writing its emissive term into
 * a copy that nothing draws.
 *
 * Purely cosmetic, like everything else in this directory: no branch here
 * changes a game outcome and the sim is never told any of it.
 */

/** The uniform name the patched materials share. Prefixed so nothing collides. */
const TINT_UNIFORM = 'turboPlayerTint';

/**
 * The line in `lights_fragment_begin` that fetches one point light's
 * contribution. Zeroing the colour immediately after it is the whole exclusion:
 * `RE_Direct` still runs, and adds nothing.
 */
const POINT_LIGHT_CALL = 'getPointLightInfo( pointLight, geometryPosition, directLight );';

/** Where the shading becomes a pixel, and so where the filter is applied. */
const OUTPUT_INCLUDE = '#include <opaque_fragment>';

/** The include the point-light loop arrives in. */
const LIGHTS_INCLUDE = '#include <lights_fragment_begin>';

/**
 * Whether three's own chunk still says what this module rewrites.
 *
 * Exported for the test rather than checked at runtime: a failed replace is a
 * silent no-op in a browser and a red test in Node, and the second is the one
 * worth having.
 */
export function shaderMarkersPresent(): boolean {
  return THREE.ShaderChunk.lights_fragment_begin.includes(POINT_LIGHT_CALL);
}

/**
 * `lights_fragment_begin` with the point-light term zeroed.
 *
 * Built from the chunk rather than from a copy of it, so everything else the
 * chunk does -- the directional lights, the hemisphere fill, the shadow terms --
 * stays whatever the installed three.js says it is.
 */
function unlitByPointLights(): string {
  return THREE.ShaderChunk.lights_fragment_begin.replace(
    POINT_LIGHT_CALL,
    `${POINT_LIGHT_CALL}\n\t\tdirectLight.color = vec3( 0.0 );`,
  );
}

/**
 * The filter, as one line after `opaque_fragment`.
 *
 * **Added, not multiplied,** which is the whole difference between this working
 * and this being invisible. The tint is a multiplier -- what the body would be
 * scaled by if it were already lit -- but the frames a carried light exists for
 * are the ones where the body is not: at midnight the moon leaves it a few
 * hundredths above black, and 1.6 times almost nothing is almost nothing. The
 * first build of this drew the player as a black cutout standing in a pool of
 * fire, which is the artifact the spec set out to remove, in a new shape.
 *
 * So the lift is spent as `albedo * (tint - 1)`: the light is *added* to the
 * body, and weighted by the body's own colour so a coat keeps its hue instead of
 * washing to the flame's. The same trick `highlight.ts` uses to brighten a
 * hovered unit without turning a tan cow pink.
 *
 * It goes in before tonemapping and the sRGB encode, so it is linear light being
 * added to linear light rather than a number added to a display value.
 */
function patchFragment(source: string): string {
  const lift =
    `\tgl_FragColor.rgb += diffuseColor.rgb * max( vec3( 0.0 ), ${TINT_UNIFORM} - vec3( 1.0 ) );`;
  return `uniform vec3 ${TINT_UNIFORM};\n${source}`
    .replace(LIGHTS_INCLUDE, unlitByPointLights())
    .replace(OUTPUT_INCLUDE, `${OUTPUT_INCLUDE}\n${lift}`);
}

/**
 * The stand-in a masked mesh hands the point-light shadow pass.
 *
 * `WebGLShadowMap.getDepthMaterial` reaches for `customDistanceMaterial` only
 * when the light is a point light, so this takes the player out of the torch's
 * cube map and out of nothing else -- `castShadow = false` would have taken the
 * sun's shadow with it, and that is the one that should stay. Writing neither
 * colour nor depth is what makes the draw contribute nothing; the shadow pass
 * overwrites `visible`, `side` and the alpha fields on whatever it is handed, so
 * those two are deliberately the only state this relies on.
 */
function makeNoPointShadow(): THREE.MeshDistanceMaterial {
  const material = new THREE.MeshDistanceMaterial();
  material.colorWrite = false;
  material.depthWrite = false;
  return material;
}

/** Only the lit materials take part; the unlit pieces are ground overlays. */
function isLit(material: THREE.Material): material is THREE.MeshLambertMaterial {
  return material instanceof THREE.MeshLambertMaterial;
}

export class PlayerLightMask {
  /**
   * Shared by every patched material by reference, so a frame's tint is one
   * write rather than one per material. `onBeforeCompile` hands this same object
   * to each program, which is what makes that true across recompiles too.
   */
  private readonly tint = { value: new THREE.Color(NO_TINT.r, NO_TINT.g, NO_TINT.b) };
  private readonly noPointShadow = makeNoPointShadow();

  private root: THREE.Object3D | null = null;
  /** The materials this mask has patched under the current root. */
  private patched = new Set<THREE.MeshLambertMaterial>();
  /** The meshes it has taken out of the point-light shadow pass. */
  private masked = new Set<THREE.Mesh>();
  private castsPointShadow = false;

  /**
   * Point the mask at the rig that is the local player now, restoring the one it
   * was on. A repeat call with the same root is the common case and does nothing
   * but the rescan below.
   */
  attach(root: THREE.Object3D | null): void {
    if (root === this.root) {
      this.scan();
      return;
    }
    this.release();
    this.root = root;
    this.scan();
  }

  /** Write the frame's brightening filter. One write, however many materials. */
  setTint(tint: LightTint): void {
    this.tint.value.setRGB(tint.r, tint.g, tint.b, THREE.LinearSRGBColorSpace);
  }

  /**
   * Whether the player is drawn into point-light shadow maps -- which is to say,
   * whether the torch throws their own silhouette across the ground they are
   * standing on. Off by default (spec 118).
   */
  setCastsPointShadow(on: boolean): void {
    if (on === this.castsPointShadow) return;
    this.castsPointShadow = on;
    for (const mesh of this.masked) this.applyShadowMask(mesh);
  }

  /** Put every material back and forget the rig. */
  release(): void {
    for (const material of this.patched) {
      // Back to the prototype's own empty hook, so the material's program cache
      // key -- which three derives from `onBeforeCompile.toString()` -- returns
      // to whatever an unpatched material of its kind has.
      Reflect.deleteProperty(material as object, 'onBeforeCompile');
      material.needsUpdate = true;
    }
    for (const mesh of this.masked) mesh.customDistanceMaterial = undefined;
    this.patched = new Set();
    this.masked = new Set();
    this.root = null;
  }

  /**
   * Find anything under the root that has appeared since the last look.
   *
   * Called every frame rather than once at attach time, because an authored
   * unit's mesh arrives from a `.glb` some frames after its body exists (spec
   * 111) -- a single scan would mask a group that is still empty. Sets are
   * checked before anything is written, so a settled rig costs one traverse.
   */
  private scan(): void {
    const root = this.root;
    if (!root) return;
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      if (!this.masked.has(node)) {
        this.masked.add(node);
        this.applyShadowMask(node);
      }
      const material = node.material;
      if (Array.isArray(material)) {
        for (const one of material) this.patch(one);
      } else {
        this.patch(material);
      }
    });
  }

  private applyShadowMask(mesh: THREE.Mesh): void {
    mesh.customDistanceMaterial = this.castsPointShadow ? undefined : this.noPointShadow;
  }

  private patch(material: THREE.Material): void {
    if (!isLit(material) || this.patched.has(material)) return;
    this.patched.add(material);
    material.onBeforeCompile = (shader) => {
      shader.uniforms[TINT_UNIFORM] = this.tint;
      shader.fragmentShader = patchFragment(shader.fragmentShader);
    };
    material.needsUpdate = true;
  }
}
