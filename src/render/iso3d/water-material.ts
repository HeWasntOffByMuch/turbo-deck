import * as THREE from 'three';
import { glslWindChunk, WATER } from './wind.js';
import { WIND_UNIFORMS } from './wind-uniforms.js';
import { FIXED_DAYLIGHT } from './daynight.js';
import { unpackLinear } from './hike.js';
import { horizonShadow, shadowFillBoost } from './shadow.js';
import { DEFAULT_LIGHT_OFFSET } from './view-settings.js';
import { shoreQuantum, type ShoreField } from './shore-sdf.js';

/**
 * The water surface (spec 074, part 2).
 *
 * A flat opaque quad with a fragment patch on it, and nothing else. No vertex
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
 * ## Where the light comes from (spec 259)
 *
 * From three, like everything else. This was a standalone `ShaderMaterial`
 * writing its palette straight to `gl_FragColor` with no light uniform in it at
 * all, which made the sea the one surface in the frame that was not lit: the
 * ground followed the day/night ramp and the water sat on a permanent noon,
 * drawn at full daylight brightness against land at a twelfth of it, and picking
 * up none of spec 250's campfires either.
 *
 * So the bands are computed into `diffuseColor` on a `MeshLambertMaterial`
 * instead, in the register `patchTerrainStreak` and its three neighbours
 * already use on the ground. The point of that is not the mechanism, it is that
 * afterwards there is **one description of how bright it is right now** and
 * neither surface is deciding -- so the sea cannot drift from the land again.
 *
 * What it costs is one sentence in the other direction: the four palette hexes
 * stop being output colour and become albedo, divided once by the light they
 * were authored under. See {@link REFERENCE_IRRADIANCE}.
 *
 * ## What it does not do
 *
 * Nothing view-dependent. The camera is fixed isometric, so fresnel and
 * reflection have one constant answer and that answer is already baked into the
 * four palette colours. Adding either would cost fill rate to reproduce a
 * number that is already in `WATER.deep`.
 */

/**
 * The irradiance a flat, up-facing surface receives under one key light and one
 * ambient fill, per **linear** channel -- `ambient + key * dot(up, L)`, which is
 * what three's `lights_fragment_begin` sums for a normal pointing straight up.
 *
 * Linear because that is the space three does the arithmetic in and where
 * `new THREE.Color(hex)` has already put every palette constant in this
 * renderer; the sRGB bytes a colour is authored as are a display encoding and
 * multiplying light by them means nothing.
 */
function flatIrradiance(light: {
  readonly ambientHex: number;
  readonly ambientIntensity: number;
  readonly keyHex: number;
  readonly keyIntensity: number;
  readonly dotNL: number;
}): readonly [number, number, number] {
  const ambient = unpackLinear(light.ambientHex);
  const key = unpackLinear(light.keyHex);
  const direct = light.keyIntensity * Math.max(0, light.dotNL);
  return [0, 1, 2].map(
    (i) => (ambient[i] as number) * light.ambientIntensity + (key[i] as number) * direct,
  ) as unknown as readonly [number, number, number];
}

/**
 * The light the water's palette was authored under: `DEFAULT_LIGHT_OFFSET` at
 * `FIXED_DAYLIGHT`, which is the frame the game opens on, since the day/night
 * cycle ships switched off.
 *
 * The ramp's **noon** is the wrong reference and was the first answer: it is a
 * whole 17 degrees higher than the light spec 045 tuned, so normalising against
 * it would leave the sea visibly dark in the one frame everybody sees first.
 *
 * Derived from those two modules rather than written down as a literal, so
 * retuning the fixed daylight moves the reference with it and "the palette is
 * what the sea looks like in the default frame" stays true by construction
 * rather than until somebody edits a number two files away.
 *
 * `applyManualSun` aims the key through `horizonShadow` before using it, so the
 * same clamp is applied here -- at this elevation it changes nothing, and a
 * reference that skipped it would silently stop matching if the offset were ever
 * dragged toward the horizon.
 */
export const REFERENCE_IRRADIANCE: readonly [number, number, number] = ((): readonly [
  number,
  number,
  number,
] => {
  const offset = DEFAULT_LIGHT_OFFSET;
  const length = Math.hypot(offset.x, offset.y, offset.z);
  const shadow = horizonShadow(Math.asin(offset.y / length));
  return flatIrradiance({
    ambientHex: FIXED_DAYLIGHT.ambientColor,
    ambientIntensity: FIXED_DAYLIGHT.ambientIntensity + shadowFillBoost(shadow.strength),
    keyHex: FIXED_DAYLIGHT.lightColor,
    keyIntensity: FIXED_DAYLIGHT.lightIntensity,
    dotNL: Math.sin(shadow.castElevation),
  });
})();

/**
 * A palette colour as the albedo that reproduces it under
 * {@link REFERENCE_IRRADIANCE}.
 *
 * `PI` because three's `BRDF_Lambert` is `RECIPROCAL_PI * diffuseColor`: the
 * shader divides by it on the way out, so the albedo has to carry it on the way
 * in. Miss it and the sea is a third as bright as it was authored, in every
 * frame, at every hour.
 *
 * The result may exceed 1 -- foam does, at about 1.78 -- and that is correct
 * rather than a clamp waiting to happen. `diffuseColor` is a float and nothing
 * between here and `<opaque_fragment>` clamps it, so foam lands back on exactly
 * the colour it was authored as once the reference light has divided it out.
 */
