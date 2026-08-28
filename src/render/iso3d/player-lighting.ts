import * as THREE from 'three';
import { APPARENT_LIGHT_FRACTION } from './player-lights.js';

/**
 * The local player, lit by the lights they carry as though those lights were
 * farther away than they are (spec 118).
 *
 * The three.js half of `player-lights.ts`, and the only place in the renderer
 * that edits a shader string. It attaches to whichever rig is the local player
 * and does two things:
 *
 * - **Re-sites the point lights**, for that rig's materials only. Each one is
 *   pushed out along the true direction from the body to it, to
 *   `apparentLightDistance` of its own range. Colour, decay, the range window,
 *   the flicker and the shadow lookup all run unmodified against the result.
 * - **Keeps the body out of point-light shadow maps**, optionally, so the
 *   player's own silhouette does not swing across their feet as the flame
 *   gutters.
 *
 * ## Why the light is moved rather than dimmed
 *
 * A torch 26 units from a 46-unit body is wrong in two ways at once, and only
 * one of them is brightness. `1/d²` puts several times more light on the chest
 * than on the far hip, *and* the vector to the flame points sharply up at the
 * feet and sharply down at the head. Turning it down fixes neither: the hot spot
 * and the fan are both functions of how much of the distance the body spans.
 * Moving where it is measured from fixes both, and costs the figure nothing --
 * it still has a lit side, a shaded side, and both still turn as the player does.
 *
 * ## Why a shader patch
 *
 * `Object3D.layers` looks like the answer and is not: three 0.160 tests a
 * light's layers against the **camera** (`WebGLRenderer.projectObject`), never
 * against the object being lit, so there is no per-object light state to reach
 * for -- and a second, dimmer light for the player alone would land on
 * everything else for the same reason. What is left is rewriting the loop that
 * reads the point lights. `pointLight` is a local copy in that loop, so moving
 * its `position` before `getPointLightInfo` reads it is the whole change. The
 * marker being replaced is asserted by a test, so a three.js upgrade that
 * renames it fails in Node rather than quietly shipping a player lit from point
 * blank again.
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

/** The uniform naming the body's middle, in view space. Prefixed so nothing collides. */
const ANCHOR_UNIFORM = 'turboBodyAnchor';

/**
 * The line in `lights_fragment_begin` that reads one point light. Everything
 * this module does happens in the statement before it.
 */
const POINT_LIGHT_CALL = 'getPointLightInfo( pointLight, geometryPosition, directLight );';

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
 * Whether three still unrolls the point-light loop.
 *
 * Exported for the test, because the unroll is *why* the injection is a block
 * and a version of three that stopped unrolling would make that reason
 * disappear without anything failing. Worth pinning either way: this is the one
 * fact about three's own shader that decides whether the patch compiles at all.
 */
export function pointLoopIsUnrolled(): boolean {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  const at = chunk.indexOf(POINT_LIGHT_CALL);
  return at >= 0 && chunk.lastIndexOf('#pragma unroll_loop_start', at) >= 0;
}

/**
 * The patched point-light statement, for the test.
 *
 * Answers the substituted text rather than the whole chunk, so an assertion
 * about *its* bracing is about the thing that gets repeated rather than about
 * three's file.
 */
export function pointLightInjection(): string {
  const patched = heldAtArmsLength();
  const start = patched.indexOf('\t\t{');
  const end = patched.indexOf(POINT_LIGHT_CALL, start);
  return start < 0 || end < 0 ? '' : patched.slice(start, patched.indexOf('}', end + POINT_LIGHT_CALL.length) + 1);
}

