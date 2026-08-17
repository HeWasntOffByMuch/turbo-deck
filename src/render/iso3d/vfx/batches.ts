/**
 * Drawing the particle field (spec 118).
 *
 * One `InstancedBufferGeometry` per (blend mode, sprite sheet), a unit quad
 * repeated across it, and every per-particle value uploaded as an instanced
 * attribute straight out of the pool's typed arrays. The registry as it stands
 * produces three draw calls for the whole system.
 *
 * ## Everything that can be done in the vertex shader is
 *
 * Billboarding, velocity stretching, ground alignment and flipbook UVs all
 * happen on the GPU, from the camera matrix and the instance's own attributes.
 * The CPU's entire job per particle is to copy floats it already has. That is
 * what keeps the sim's cost at ~120ns a particle rather than paying for a
 * matrix per quad.
 *
 * The render *mode* is an attribute rather than a batch key on purpose. Batching
 * by mode as well as by blend and sheet would multiply the draw calls by six to
 * save a branch the GPU takes uniformly across a warp anyway.
 *
 * ## Why nothing here writes depth
 *
 * `transparent: true` and `depthWrite: false`, which does two jobs at once. It
 * is the correct blend state for additive and alpha particles, and it is exactly
 * the condition `HikeBuffers.capture` skips on -- so particles stay out of the
 * depth and normal buffers and the outline pass cannot draw an ink line around a
 * spark. A spark is not a form. (`hike-buffers.ts`, and the note there about
 * ground decals, which are excluded for the same reason.)
 *
 * ## Where this ends up in the frame
 *
 * Nowhere special, and that is the point. The batches are children of an
 * `Object3D` that lives in `WorldScene.scene`, and `RetroPass.render` draws that
 * scene into the low-resolution target. There is no VFX pass to insert and no
 * compositing step to get wrong.
 */

import * as THREE from 'three';
import { BLEND, RENDER } from './compile.js';
import type { ParticlePool } from './pool.js';
import { sheetFrames, spriteSheet } from './textures.js';
import {
  coreGlowShape,
  needsVelocity,
  orientOf,
  particleMesh,
  rootShadeOf,
  shadingOf,
  strokeShape,
  type MeshShape,
} from './meshes.js';
import { STROKE_UV_STRIDE } from './stroke.js';

/** Instances one batch is built to hold. Grown by rebuilding, never per frame. */
const INITIAL_CAPACITY = 256;

