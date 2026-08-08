import * as THREE from 'three';
import { glslWindChunk, maxTipDisplacement, WIND, WIND_LIMITS, WIND_MAX } from './wind.js';
import { WIND_UNIFORMS } from './wind-uniforms.js';
import { glslBendNormalChunk } from './shading.js';
import { makeNormalMaterial, setNormalMaterial } from './hike-buffers.js';

/**
 * Tree sway, as a patch on the materials the prop field already uses (spec 074).
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
 * ## Why the patch splices into two of three.js's own chunks
 *
 * The displacement has to be applied to the vertex *after* `instanceMatrix` and
 * *before* `modelViewMatrix` / `modelMatrix`, because the arc is about a point
 * in world space and the instance transform is what puts the vertex there.
 * three.js applies the instance matrix in two chunks -- `project_vertex` for
 * what is drawn and `worldpos_vertex` for what shadows are measured against --
 * and both do it on one line each, so the patch is one line spliced after each.
 *
 * The chunks are expanded here rather than matched in place, because
 * `onBeforeCompile` hands over the shader with its `#include` directives *still
 * unresolved* -- three.js expands them afterwards. A patch that looks for the
 * chunk's contents therefore matches nothing, changes nothing, and compiles and
 * links perfectly: the trees simply do not move, with no error anywhere. That
 * is exactly what happened, and it is why {@link SPLICES} is verified at module
 * load rather than trusted.
 *
 * This assumes the batches' own `modelMatrix` is identity -- that the prop
 * field's group sits at the origin unrotated, so that "after `instanceMatrix`"
 * already *is* world space. It does, and `sway.test.ts` holds it to that.
 */

const INSTANCE_LINE_VIEW = 'mvPosition = instanceMatrix * mvPosition;';
const INSTANCE_LINE_WORLD = 'worldPosition = instanceMatrix * worldPosition;';
/**
 * Where the normal is still in world space: after the instance rotation has been
 * applied to it and before `normalMatrix` takes it into view space -- the exact
 * counterpart of the two position lines above, and the only point at which a
 * rotation expressed in world-space wind direction means anything.
 */
const INSTANCE_LINE_NORMAL = 'transformedNormal = im * transformedNormal;';

