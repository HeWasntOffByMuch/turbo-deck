import * as THREE from 'three';
import { glslWindChunk, WATER } from './wind.js';
import { windTimeUniform } from './wind-uniforms.js';
import { shoreQuantum, type ShoreField } from './shore-sdf.js';

/**
 * The water surface (spec 074, part 2).
 *
 * A fragment shader on a flat opaque quad, and nothing else. No vertex
 * displacement, no transparency, no normal map, no reflection, no refraction,
 * no render target. Every one of those was tried by the thing this is imitating
 * and none of them is in it: the look is four colours with hard edges between
 * them, and each addition to that list is a way of softening an edge.
 *
 * ## Where the shape comes from
 *
 * The bands are steps on **horizontal distance to the shore**, streamed in as
 * an `R8` texture per chunk (`shore-sdf.ts`). The obvious alternative -- how
 * far the ground is below the water line -- gives a shallow band whose width is
 * set by the slope of the seabed, so it is fat across a beach and vanishes
 * entirely against a cliff. The reference keeps the same rim along a cliff face
 * as along a beach, and only a real distance field does that.
 *
 * That distance is then pushed in and out by a noise field and by a 4x4 Bayer
 * threshold. The noise makes the boundary breathe while the band keeps its
 * width; the dither is what stipples the boundary into the two-tone weave the
 * rest of the frame already has from the retro pass (spec 038).
 *
 * ## Where the movement comes from
 *
 * The squiggles on the surface are **isolines of a domain-warped noise field**,
 * not a scrolled texture. Warping is the whole difference: a field sampled at a
 * moving point slides past rigidly, and a field sampled at a point that is
 * *itself* drifting through a second field has isolines that pinch off, merge
 * and reconnect. Watch one loop for five seconds and it will have changed
 * topology, which a scroll can never do.
 *
 * The foam is a threshold on shore distance modulated by a sine travelling
 * along the coast, so it grows, dissolves and comes back rather than sitting
 * there as a rim.
 *
 * ## What it does not do
 *
 * Nothing view-dependent. The camera is fixed isometric, so fresnel and
 * reflection have one constant answer and that answer is already baked into the
 * four palette colours. Adding either would cost fill rate to reproduce a
 * number that is already in `WATER.deep`.
 */