const VERTEX_SHADER = /* glsl */ `
attribute vec3 iOffset;
attribute vec3 iVelocity;
attribute float iSize;
attribute float iRotation;
attribute vec3 iColor;
attribute float iAlpha;
attribute float iMode;
attribute float iFrame;
attribute float iStretch;

uniform float uFrames;

varying vec3 vColor;
varying float vAlpha;
varying vec2 vSheetUv;

void main() {
  // The camera's right and up in world space, read out of the view matrix's
  // columns. Works for the orthographic camera this game uses and for a
  // perspective one, because it is the basis and not a position.
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

  vec2 corner = position.xy;
  vec3 world = iOffset;

  if (iMode < 0.5) {
    // Billboard: camera-facing, spun by its own rotation.
    float c = cos(iRotation);
    float s = sin(iRotation);
    vec2 spun = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
    world += (camRight * spun.x + camUp * spun.y) * iSize;
  } else if (iMode < 1.5) {
    // Velocity-aligned and stretched along the direction of travel, measured in
    // *screen* space -- a spark flying at the camera should shorten, not stay a
    // full-length streak pointing nowhere.
    vec2 screenVelocity = vec2(dot(iVelocity, camRight), dot(iVelocity, camUp));
    float speed = length(screenVelocity);
    vec2 dir = speed > 0.0001 ? screenVelocity / speed : vec2(0.0, 1.0);
    vec2 perp = vec2(-dir.y, dir.x);
    float length2 = iSize * (1.0 + speed * iStretch);
    vec2 local = dir * (corner.y * length2) + perp * (corner.x * iSize);
    world += camRight * local.x + camUp * local.y;
  } else if (iMode < 2.5) {
    // Axis-locked: turns to face the camera about Y only, so a flame or a smoke
    // column stands up instead of leaning with the view.
    vec3 flat2 = vec3(camRight.x, 0.0, camRight.z);
    float len = length(flat2);
    vec3 right = len > 0.0001 ? flat2 / len : vec3(1.0, 0.0, 0.0);
    world += (right * corner.x + vec3(0.0, 1.0, 0.0) * corner.y) * iSize;
  } else if (iMode < 3.5) {
    // Flat on the ground plane, spun about Y. Decals, scorch marks, ground glow.
    float c = cos(iRotation);
    float s = sin(iRotation);
    vec2 spun = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
    world += vec3(spun.x, 0.0, spun.y) * iSize;
  } else {
    // One link of a ribbon (spec 139). The instance is a *segment*, not a
    // particle: iOffset is where it starts, iVelocity is the vector to where it
    // ends, and iSize/iStretch are the widths at those two ends. No new
    // attribute -- a chain of these is a bent, tapering streak built out of the
    // row the batch already uploads.
    float t = corner.y + 0.5;
    // Along the segment in *world* space, so a link pointing at the camera
    // foreshortens for the same reason a stretched spark shortens.
    world = iOffset + iVelocity * t;
    vec2 screenSeg = vec2(dot(iVelocity, camRight), dot(iVelocity, camUp));
    float segLength = length(screenSeg);
    vec2 dir = segLength > 0.0001 ? screenSeg / segLength : vec2(0.0, 1.0);
    vec2 perp = vec2(-dir.y, dir.x);
    // corner.x spans [-0.5, 0.5], so this is the full width at that end.
    float segWidth = mix(iSize, iStretch, t);
    world += (camRight * perp.x + camUp * perp.y) * (corner.x * segWidth);
  }

  vColor = iColor;
  vAlpha = iAlpha;
  // Flipbook: the sheet is a horizontal strip, so only U moves.
  vSheetUv = vec2((uv.x + floor(iFrame)) / uFrames, uv.y);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

uniform sampler2D uMap;
uniform sampler2D uDither;
uniform float uCutout;

varying vec3 vColor;
varying float vAlpha;
varying vec2 vSheetUv;

void main() {
  vec4 texel = texture2D(uMap, vSheetUv);
  float alpha = texel.a * vAlpha;

  if (uCutout > 0.5) {
    // The pixel-look blend: no partial alpha at all. A fade happens as a
    // thinning weave of solid pixels, ordered against the same 4x4 Bayer matrix
    // the retro pass dithers the whole frame with -- so a particle's edge
    // dissolves into the frame's weave rather than banding against it.
    vec2 cell = mod(floor(gl_FragCoord.xy), 4.0);
    float threshold = texture2D(uDither, (cell + 0.5) / 4.0).r;
    if (alpha <= threshold) discard;
    alpha = 1.0;
  } else if (alpha < 0.004) {
    discard;
  }

  gl_FragColor = vec4(vColor * texel.rgb, alpha);
}
`;