/** Declarations and the bend itself, injected at the top of the vertex shader. */
const SWAY_PROLOGUE = /* glsl */ `
attribute float aBend;
attribute vec3 aWindBase;
attribute vec2 aWindTune;

uniform float uSwayLag;
uniform float uSwayTilt;

${glslWindChunk()}
${glslBendNormalChunk()}

// Swing a point about a base, by an angle, downwind. An arc, not a slide: the
// point keeps its height above the base exactly, so a leaning trunk is the same
// length as an upright one.
vec3 swingAbout(vec3 p, vec3 base, float angle) {
  vec3 rel = p - base;
  float h = rel.y;
  rel.xz += uWindDir * (h * sin(angle));
  rel.y = h * cos(angle);
  return base + rel;
}

// Swing a world-space vertex about its tree's base.
//
// aWindTune.x is the tree's stiffness and aWindTune.y a per-tree offset into
// the clock, hashed from where it stands: the travelling wave already puts
// neighbours out of step, and this stops two trees the wave happens to reach
// together from beating in exact unison for the rest of the session.
//
// This vertex's bend angle. Split out of windBend so the normal rotation can be
// driven by exactly the same number rather than by a second copy of it.
float windBendAngle() {
  float w = clamp(aBend, 0.0, 1.0);
  float gust = windAt(aWindBase.xz, uWindTime + aWindTune.y - uSwayLag);
  return uWindStrength * gust * aWindTune.x * w * w;
}

// uSwayLag and uSwayTilt are this *batch's* -- one part of one species -- and
// are both zero for every batch that existed before spec 077, so the conifers
// take exactly the path they always did.
vec3 windBend(vec3 worldPos) {
  float angle = windBendAngle();
  vec3 bent = swingAbout(worldPos, aWindBase, angle);
  if (uSwayTilt == 0.0) return bent;

  // A flat canopy slab is the one shape the swing above does nothing to. Every
  // vertex of it carries the same bend weight and sits at the same height over
  // the tree's base, so the arc moves the whole plate rigidly and leaves it
  // exactly as horizontal as it started, while the trunk under it leans away.
  //
  // So tilt it about its own origin as well. The pivot is recovered from the
  // instance transform rather than baked as an attribute: the part's offset up
  // and off the trunk is applied as the instance's *translation*, so the part's
  // origin in world space is simply where instanceMatrix sends (0, 0, 0). It has
  // to be swung by the trunk first, or the slab would hinge about the point the
  // branch used to be at rather than where it now is.
  vec3 hinge = swingAbout((instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz, aWindBase, angle);
  // A true rotation in the (downwind, up) plane, unlike the swing above: the
  // downwind edge of the slab drops and the upwind edge lifts, which is how a
  // plate on a bending stem reads. Whatever is across the wind is untouched.
  return hinge + rotateAboutWind(bent - hinge, angle * uSwayTilt);
}

// The normal that goes with the bend above (spec 093).
//
// Both the swing and the slab's tilt are rotations in the same (downwind, up)
// plane, so the two compose by adding their angles -- which is why one rotation
// by angle * (1 + uSwayTilt) carries the normal through both of them.
//
// Inert unless normals are interpolated: under flatShading three.js re-derives
// the face normal per fragment from the displaced position and never reads
// vNormal at all. See bendNormal in shading.ts for the approximation this makes
// on a trunk, where the bend is not rigid.
vec3 windBendNormal(vec3 n) {
  return rotateAboutWind(n, windBendAngle() * (1.0 + uSwayTilt));
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
 * How one batch reads the wind differently from the trunk it hangs off
 * (spec 077). All-zero is the behaviour every batch had before it existed.
 */
export interface SwayLag {
  /**
   * Seconds this batch reads the shared clock behind the tree's own phase. What
   * makes a canopy trail the trunk rather than tick with it.
   */
  readonly lag?: number;
  /**
   * Extra rotation about the *part's* own origin, as a multiple of the trunk's
   * bend angle at that height. Zero leaves the part riding the trunk's arc
   * rigidly, which for anything but a flat plate is what you want.
   */
  readonly tilt?: number;
  /**
   * How far this part's geometry stands from its own origin, in world units at
   * the largest instance in the batch. Only the bounding sphere reads it: a tilt
   * lifts a rim by `reach * sin(angle)`, and a sphere sized for the lean alone
   * would take the whole batch off screen the moment that edge left it.
   */
  readonly reach?: number;
}

/**
 * Attach the per-tree attributes, patch the material (and the two shadow
 * materials three.js will render this batch with), and grow the bounding sphere
 * by however far a crown can lean out of it.
 *
 * The geometry must already carry `aBend`; a batch whose geometry does not is
 * left alone rather than patched into something that will not link.
 */
export function applySway(
  mesh: THREE.InstancedMesh,
  instances: readonly SwayInstance[],
  height: number,
  trail: SwayLag = {},
  /**
   * Rotate the vertex normal along with the vertex (spec 093). Off by default,
   * because it does nothing at all while the batch is flat-shaded and three.js
   * is deriving face normals from the displaced position anyway.
   */
  bendNormals = false,
): void {
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

  const lag = trail.lag ?? 0;
  const tilt = trail.tilt ?? 0;
  patchMaterial(mesh.material as THREE.Material, lag, tilt, bendNormals);

  // The shadow passes use their own materials, so they need their own copies of
  // the same patch or the shade under a grove stays rigid while the grove moves.
  // They are handed `false`: a depth pass has no use for a normal, and splicing
  // one in would only cost them a second compiled program.
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  patchMaterial(depth, lag, tilt, false);
  mesh.customDepthMaterial = depth;
  // The player's torch is a point light that casts (spec 047), and a point
  // light's shadow is a distance cube rendered with a third material again.
  const distance = new THREE.MeshDistanceMaterial();
  patchMaterial(distance, lag, tilt, false);
  mesh.customDistanceMaterial = distance;

  // And a fourth copy for the depth/normal buffers (spec 096). Same reasoning as
  // the shadow materials one line up: that pass renders with a material of its
  // own, and a batch whose visible geometry leans while its normal buffer stands
  // upright would have its outline drawn where the tree used to be.
  //
  // This one *does* want the normal splice, whatever the caller asked for the
  // visible material: the buffer's whole content is normals, so a bent position
  // with an unbent normal is the one combination that is never right here.
  const visible = mesh.material as THREE.MeshLambertMaterial;
  const buffers = makeNormalMaterial(visible.flatShading === true, visible.side);
  patchMaterial(buffers, lag, tilt, true);
  setNormalMaterial(mesh, buffers);

  // A crown that leans out of its batch's bounding sphere would take the whole
  // batch off screen with it the moment the sphere left the frustum -- trees
  // popping out at the edge of the view, which is the classic tell.
  //
  // Sized against the *strongest* wind the weather panel can ask for (spec 075),
  // not against the default: the bounds are written once at build time and the
  // slider moves afterwards.
  mesh.computeBoundingSphere();
  if (mesh.boundingSphere) {
    mesh.boundingSphere.radius +=
      maxTipDisplacement(WIND, height, WIND_LIMITS.maxStrength) + tiltReach(tilt, trail.reach ?? 0);
  }
}

/**
 * How far the tilt alone can throw a vertex `reach` from its part's origin, at
 * the strongest wind the weather panel allows (spec 075) -- measured the same way
 * and against the same limit as the lean it is added to.
 */
export function tiltReach(tilt: number, reach: number): number {
  if (tilt === 0 || reach === 0) return 0;
  return reach * Math.abs(Math.sin(WIND.strength * WIND_LIMITS.maxStrength * WIND_MAX * tilt));
}

/**
 * three.js's own chunks with the bend spliced in, expanded once at module load.
 *
 * Built by name so a three.js upgrade that reworks either chunk shows up as the
 * error below rather than as trees that quietly stop moving.
 */
export const SPLICES: readonly { readonly include: string; readonly source: string }[] = [
  {
    include: '#include <project_vertex>',
    source: (THREE.ShaderChunk['project_vertex'] ?? '').replace(
      INSTANCE_LINE_VIEW,
      `${INSTANCE_LINE_VIEW}\n\t\tmvPosition.xyz = windBend( mvPosition.xyz );`,
    ),
  },
  {
    include: '#include <worldpos_vertex>',
    source: (THREE.ShaderChunk['worldpos_vertex'] ?? '').replace(
      INSTANCE_LINE_WORLD,
      `${INSTANCE_LINE_WORLD}\n\t\tworldPosition.xyz = windBend( worldPosition.xyz );`,
    ),
  },
];

/**
 * The normal's splice, kept apart from the three above because it is applied
 * only when asked for (spec 093, step 2).
 *
 * Separate rather than always-on so the difference can be seen: with normals
 * interpolated and this left off, a leaning canopy is lit as though it were
 * still standing up, which is the artefact worth being able to look at rather
 * than take on trust.
 */
export const NORMAL_SPLICE: { readonly include: string; readonly source: string } = {
  include: '#include <defaultnormal_vertex>',
  source: (THREE.ShaderChunk['defaultnormal_vertex'] ?? '').replace(
    INSTANCE_LINE_NORMAL,
    `${INSTANCE_LINE_NORMAL}\n\t\ttransformedNormal = windBendNormal( transformedNormal );`,
  ),
};

for (const splice of [...SPLICES, NORMAL_SPLICE]) {
  if (!splice.source.includes('windBend')) {
    // Loud, because the alternative is silence: a splice that matched nothing
    // still compiles, still links, and draws a forest that does not move.
    throw new Error(`sway: nothing to splice in ${splice.include} -- has three.js changed the chunk?`);
  }
}

/**
 * Splice the bend into a material's vertex shader. Idempotent per material.
 *
 * `lag` and `tilt` become uniforms of this material alone, never of the shared
 * {@link WIND_UNIFORMS} set: they are a property of *which part of which tree*
 * this batch draws, and the shared objects are the weather, which every batch
 * must agree on to the reference. The generated source is the same either way,
 * so the program cache key stays one key and a lobed slab and a fir's trunk
 * still share a compiled program.
 */
function patchMaterial(material: THREE.Material, lag: number, tilt: number, normals: boolean): void {
  material.onBeforeCompile = (shader): void => {
    Object.assign(shader.uniforms, WIND_UNIFORMS, {
      uSwayLag: { value: lag },
      uSwayTilt: { value: tilt },
    });
    let vertex = shader.vertexShader.replace('#include <common>', `#include <common>\n${SWAY_PROLOGUE}`);
    const splices = normals ? [...SPLICES, NORMAL_SPLICE] : SPLICES;
    for (const splice of splices) vertex = vertex.replace(splice.include, splice.source);
    shader.vertexShader = vertex;
  };
  // Materials are keyed by this when three.js decides whether two of them can
  // share a compiled program. Without it a patched and an unpatched Lambert
  // look identical to the cache and one of them gets the other's shader -- and
  // for the same reason the key has to name *which* patch, or a batch built with
  // the normal splice and one built without would share whichever program was
  // compiled first.
  material.customProgramCacheKey = (): string => (normals ? 'wind-sway-normals' : 'wind-sway');
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
  (mesh.userData['hikeNormalMaterial'] as THREE.Material | undefined)?.dispose();
}
