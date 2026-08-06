import * as THREE from 'three';
import { glslWindChunk, maxTipDisplacement, WIND } from './wind.js';
import { windTimeUniform } from './wind-uniforms.js';

/**
 * Tree sway, as a patch on the materials the prop field already uses (spec 073).
 *
 * Entirely in the vertex shader. Nothing here runs per frame: the instance
 * matrices are still written once and never touched again, and the only thing
 * that changes between frames is the shared `uWindTime` float.
 *
 * ## The three things that are easy to get wrong
 *
 * **Sample the wind once per tree, not per vertex.** A canopy where every
 * vertex evaluated the field at its own position does not lean, it *shears*:
 * the upwind side of a crown and the downwind side get different answers and
 * the cone tears sideways off its trunk. So the wind is sampled at
 * `aWindBase.xz` -- an *instanced* attribute, one value for the whole tree, and
 * the same value for the trunk batch and every cone batch above it, because
 * they all write the same tree's ground point.
 *
 * **Bend as an arc about the base, not a translation.** Sliding the crown
 * downwind stretches the trunk visibly, because the trunk's top moves and its
 * bottom does not. Rotating about the base -- `x += h sin a`, `y = h cos a` --
 * keeps every vertex exactly as far from the base as it started.
 *
 * **Patch the depth and distance materials too.** The sun's shadow map and the
 * torch's cube map are rendered with different materials from the ones on
 * screen. Bend only the visible geometry and the trees dance over shadows that
 * stand perfectly still, which reads worse than no sway at all.
 *
 * ## Why the patch is two string replacements
 *
 * The displacement has to be applied to the vertex *after* `instanceMatrix` and
 * *before* `modelViewMatrix` / `modelMatrix`, because the arc is about a point
 * in world space and the instance transform is what puts the vertex there.
 * three.js applies the instance matrix in two chunks -- `project_vertex` for
 * what is drawn and `worldpos_vertex` for what shadows are measured against --
 * and both do it on one line each. Splicing after those two lines is far less
 * brittle than replacing either chunk wholesale, and it keeps the two agreeing
 * by construction.
 *
 * This assumes the batches' own `modelMatrix` is identity -- that the prop
 * field's group sits at the origin unrotated, so that "after `instanceMatrix`"
 * already *is* world space. It does, and `props.test.ts` holds it to that.
 */

const INSTANCE_LINE_VIEW = 'mvPosition = instanceMatrix * mvPosition;';
const INSTANCE_LINE_WORLD = 'worldPosition = instanceMatrix * worldPosition;';

/** Declarations and the bend itself, injected at the top of the vertex shader. */
const SWAY_PROLOGUE = /* glsl */ `
attribute float aBend;
attribute vec3 aWindBase;
attribute vec2 aWindTune;

${glslWindChunk()}

// Swing a world-space vertex about its tree's base.
//
// aWindTune.x is the tree's stiffness and aWindTune.y a per-tree offset into
// the clock, hashed from where it stands: the travelling wave already puts
// neighbours out of step, and this stops two trees the wave happens to reach
// together from beating in exact unison for the rest of the session.
vec3 windBend(vec3 worldPos) {
  float w = clamp(aBend, 0.0, 1.0);
  float gust = windAt(aWindBase.xz, uWindTime + aWindTune.y);
  float angle = WIND_STRENGTH * gust * aWindTune.x * w * w;
  vec3 rel = worldPos - aWindBase;
  float h = rel.y;
  // An arc, not a slide: the vertex keeps its distance from the base exactly,
  // so a leaning trunk is the same length as an upright one.
  rel.xz += WIND_DIR * (h * sin(angle));
  rel.y = h * cos(angle);
  return aWindBase + rel;
}
`;

/**
 * The bend weight for one vertex: 0 where the tree meets the ground, 1 at the
 * highest point its species reaches.
 *
 * Baked at generation from the part's own local Y plus where the part sits on
 * the tree, and **scale-free** -- the offset, the local coordinate and the
 * species height all scale with the prop together, so one baked attribute
 * serves a sapling and a full-grown spire out of the same geometry.
 */
export function bendWeight(localY: number, partOffsetY: number, speciesHeight: number): number {
  if (speciesHeight <= 0) return 0;
  return Math.min(1, Math.max(0, (partOffsetY + localY) / speciesHeight));
}