/** The 4x4 Bayer thresholds as a texture, matching `retro.ts`'s matrix. */
function makeDitherTexture(): THREE.DataTexture {
  const order = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const rgba = new Uint8Array(16 * 4);
  for (let i = 0; i < 16; i++) {
    const v = Math.round((((order[i] ?? 0) + 0.5) / 16) * 255);
    rgba.set([v, v, v, 255], i * 4);
  }
  const texture = new THREE.DataTexture(rgba, 4, 4, THREE.RGBAFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

let ditherTexture: THREE.DataTexture | null = null;

function sharedDither(): THREE.DataTexture {
  ditherTexture ??= makeDitherTexture();
  return ditherTexture;
}

function blendingFor(blend: number): THREE.Blending {
  return blend === BLEND.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
}

/** One draw call: every live particle sharing a blend mode and a sheet. */
export class ParticleBatch {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private capacity = INITIAL_CAPACITY;

  private offset!: THREE.InstancedBufferAttribute;
  private velocity!: THREE.InstancedBufferAttribute;
  private size!: THREE.InstancedBufferAttribute;
  private rotation!: THREE.InstancedBufferAttribute;
  private color!: THREE.InstancedBufferAttribute;
  private alpha!: THREE.InstancedBufferAttribute;
  private mode!: THREE.InstancedBufferAttribute;
  private frame!: THREE.InstancedBufferAttribute;
  private stretch!: THREE.InstancedBufferAttribute;

  constructor(
    readonly blend: number,
    readonly sheet: string,
  ) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uMap: { value: spriteSheet(sheet) },
        uDither: { value: sharedDither() },
        uFrames: { value: sheetFrames(sheet) },
        uCutout: { value: blend === BLEND['dither-cutout'] ? 1 : 0 },
      },
      transparent: true,
      // Both halves matter. It is the right blend state, and it is the condition
      // `HikeBuffers.capture` skips on -- so a spark is never given an ink line.
      depthWrite: false,
      depthTest: true,
      blending: blendingFor(blend),
      side: THREE.DoubleSide,
    });

    this.geometry = this.buildGeometry(this.capacity);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // The particles are in world space already; culling a batch by a bounding
    // sphere that would have to be recomputed every frame costs more than the
    // draw call it saves.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
  }

  private buildGeometry(capacity: number): THREE.InstancedBufferGeometry {
    const geometry = new THREE.InstancedBufferGeometry();
    // A unit quad centred on the origin; the vertex shader does the rest.
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    const instanced = (items: number): THREE.InstancedBufferAttribute => {
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * items), items);
      attribute.setUsage(THREE.DynamicDrawUsage);
      return attribute;
    };

    this.offset = instanced(3);
    this.velocity = instanced(3);
    this.size = instanced(1);
    this.rotation = instanced(1);
    this.color = instanced(3);
    this.alpha = instanced(1);
    this.mode = instanced(1);
    this.frame = instanced(1);
    this.stretch = instanced(1);

    geometry.setAttribute('iOffset', this.offset);
    geometry.setAttribute('iVelocity', this.velocity);
    geometry.setAttribute('iSize', this.size);
    geometry.setAttribute('iRotation', this.rotation);
    geometry.setAttribute('iColor', this.color);
    geometry.setAttribute('iAlpha', this.alpha);
    geometry.setAttribute('iMode', this.mode);
    geometry.setAttribute('iFrame', this.frame);
    geometry.setAttribute('iStretch', this.stretch);
    geometry.instanceCount = 0;
    return geometry;
  }

  /**
   * Make room for `needed` instances.
   *
   * Doubling, and only ever upward, so a busy fight pays for its buffers once
   * and a quiet minute afterwards does not hand them back only to re-allocate
   * them on the next blow.
   */
  private ensureCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    let capacity = this.capacity;
    while (capacity < needed) capacity *= 2;
    this.capacity = capacity;
    const old = this.geometry;
    this.geometry = this.buildGeometry(capacity);
    this.mesh.geometry = this.geometry;
    old.dispose();
  }

  /** Begin a frame. Returns the write cursor, which is always zero. */
  begin(count: number): number {
    this.ensureCapacity(count);
    return 0;
  }

  /** Copy one particle's attributes into slot `at`. */
  write(at: number, pool: ParticlePool, i: number, mode: number, stretch: number): void {
    const o = at * 3;
    this.offset.array[o] = pool.x[i] ?? 0;
    this.offset.array[o + 1] = pool.y[i] ?? 0;
    this.offset.array[o + 2] = pool.z[i] ?? 0;
    this.velocity.array[o] = pool.vx[i] ?? 0;
    this.velocity.array[o + 1] = pool.vy[i] ?? 0;
    this.velocity.array[o + 2] = pool.vz[i] ?? 0;
    this.color.array[o] = pool.r[i] ?? 0;
    this.color.array[o + 1] = pool.g[i] ?? 0;
    this.color.array[o + 2] = pool.b[i] ?? 0;
    this.size.array[at] = pool.size[i] ?? 0;
    this.rotation.array[at] = pool.rot[i] ?? 0;
    this.alpha.array[at] = pool.a[i] ?? 0;
    this.mode.array[at] = mode;
    this.frame.array[at] = pool.frame[i] ?? 0;
    this.stretch.array[at] = stretch;
  }

  /**
   * Copy one ribbon segment into slot `at` (spec 139).
   *
   * Geometry from `segments` -- the flat `from/to/widths` rows `ribbonSegments`
   * writes -- and colour, alpha and frame from the particle that owns the chain,
   * so every link of a streak is the one colour the gradient says it is at that
   * moment. `iVelocity` carries the segment vector rather than a velocity; the
   * shader's mode 4 is the only reader and it says so.
   */
  writeSegment(at: number, pool: ParticlePool, i: number, segments: Float32Array, segAt: number): void {
    const o = at * 3;
    const fromX = segments[segAt] ?? 0;
    const fromY = segments[segAt + 1] ?? 0;
    const fromZ = segments[segAt + 2] ?? 0;
    this.offset.array[o] = fromX;
    this.offset.array[o + 1] = fromY;
    this.offset.array[o + 2] = fromZ;
    this.velocity.array[o] = (segments[segAt + 3] ?? 0) - fromX;
    this.velocity.array[o + 1] = (segments[segAt + 4] ?? 0) - fromY;
    this.velocity.array[o + 2] = (segments[segAt + 5] ?? 0) - fromZ;
    this.color.array[o] = pool.r[i] ?? 0;
    this.color.array[o + 1] = pool.g[i] ?? 0;
    this.color.array[o + 2] = pool.b[i] ?? 0;
    this.size.array[at] = segments[segAt + 6] ?? 0;
    this.stretch.array[at] = segments[segAt + 7] ?? 0;
    this.rotation.array[at] = 0;
    this.alpha.array[at] = pool.a[i] ?? 0;
    this.mode.array[at] = MODE_RIBBON;
    this.frame.array[at] = pool.frame[i] ?? 0;
  }

  /** Publish `count` instances and flag the ranges the GPU has to re-read. */
  end(count: number): void {
    this.geometry.instanceCount = count;
    this.mesh.visible = count > 0;
    if (count === 0) return;
    // Only the range actually written, so a frame with four particles does not
    // re-upload a buffer sized for a thousand.
    for (const attribute of [this.offset, this.velocity, this.color]) {
      attribute.addUpdateRange(0, count * 3);
      attribute.needsUpdate = true;
    }
    for (const attribute of [this.size, this.rotation, this.alpha, this.mode, this.frame, this.stretch]) {
      attribute.addUpdateRange(0, count);
      attribute.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** The `iMode` a ribbon segment is written with. Its own code since spec 139. */
export const MODE_RIBBON = 4;

/** Every render mode's integer code, for the shader's `iMode`. */
export function modeCode(render: number): number {
  switch (render) {
    case RENDER.stretched:
      return 1;
    case RENDER['axis-billboard']:
      return 2;
    case RENDER['ground-quad']:
      return 3;
    // A ribbon is a chain of these, one instance per link, written by the layer
    // through `writeSegment` (spec 139). It used to fall through to the default
    // and come back a billboard -- the same silent stub `mesh` was until spec
    // 123, and with the same symptom: the value round-tripped perfectly and
    // nothing drew what it named.
    case RENDER.ribbon:
      return MODE_RIBBON;
    // `mesh` never reaches here: it has its own batch.
    default:
      return 0;
  }
}

// --- solid particles (spec 123) ----------------------------------------------

const MESH_VERTEX_SHADER = /* glsl */ `
attribute vec3 iOffset;
attribute vec3 iVelocity;
attribute float iSize;
attribute float iRotation;
attribute vec3 iColor;
attribute float iAlpha;
attribute float iSeed;
attribute float iAge;

#ifdef VFX_STROKE
// (along, signedHalfOffset, sideX, sideY) -- see stroke.ts. The position
// attribute holds the
// stroke's *spine* rather than its finished vertex, so the outline is rebuilt
// here with a per-instance twist on top.
attribute vec4 aStroke;
// Which gesture in the bank this vertex belongs to. An instance draws one of
// them and clips the rest (spec 159).
attribute float aVariant;
uniform float uVariants;
uniform float uRootShade;
varying float vAlong;
#endif

varying vec3 vColor;
varying float vAlpha;
varying vec3 vNormal;

/**
 * A camera-facing card, rolled in the view plane (spec 158).
 *
 * (No backticks in here -- this is a template literal and one closes it.)
 *
 * The columns of the view matrix are the camera's own axes in world space, the
 * same read the quad shader makes for its billboards. Works for an orthographic
 * camera and a perspective one alike, because it is a basis and not a position.
 */
mat3 cardBasis(float roll) {
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camFwd   = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float c = cos(roll);
  float s = sin(roll);
  return mat3(camRight * c + camUp * s, camUp * c - camRight * s, camFwd);
}

/**
 * The same card, with +Y along the SCREEN projection of a velocity.
 *
 * Projecting before aiming is the whole point: a mark thrown at the camera has a
 * long world-space velocity and no screen-space direction at all, and aiming at
 * the world vector would draw it full length pointing nowhere. Foreshortening
 * falls out instead, exactly as it does for a stretched spark.
 */
mat3 cardVelocityBasis(vec3 vel) {
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camFwd   = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec2 screen = vec2(dot(vel, camRight), dot(vel, camUp));
  float speed = length(screen);
  vec2 dir = speed > 0.0001 ? screen / speed : vec2(0.0, 1.0);
  return mat3(camRight * dir.y - camUp * dir.x, camRight * dir.x + camUp * dir.y, camFwd);
}

#ifdef VFX_STROKE
/** Two decorrelated values in [0,1) from one instance seed and a salt. */
vec2 strokeHash(float seed, float salt) {
  return vec2(
    fract(sin(seed * 91.7211 + salt * 13.317) * 47453.1234),
    fract(sin(seed * 37.1339 + salt * 71.913) * 21783.7231)
  );
}

/** A slow wave along the mark, phase and depth per instance, in [-1, 1]. */
float strokeWave(float along, float seed, float freq, float salt) {
  vec2 h = strokeHash(seed, salt);
  return sin(along * freq + h.x * 6.2831853) * (0.6 + 0.4 * h.y);
}
#endif

/**
 * A basis whose +Y is the direction given, rolled about itself (spec 125).
 *
 * (No backticks in here -- this is a template literal and one closes it.)
 *
 * Direction and not speed. Drag scales a velocity and never turns it, so the
 * axis of a thrown spike is stable all the way down -- but it does shrink toward
 * zero, which is what the guard is for.
 */
mat3 aimedAt(vec3 dir, float roll) {
  float speed = length(dir);
  vec3 up = speed > 0.0001 ? dir / speed : vec3(0.0, 1.0, 0.0);
  // Any vector not parallel to up: choosing by the largest component of up is
  // what keeps the cross product away from zero whichever way it points.
  vec3 other = abs(up.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 right = normalize(cross(other, up));
  vec3 fwd = cross(up, right);
  float c = cos(roll);
  float s = sin(roll);
  return mat3(right * c + fwd * s, up, fwd * c - right * s);
}

/** Three angles hashed out of the seed: a fixed tumble, so blobs differ. */
vec3 tumble(float seed) {
  float a = fract(sin(seed * 12.9898) * 43758.5453);
  float b = fract(sin(seed * 78.2330) * 24634.6345);
  float c = fract(sin(seed * 39.4256) * 15731.7431);
  return vec3(a, b, c) * 6.2831853;
}

mat3 rotation(vec3 angles) {
  float sx = sin(angles.x), cx = cos(angles.x);
  float sy = sin(angles.y), cy = cos(angles.y);
  float sz = sin(angles.z), cz = cos(angles.z);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cx, -sx, 0.0, sx, cx);
  mat3 ry = mat3(cy, 0.0, sy, 0.0, 1.0, 0.0, -sy, 0.0, cy);
  mat3 rz = mat3(cz, -sz, 0.0, sz, cz, 0.0, 0.0, 0.0, 1.0);
  return rz * ry * rx;
}

void main() {
#ifdef VFX_STROKE
  // Pick one gesture out of the bank and clip the others (spec 159).
  //
  // This is what makes a fan of a dozen marks a dozen DIFFERENT marks rather
  // than one silhouette drawn a dozen times -- the failure the first cut of this
  // vocabulary had, and the one that made a burst read as a radial star of
  // repeated triangles. The unused vertices are pushed outside the clip volume,
  // so they cost a vertex shader invocation each and produce no fragments, and
  // the whole bank is still one draw call.
  float pick = floor(fract(sin(iSeed * 51.3173 + 7.1329) * 39187.113) * uVariants);
  if (abs(aVariant - pick) > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
#endif

  // Three answers, picked per batch by uOrient (spec 124). A blob tumbles
  // freely; a flame or a shaft of light stands up and takes a per-seed yaw so
  // two side by side are not one extrusion; a sigil takes the rotation it was
  // given and nothing else, because a jitter would put its runes at a different
  // angle every time one is stamped. (No backticks in here -- this is a template
  // literal and one closes it, which is a parse error a long way from the cause.)
  mat3 basis =
    uOrient < 0.5 ? rotation(tumble(iSeed) + vec3(0.0, iRotation, 0.0)) :
    uOrient < 1.5 ? rotation(vec3(0.0, iRotation + tumble(iSeed).y, 0.0)) :
    uOrient < 2.5 ? rotation(vec3(0.0, iRotation, 0.0)) :
    uOrient < 3.5 ? aimedAt(iVelocity, tumble(iSeed).x) :
    // The two card modes (spec 158): a brush mark is flat, so it is held in the
    // view plane rather than tumbled, and the variety a tumble would have given
    // comes out of the silhouette instead.
    uOrient < 4.5 ? cardBasis(iRotation) :
                    cardVelocityBasis(iVelocity);

  vec3 shape = position;
  float tone = 1.0;

#ifdef VFX_STROKE
  // The second layer of variation, and the animation (specs 158, 159).
  //
  // The bank above decides WHICH mark; this perturbs the one it picked, so two
  // instances of one bank entry still differ, and then moves the shape over the
  // particle's life. Animating the geometry rather than the transform is the
  // difference the brief is pointing at: a mark that is drawn out along its own
  // path and then retracts from its root reads as paint being applied, where the
  // same mark scaled up and down reads as a decal being switched on.
  {
    float along = aStroke.x;
    vec2 side = aStroke.zw;
    vec2 h0 = strokeHash(iSeed, 1.0);
    vec2 h1 = strokeHash(iSeed, 2.0);

    // How fat this instance is, and where along it swells.
    float envelope = 0.72 + 0.5 * h0.x;
    float ripple = 1.0 + 0.2 * strokeWave(along, iSeed, 4.1, 3.0);

    // How long, and which way it curls away from its own root.
    float stretch = 0.72 + 0.62 * h1.x;
    float bend = (h1.y * 2.0 - 1.0) * 0.16 * along * along;

    // Foreshortening, for a mark that was aimed rather than dropped.
    //
    // A stroke thrown straight at the camera has a long world-space velocity and
    // almost no screen-space direction, so cardVelocityBasis falls back to "up"
    // -- and without this it is then drawn at FULL LENGTH pointing nowhere,
    // which is precisely the complaint spec 139 made about stretched blood.
    // Floored rather than taken to zero: a mark seen end-on should read as a
    // dab of paint, not vanish.
    if (uOrient > 4.5) {
      vec3 camFwd = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
      float speed = length(iVelocity);
      float depth = speed > 0.0001 ? abs(dot(iVelocity / speed, camFwd)) : 1.0;
      stretch *= mix(0.34, 1.0, sqrt(max(0.0, 1.0 - depth * depth)));
    }

    // (1) The gesture draws out along its own path over the first few ticks.
    float extend = mix(0.44, 1.0, smoothstep(0.0, 0.15, iAge));
    // (2) Then it retracts from the root. Geometric, never an alpha fade: the
    // flecks past the tip are the last thing left, which is how a flick reads,
    // and a dissolve made of discarded pixels is the screen-door transparency
    // this whole spec exists to remove.
    float erode = smoothstep(0.58, 1.0, iAge) * 0.98;
    float alive = smoothstep(0.0, 0.09, along - erode);
    // (3) And it thins as it dries, a little, so the last frames are a narrower
    // mark rather than the same mark going quiet.
    float dry = mix(1.0, 0.72, smoothstep(0.45, 1.0, iAge));

    float gain = max(0.0, envelope * ripple * alive * dry);
    float lift = max(position.y, erode);

    shape = vec3(position.x + side.x * (bend + aStroke.y * gain),
                 lift * stretch * extend + side.y * (bend + aStroke.y * gain),
                 // The arch across the width follows the width, so a pinched
                 // mark is a shallow one.
                 position.z * gain);
    vAlong = along;
    // Darker toward the root: value variation inside one mark, out of its own
    // geometry rather than out of a pattern laid over it.
    tone *= 1.0 - uRootShade * (1.0 - smoothstep(0.0, 0.5, along));
  }
#endif

  vec3 local = basis * (shape * iSize);
  vNormal = normalize(basis * normal);
  // The white-hot middle, baked into the geometry rather than into the colour
  // ramp (spec 125). A gradient over a particle's *life* makes every spike in a
  // fan the same colour at the same moment; the reference is yellow-white where
  // the spikes meet and red at their tips, which is a gradient along the shape.
  // Distance from the shape's own origin works for both the spike and the star,
  // because both are authored radiating out of it.
  float hotter = 1.0 + uCoreGlow * 0.9 * (1.0 - clamp(length(position), 0.0, 1.0));
  vColor = iColor * hotter * tone;
  vAlpha = iAlpha;
  gl_Position = projectionMatrix * viewMatrix * vec4(iOffset + local, 1.0);
}
`;

const MESH_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

uniform vec3 uLightDirection;
uniform float uShading;

varying vec3 vColor;
varying float vAlpha;
varying vec3 vNormal;
#ifdef VFX_STROKE
varying float vAlong;
#endif

void main() {
  // A cheap wrapped lambert. Without it a semi-transparent blob is a flat
  // silhouette and a cluster of them is a smear; with it each one catches light
  // in planes and the cluster reads as a body with a top and an underside --
  // which is the entire difference between "smoke" and "grey shapes". A brush
  // mark takes a third of it (uShading, spec 159): enough to see the arch in a
  // world-oriented mark, nowhere near enough to make paint look like plastic.
  float lambert = dot(normalize(vNormal), normalize(uLightDirection)) * 0.5 + 0.5;
  float shade = mix(1.0, 0.45 + 0.75 * lambert, uShading);

  // No dither, and deliberately none (spec 159). Spec 158 gave this shader the
  // quad batch's ordered Bayer discard so a mark could "dissolve into the
  // frame's own weave"; what it actually produced was checkerboards, halftone
  // fills and one-pixel fragments over every painted effect in the game --
  // screen-door transparency, which is a pixel-art technique and not this art
  // direction. A brush mark is a filled silhouette with a rough boundary, and
  // where it needs to come apart it does so in the GEOMETRY, by retracting from
  // its root (see the vertex shader) rather than by deleting pixels out of a
  // shape that is still there.
  if (vAlpha < 0.004) discard;
  gl_FragColor = vec4(vColor * shade, vAlpha);
}
`;

/** One draw call: every live solid particle sharing a shape and a blend mode. */
export class MeshParticleBatch {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private capacity = INITIAL_CAPACITY;

  private offset!: THREE.InstancedBufferAttribute;
  private velocity!: THREE.InstancedBufferAttribute;
  private size!: THREE.InstancedBufferAttribute;
  private rotation!: THREE.InstancedBufferAttribute;
  private color!: THREE.InstancedBufferAttribute;
  private alpha!: THREE.InstancedBufferAttribute;
  private seed!: THREE.InstancedBufferAttribute;
  private age!: THREE.InstancedBufferAttribute;
  /** Only a shape that aims itself pays for a velocity upload. */
  private readonly aims: boolean;
  /** A brush mark, whose outline is rebuilt per instance in the shader. */
  private readonly stroke: boolean;

  constructor(
    readonly blend: number,
    readonly shape: MeshShape,
  ) {
    this.aims = needsVelocity(shape);
    this.stroke = strokeShape(shape);
    // The define rather than a uniform: the stroke path declares an attribute
    // and a varying, and a batch whose geometry has no `aStroke` must not
    // declare one -- three warns, and some drivers bind whatever was last in
    // that slot.
    const defines = this.stroke ? '#define VFX_STROKE\n' : '';
    this.material = new THREE.ShaderMaterial({
      vertexShader: `${defines}uniform float uOrient;\nuniform float uCoreGlow;\n${MESH_VERTEX_SHADER}`,
      fragmentShader: `${defines}${MESH_FRAGMENT_SHADER}`,
      uniforms: {
        // Roughly the scene's own key light, so a blob is lit like the ground.
        uLightDirection: { value: new THREE.Vector3(0.45, 1, 0.35).normalize() },
        // Light is not lit. A flame, a shaft and a sigil are all their own
        // colour; a blob and a diamond are objects and catch the key.
        uShading: { value: shadingOf(shape) },
        uOrient: { value: orientOf(shape) },
        uCoreGlow: { value: coreGlowShape(shape) ? 1 : 0 },
        uVariants: { value: Math.max(1, particleMesh(shape).variants ?? 1) },
        uRootShade: { value: rootShadeOf(shape) },
      },
      transparent: true,
      // Same pair as the quad batches, and the same two jobs: the right blend
      // state, and the condition `HikeBuffers.capture` skips on so a puff of
      // smoke is never given an ink outline.
      depthWrite: false,
      depthTest: true,
      blending: blendingFor(blend),
      side: THREE.DoubleSide,
    });

    this.geometry = this.buildGeometry(this.capacity);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    // Behind the additive quads: sparks and flashes read over smoke, not under.
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
  }

  private buildGeometry(capacity: number): THREE.InstancedBufferGeometry {
    const source = particleMesh(this.shape);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(source.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
    // Not instanced: these are per *vertex* of the shared bank, and they are
    // what the shader needs to put the outline back around the baked spine and
    // to know which of the bank's gestures a vertex belongs to.
    if (source.strokeUv) {
      geometry.setAttribute('aStroke', new THREE.BufferAttribute(source.strokeUv, STROKE_UV_STRIDE));
    }
    if (source.variant) {
      geometry.setAttribute('aVariant', new THREE.BufferAttribute(source.variant, 1));
    }

    const instanced = (items: number): THREE.InstancedBufferAttribute => {
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * items), items);
      attribute.setUsage(THREE.DynamicDrawUsage);
      return attribute;
    };
    this.offset = instanced(3);
    this.velocity = instanced(3);
    this.size = instanced(1);
    this.rotation = instanced(1);
    this.color = instanced(3);
    this.alpha = instanced(1);
    this.seed = instanced(1);
    this.age = instanced(1);

    geometry.setAttribute('iOffset', this.offset);
    geometry.setAttribute('iVelocity', this.velocity);
    geometry.setAttribute('iSize', this.size);
    geometry.setAttribute('iRotation', this.rotation);
    geometry.setAttribute('iColor', this.color);
    geometry.setAttribute('iAlpha', this.alpha);
    geometry.setAttribute('iSeed', this.seed);
    geometry.setAttribute('iAge', this.age);
    geometry.instanceCount = 0;
    return geometry;
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    let capacity = this.capacity;
    while (capacity < needed) capacity *= 2;
    this.capacity = capacity;
    const old = this.geometry;
    this.geometry = this.buildGeometry(capacity);
    this.mesh.geometry = this.geometry;
    old.dispose();
  }

  begin(count: number): void {
    this.ensureCapacity(count);
  }

  write(at: number, pool: ParticlePool, i: number): void {
    const o = at * 3;
    this.offset.array[o] = pool.x[i] ?? 0;
    this.offset.array[o + 1] = pool.y[i] ?? 0;
    this.offset.array[o + 2] = pool.z[i] ?? 0;
    if (this.aims) {
      this.velocity.array[o] = pool.vx[i] ?? 0;
      this.velocity.array[o + 1] = pool.vy[i] ?? 0;
      this.velocity.array[o + 2] = pool.vz[i] ?? 0;
    }
    this.color.array[o] = pool.r[i] ?? 0;
    this.color.array[o + 1] = pool.g[i] ?? 0;
    this.color.array[o + 2] = pool.b[i] ?? 0;
    this.size.array[at] = pool.size[i] ?? 0;
    this.rotation.array[at] = pool.rot[i] ?? 0;
    this.alpha.array[at] = pool.a[i] ?? 0;
    this.seed.array[at] = ((pool.seed[i] ?? 0) & 0xffff) / 0xffff;
    // How far through its life, so the shader can move the SHAPE rather than
    // the transform (spec 159). One float, and it is what buys the gesture
    // drawing out along its own path and then retracting from its root.
    this.age.array[at] = Math.min(1, (pool.age[i] ?? 0) / Math.max(1, pool.life[i] ?? 1));
  }

  end(count: number): void {
    this.geometry.instanceCount = count;
    this.mesh.visible = count > 0;
    if (count === 0) return;
    for (const attribute of this.aims ? [this.offset, this.color, this.velocity] : [this.offset, this.color]) {
      attribute.addUpdateRange(0, count * 3);
      attribute.needsUpdate = true;
    }
    for (const attribute of [this.size, this.rotation, this.alpha, this.seed, this.age]) {
      attribute.addUpdateRange(0, count);
      attribute.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Release the shared dither texture. Only a context loss needs this. */
export function disposeBatchShared(): void {
  ditherTexture?.dispose();
  ditherTexture = null;
}