const VERTEX_SHADER = /* glsl */ `
varying vec3 vWorld;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * The shore field is one texel per terrain cell, addressed from world XZ by
 * `uSdfOrigin` (the world position of texel centre 0,0) and `uSdfScale` (texels
 * per world unit). Sampled by *world* position rather than by a chunk-local UV,
 * because a UV means the noise restarts at every chunk boundary and every
 * boundary becomes a visible seam.
 */
const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uShoreField;
uniform vec2 uSdfOrigin;
uniform vec2 uSdfScale;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShallow;
uniform vec3 uFoam;

varying vec3 vWorld;

WIND_CHUNK

const float SHORE_RANGE = SHORE_RANGE_VALUE;

void main() {
  vec2 uv = (vWorld.xz - uSdfOrigin) * uSdfScale;
  float d = texture2D(uShoreField, uv).r * SHORE_RANGE;
  float f = warpedField(vWorld.xz, uWindTime);

  // The band threshold: distance from shore, wobbled by the field so the edge
  // breathes without the band changing width, then nudged by the ordered dither
  // so the boundary stipples instead of stepping cleanly.
  float b = d
          + (f - 0.5) * EDGE_WOBBLE
          + (bayer4(gl_FragCoord.xy) - 0.5) * EDGE_DITHER;

  vec3 col = uDeep;
  col = mix(col, uMid, step(b, MID_EDGE));
  col = mix(col, uShallow, step(b, SHALLOW_EDGE));

  // Isolines of the same field: a thin bright line wherever it crosses one of
  // a handful of evenly spaced levels. step(), never smoothstep() -- a soft
  // line here is the one thing that would give the whole surface away.
  float iso = step(abs(fract(f * ISO_LINES) - 0.5), ISO_WIDTH);
  col = mix(col, col * ISO_GAIN, iso);

  // Foam: a pulse travelling along the coast, clamped so a crest cannot reach
  // out past the shallow band and flood it.
  float wave = sin(uWindTime * FOAM_OMEGA - d * FOAM_TRAVEL + f * 4.0);
  col = mix(col, uFoam, step(d, FOAM_EDGE + wave * FOAM_SWING) * step(d, FOAM_LIMIT));

  // The same streak layer the ground carries, at the same speed and in the same
  // direction. This is the piece that makes the coastline read as one place.
  col *= windStreak(vWorld.xz, uWindTime);

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** Inline a float as a GLSL literal at full precision. */
function f(value: number): string {
  return value.toFixed(6);
}

/**
 * The art direction, as GLSL literals. Substituted in rather than declared as
 * uniforms: they are baked at build time, and the only thing that changes per
 * frame is the clock.
 */
const CONSTANTS: Readonly<Record<string, string>> = {
  SHORE_RANGE_VALUE: f(WATER.shoreRange),
  EDGE_WOBBLE: f(WATER.edgeWobble),
  EDGE_DITHER: f(WATER.edgeDither),
  MID_EDGE: f(WATER.midEdge),
  SHALLOW_EDGE: f(WATER.shallowEdge),
  ISO_LINES: f(WATER.isoLines),
  ISO_WIDTH: f(WATER.isoWidth),
  ISO_GAIN: f(WATER.isoGain),
  FOAM_OMEGA: f(WATER.foamOmega),
  FOAM_TRAVEL: f(WATER.foamTravel),
  FOAM_EDGE: f(WATER.foamEdge),
  FOAM_SWING: f(WATER.foamSwing),
  FOAM_LIMIT: f(WATER.foamLimit),
};

/**
 * The fragment shader with every constant substituted in.
 *
 * One whole-word pass over the source rather than a chain of `replace` calls.
 * A chain looks equivalent and is not: `String.replace` with a string pattern
 * substitutes the *first* occurrence only, so a constant used twice compiled
 * with the second use left as an undeclared identifier -- and since this is a
 * string until a GPU sees it, nothing in the type system or the test suite had
 * an opinion about that. Whole-word so a token can never eat a longer one it is
 * a prefix of.
 */
export function waterFragmentShader(): string {
  const tokens = new RegExp(`\\b(${Object.keys(CONSTANTS).join('|')})\\b`, 'g');
  return FRAGMENT_SHADER.replace('WIND_CHUNK', glslWindChunk()).replace(
    tokens,
    (token) => CONSTANTS[token] ?? token,
  );
}

/**
 * The four colours, in the renderer's working space. Shared by every chunk's
 * material: there is one palette, and a chunk cannot have its own.
 */
const PALETTE_UNIFORMS = {
  uDeep: { value: new THREE.Color(WATER.deep) },
  uMid: { value: new THREE.Color(WATER.mid) },
  uShallow: { value: new THREE.Color(WATER.shallow) },
  uFoam: { value: new THREE.Color(WATER.foam) },
};

export interface WaterQuadOptions {
  /** World rectangle the chunk's cells cover. */
  readonly originX: number;
  readonly originZ: number;
  readonly width: number;
  readonly depth: number;
  readonly waterLevel: number;
  readonly field: ShoreField;
  readonly cellSize: number;
}

/**
 * One chunk's water: a two-triangle quad at the layer's flood level, with its
 * own shore field bound to it.
 *
 * Opaque and depth-tested, drawn in the ordinary pass with no blending and no
 * sorting -- which is also what shapes the coastline for free, since every
 * scrap of land is above the water line and simply occludes the quad.
 *
 * Each chunk needs its own material because each chunk has its own shore
 * texture, but the palette and the clock are shared *by reference*, so there is
 * still exactly one place either can be changed and one compiled program behind
 * all of them.
 */
export function buildWaterQuad(opt: WaterQuadOptions): THREE.Mesh {
  const texture = new THREE.DataTexture(
    opt.field.data,
    opt.field.cols,
    opt.field.rows,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  // Linear, so the band edge follows a smooth contour rather than staircasing
  // along the cell grid; clamped, so a fragment a hair outside the quad reads
  // the edge texel instead of wrapping to the far side of the chunk.
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: waterFragmentShader(),
    uniforms: {
      // By reference, not by value: one clock and one palette for the whole
      // world, however many chunks are on screen.
      uWindTime: windTimeUniform,
      ...PALETTE_UNIFORMS,
      uShoreField: { value: texture },
      // World XZ -> [0, 1] over the chunk's cells. Texel i covers cell i
      // exactly, so its centre lands on (i + 0.5) / cols and the linear filter
      // interpolates between cell centres rather than across cell edges.
      uSdfOrigin: { value: new THREE.Vector2(opt.originX, opt.originZ) },
      uSdfScale: {
        value: new THREE.Vector2(1 / (opt.field.cols * opt.cellSize), 1 / (opt.field.rows * opt.cellSize)),
      },
    },
    transparent: false,
    depthWrite: true,
  });

  const geometry = new THREE.PlaneGeometry(opt.width, opt.depth);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(opt.originX + opt.width / 2, opt.waterLevel, opt.originZ + opt.depth / 2);
  // Water neither takes the sun's shade nor throws any: a shadow on a flat
  // stylized surface reads as dirt floating on it.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/** Free a water quad's geometry, material and shore texture. */
export function disposeWaterQuad(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  const material = mesh.material as THREE.ShaderMaterial;
  (material.uniforms['uShoreField']?.value as THREE.Texture | undefined)?.dispose();
  material.dispose();
}

/** How much of a world unit one step of the packed shore byte is worth. */
export const SHORE_QUANTUM = shoreQuantum(WATER.shoreRange);