/**
 * Bake `aBend` onto a part's geometry. Called once per geometry at build time;
 * nothing recomputes it afterwards.
 */
export function bakeBend(geometry: THREE.BufferGeometry, partOffsetY: number, speciesHeight: number): void {
  const position = geometry.getAttribute('position');
  const bend = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    bend[i] = bendWeight(position.getY(i), partOffsetY, speciesHeight);
  }
  geometry.setAttribute('aBend', new THREE.BufferAttribute(bend, 1));
}

/** One tree's contribution to the instanced attributes a swaying batch needs. */
export interface SwayInstance {
  /** The tree's ground point, in world space. */
  readonly baseX: number;
  readonly baseY: number;
  readonly baseZ: number;
  /** `1 / (1 + trunkRadius / height)` -- thick trunks move less. */
  readonly stiffness: number;
  /** Seconds of offset into the shared clock, hashed from where it stands. */
  readonly phase: number;
}

/**
 * Attach the per-tree attributes, patch the material (and the two shadow
 * materials three.js will render this batch with), and grow the bounding sphere
 * by however far a crown can lean out of it.
 *
 * The geometry must already carry `aBend`; a batch whose geometry does not is
 * left alone rather than patched into something that will not link.
 */
export function applySway(mesh: THREE.InstancedMesh, instances: readonly SwayInstance[], height: number): void {
  if (!mesh.geometry.getAttribute('aBend')) return;

  const base = new Float32Array(instances.length * 3);
  const tune = new Float32Array(instances.length * 2);
  instances.forEach((instance, i) => {
    base[i * 3] = instance.baseX;
    base[i * 3 + 1] = instance.baseY;
    base[i * 3 + 2] = instance.baseZ;
    tune[i * 2] = instance.stiffness;
    tune[i * 2 + 1] = instance.phase;
  });
  mesh.geometry.setAttribute('aWindBase', new THREE.InstancedBufferAttribute(base, 3));
  mesh.geometry.setAttribute('aWindTune', new THREE.InstancedBufferAttribute(tune, 2));

  patchMaterial(mesh.material as THREE.Material);

  // The shadow passes use their own materials, so they need their own copies of
  // the same patch or the shade under a grove stays rigid while the grove moves.
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  patchMaterial(depth);
  mesh.customDepthMaterial = depth;
  // The player's torch is a point light that casts (spec 047), and a point
  // light's shadow is a distance cube rendered with a third material again.
  const distance = new THREE.MeshDistanceMaterial();
  patchMaterial(distance);
  mesh.customDistanceMaterial = distance;

  // A crown that leans out of its batch's bounding sphere would take the whole
  // batch off screen with it the moment the sphere left the frustum -- trees
  // popping out at the edge of the view, which is the classic tell.
  mesh.computeBoundingSphere();
  if (mesh.boundingSphere) mesh.boundingSphere.radius += maxTipDisplacement(WIND, height);
}

/** Splice the bend into a material's vertex shader. Idempotent per material. */
function patchMaterial(material: THREE.Material): void {
  material.onBeforeCompile = (shader): void => {
    shader.uniforms['uWindTime'] = windTimeUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SWAY_PROLOGUE}`)
      .replace(INSTANCE_LINE_VIEW, `${INSTANCE_LINE_VIEW}\n\t\tmvPosition.xyz = windBend( mvPosition.xyz );`)
      .replace(INSTANCE_LINE_WORLD, `${INSTANCE_LINE_WORLD}\n\t\tworldPosition.xyz = windBend( worldPosition.xyz );`);
  };
  // Materials are keyed by this when three.js decides whether two of them can
  // share a compiled program. Without it a patched and an unpatched Lambert
  // look identical to the cache and one of them gets the other's shader.
  material.customProgramCacheKey = (): string => 'wind-sway';
  material.needsUpdate = true;
}

/**
 * Undo what {@link applySway} attached, for a batch being disposed. The
 * geometry and the material itself belong to the caller; only the two shadow
 * materials were created here.
 */
export function disposeSway(mesh: THREE.InstancedMesh): void {
  mesh.customDepthMaterial?.dispose();
  mesh.customDistanceMaterial?.dispose();
}