export function waterAlbedo(hex: number): readonly [number, number, number] {
  const linear = unpackLinear(hex);
  return [0, 1, 2].map(
    (i) => ((linear[i] as number) * Math.PI) / (REFERENCE_IRRADIANCE[i] as number),
  ) as unknown as readonly [number, number, number];
}

/** {@link waterAlbedo} as the colour a uniform holds. Already linear, so no conversion. */
function albedoColor(hex: number): THREE.Color {
  const [r, g, b] = waterAlbedo(hex);
  return new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
}

/**
 * The shore field is one texel per terrain cell, addressed from world XZ by
 * `uSdfOrigin` (the world position of texel centre 0,0) and `uSdfScale` (texels
 * per world unit). Sampled by *world* position rather than by a chunk-local UV,
 * because a UV means the noise restarts at every chunk boundary and every
 * boundary becomes a visible seam.
 */
const WATER_PROLOGUE = /* glsl */ `
uniform sampler2D uShoreField;
uniform vec2 uSdfOrigin;
uniform vec2 uSdfScale;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShallow;
uniform vec3 uFoam;

varying vec3 vWaterWorld;

WIND_CHUNK

const float SHORE_RANGE = SHORE_RANGE_VALUE;
`;

/**
 * The bands, written into `diffuseColor` for three to light.
 *
 * Spliced in *after* `<color_fragment>` rather than before it: that include is
 * where a vertex colour would be folded in, and this replaces the surface's
 * colour outright rather than riding on top of one -- which is the opposite of
 * what the ground's streak layer does two files over, and is why this assigns
 * where that multiplies.
 *
 * In a block of its own, so none of these locals can collide with a name three
 * declares later in `main()`. The alternative is a shader that compiles for as
 * long as nobody upgrades three.
 */