/**
 * `lights_fragment_begin`, with the light held at arm's length before it is read.
 *
 * Built from three's own chunk rather than from a copy of it, so everything else
 * it does -- the directional lights, the hemisphere fill, the shadow terms --
 * stays whatever the installed three.js says it is.
 *
 * Four details worth keeping straight:
 *
 * - Everything here is **view space**, which is where `pointLight.position` and
 *   `geometryPosition` already live, so the anchor is handed in that way too.
 * - The distance is measured from the one anchor rather than per fragment. Per
 *   fragment would put the apparent light somewhere slightly different for every
 *   pixel, which is the fan being removed.
 * - `max` against the true distance, so a light that is already further off than
 *   this is left exactly where it is rather than dragged in.
 * - **The whole thing is one block**, and that is not style. three's point-light
 *   loop is `#pragma unroll_loop_start`, so the body is emitted once per light
 *   *at the same scope* -- with two lights, two `vec3 turboToLight` declarations
 *   land side by side and the shader fails to compile with
 *   `'turboToLight' : redefinition`. The material then never builds and the
 *   player is drawn unlit.
 *
 *   It was invisible for a hundred and thirty specs because there was exactly
 *   one point light in this game -- the panel torch -- so the loop unrolled to
 *   one copy. Spec 248's pool of six is what found it, and it took a browser:
 *   the failure is a GLSL compile error, and three logs one and carries on
 *   (`shading-probe.ts` says so in as many words), so every test in the tree
 *   stayed green.
 */
function heldAtArmsLength(): string {
  // Term for term `carriedLightDistance` composed with `apparentLightDistance`:
  //   max( trueDistance, max( 1, range * APPARENT_LIGHT_FRACTION ) )
  // The TypeScript is the version a test can execute; this is the transcription.
  //
  // The call is *inside* the block with them: `pointLight` and `directLight` are
  // the loop's own outer-scope variables, so moving the light and then reading
  // it has to happen before the brace closes.
  const injection = [
    '\t\t{',
    `\t\t\tvec3 turboToLight = pointLight.position - ${ANCHOR_UNIFORM};`,
    '\t\t\tfloat turboTrue = length( turboToLight );',
    '\t\t\tif ( turboTrue > 0.0001 ) {',
    `\t\t\t\tfloat turboApparent = max( 1.0, pointLight.distance * ${APPARENT_LIGHT_FRACTION.toFixed(4)} );`,
    '\t\t\t\tfloat turboHeld = max( turboTrue, turboApparent );',
    `\t\t\t\tpointLight.position = ${ANCHOR_UNIFORM} + ( turboToLight / turboTrue ) * turboHeld;`,
    '\t\t\t}',
    `\t\t\t${POINT_LIGHT_CALL}`,
    '\t\t}',
  ].join('\n');
  return THREE.ShaderChunk.lights_fragment_begin.replace(POINT_LIGHT_CALL, injection);
}

function patchFragment(source: string): string {
  return `uniform vec3 ${ANCHOR_UNIFORM};\n${source}`.replace(LIGHTS_INCLUDE, heldAtArmsLength());
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

export class PlayerLighting {
  /**
   * Shared by every patched material by reference, so a frame's anchor is one
   * write rather than one per material. `onBeforeCompile` hands this same object
   * to each program, which is what makes that true across recompiles too.
   */
  private readonly anchor = { value: new THREE.Vector3() };
  private readonly noPointShadow = makeNoPointShadow();

  private root: THREE.Object3D | null = null;
  /** The materials this has patched under the current root. */
  private patched = new Set<THREE.MeshLambertMaterial>();
  /** The meshes it has taken out of the point-light shadow pass. */
  private masked = new Set<THREE.Mesh>();
  private castsPointShadow = false;

  /**
   * Point at the rig that is the local player now, restoring the one it was on.
   * A repeat call with the same root is the common case and does nothing but the
   * rescan below.
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

  /**
   * Where the lights are measured from: the middle of the body, in **view
   * space** -- the space `pointLight.position` is already in by the time a
   * fragment shader sees it. One write, however many materials.
   */
  setAnchor(x: number, y: number, z: number): void {
    this.anchor.value.set(x, y, z);
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
   * 111) -- a single scan would patch a group that is still empty. Sets are
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
      shader.uniforms[ANCHOR_UNIFORM] = this.anchor;
      shader.fragmentShader = patchFragment(shader.fragmentShader);
    };
    material.needsUpdate = true;
  }
}