const WATER_APPLY = /* glsl */ `
  {
    vec2 shoreUv = (vWaterWorld.xz - uSdfOrigin) * uSdfScale;
    float shoreDistance = texture2D(uShoreField, shoreUv).r * SHORE_RANGE;
    float field = warpedField(vWaterWorld.xz, uWindTime);

    // The band threshold: distance from shore, wobbled by the field so the edge
    // breathes without the band changing width, then nudged by the ordered
    // dither so the boundary stipples instead of stepping cleanly.
    float banded = shoreDistance
                 + (field - 0.5) * EDGE_WOBBLE
                 + (bayer4(gl_FragCoord.xy) - 0.5) * EDGE_DITHER;

    vec3 water = uDeep;
    water = mix(water, uMid, step(banded, MID_EDGE));
    water = mix(water, uShallow, step(banded, SHALLOW_EDGE));

    // Isolines of the same field: a thin bright line wherever it crosses one of
    // a handful of evenly spaced levels. step(), never smoothstep() -- a soft
    // line here is the one thing that would give the whole surface away.
    float iso = step(abs(fract(field * ISO_LINES) - 0.5), ISO_WIDTH);
    water = mix(water, water * ISO_GAIN, iso);

    // Foam: a pulse travelling along the coast, clamped so a crest cannot reach
    // out past the shallow band and flood it.
    float wave = sin(uWindTime * FOAM_OMEGA - shoreDistance * FOAM_TRAVEL + field * 4.0);
    water = mix(water, uFoam,
                step(shoreDistance, FOAM_EDGE + wave * FOAM_SWING) * step(shoreDistance, FOAM_LIMIT));

    // The same streak layer the ground carries, at the same speed and in the
    // same direction. This is the piece that makes the coastline read as one
    // place.
    water *= windStreak(vWaterWorld.xz, uWindTime, STREAK_WATER);

    diffuseColor.rgb = water;
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

/** Substitute the art direction into a fragment of GLSL. */
function substitute(source: string): string {
  const tokens = new RegExp(`\\b(${Object.keys(CONSTANTS).join('|')})\\b`, 'g');
  return source.replace(tokens, (token) => CONSTANTS[token] ?? token);
}

/**
 * The two halves the patch splices in, resolved once.
 *
 * At module load rather than per material, because a map has hundreds of water
 * chunks and every one of them would otherwise re-run the substitution to
 * produce the same string -- and, more to the point, because
 * {@link waterFragmentChunk} is what the tests scan and `patchWater` is what
 * the GPU gets. Two calls to `substitute` is two chances for those to be
 * different strings.
 */
const PROLOGUE_GLSL = substitute(WATER_PROLOGUE.replace('WIND_CHUNK', glslWindChunk()));
const APPLY_GLSL = substitute(WATER_APPLY);

/**
 * Everything this patch injects into the fragment stage, with every constant
 * substituted in.
 *
 * Exported so a test can scan it, and it needs one: this is a *string* until a
 * GPU sees it, so neither the type system nor any amount of headless testing of
 * what it computes will notice that it does not compile.
 *
 * One whole-word pass over the source rather than a chain of `replace` calls.
 * A chain looks equivalent and is not: `String.replace` with a string pattern
 * substitutes the *first* occurrence only, so a constant used twice compiled
 * with the second use left as an undeclared identifier -- and the only thing
 * that noticed was Chromium. Whole-word so a token can never eat a longer one
 * it is a prefix of.
 */
export function waterFragmentChunk(): string {
  return `${PROLOGUE_GLSL}\n${APPLY_GLSL}`;
}

/**
 * The four colours, as albedo, in the renderer's working space. Shared by every
 * chunk's material: there is one palette, and a chunk cannot have its own.
 */
const PALETTE_UNIFORMS = {
  uDeep: { value: albedoColor(WATER.deep) },
  uMid: { value: albedoColor(WATER.mid) },
  uShallow: { value: albedoColor(WATER.shallow) },
  uFoam: { value: albedoColor(WATER.foam) },
};

/** The one thing that genuinely is per chunk. */
interface ShoreUniforms {
  readonly uShoreField: THREE.IUniform<THREE.DataTexture>;
  readonly uSdfOrigin: THREE.IUniform<THREE.Vector2>;
  readonly uSdfScale: THREE.IUniform<THREE.Vector2>;
}

/**
 * Which meshes are ours, and what each one's shore texture is.
 *
 * A `MeshLambertMaterial` has no `.uniforms`, so the texture has to be held
 * somewhere for {@link disposeWaterQuad} to free -- and "is this a water quad"
 * has to be answerable, since the obvious test before spec 259 was
 * `material instanceof THREE.ShaderMaterial` and that silently stops being true
 * the moment the water is lit like everything else. One table answers both, so
 * the two cannot come apart.
 */
const SHORE_TEXTURES = new WeakMap<THREE.Object3D, THREE.DataTexture>();

/** Whether this mesh is one of the water quads built here. */
export function isWaterQuad(mesh: THREE.Object3D): boolean {
  return SHORE_TEXTURES.has(mesh);
}

/**
 * Splice the bands into a Lambert material.
 *
 * This **assigns** `onBeforeCompile` where the ground's four patches compose
 * onto whatever was there before, and that is safe for exactly one reason: this
 * material is built here, one patch is put on it, and nothing else ever touches
 * it. Add a second and the ground's rule applies immediately.
 */
function patchWater(material: THREE.Material, shore: ShoreUniforms): void {
  material.onBeforeCompile = (shader): void => {
    // By reference, not by value: one clock, one wind and one palette for the
    // whole world, however many chunks are on screen.
    Object.assign(shader.uniforms, WIND_UNIFORMS, PALETTE_UNIFORMS, shore);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorld;')
      // The world position is already computed here for shadows and lights;
      // this only carries it through to the fragment stage.
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWaterWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PROLOGUE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${APPLY_GLSL}`);
  };
  // Without a cache key three.js would hand a patched and an unpatched Lambert
  // the same compiled program, and which one won would depend on draw order.
  // One key for every chunk, so the per-chunk material costs a texture bind
  // rather than a shader switch.
  material.customProgramCacheKey = (): string => 'water';
  material.needsUpdate = true;
}

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
 *
 * Two triangles is enough geometry for this to be lit correctly because
 * `MeshLambertMaterial` shades per fragment in this version of three -- its
 * fragment shader is the one that includes `<lights_lambert_fragment>`. Under
 * the Gouraud material the name still suggests, a campfire's pool on the water
 * would be interpolated across a whole chunk from its four corners.
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

  const material = new THREE.MeshLambertMaterial({ transparent: false, depthWrite: true });
  patchWater(material, {
    uShoreField: { value: texture },
    // World XZ -> [0, 1] over the chunk's cells. Texel i covers cell i
    // exactly, so its centre lands on (i + 0.5) / cols and the linear filter
    // interpolates between cell centres rather than across cell edges.
    uSdfOrigin: { value: new THREE.Vector2(opt.originX, opt.originZ) },
    uSdfScale: {
      value: new THREE.Vector2(
        1 / (opt.field.cols * opt.cellSize),
        1 / (opt.field.rows * opt.cellSize),
      ),
    },
  });

  const geometry = new THREE.PlaneGeometry(opt.width, opt.depth);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(opt.originX + opt.width / 2, opt.waterLevel, opt.originZ + opt.depth / 2);
  // Water neither takes the sun's shade nor throws any: a shadow on a flat
  // stylized surface reads as dirt floating on it. Being lit (spec 259) and
  // receiving shadow are separate switches, and only the first one is thrown.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  SHORE_TEXTURES.set(mesh, texture);
  return mesh;
}

/** Free a water quad's geometry, material and shore texture. */
export function disposeWaterQuad(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  SHORE_TEXTURES.get(mesh)?.dispose();
  SHORE_TEXTURES.delete(mesh);
  (mesh.material as THREE.Material).dispose();
}

/** How much of a world unit one step of the packed shore byte is worth. */
export const SHORE_QUANTUM = shoreQuantum(WATER.shoreRange);
