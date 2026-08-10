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
  } else {
    // Flat on the ground plane, spun about Y. Decals, scorch marks, ground glow.
    float c = cos(iRotation);
    float s = sin(iRotation);
    vec2 spun = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
    world += vec3(spun.x, 0.0, spun.y) * iSize;
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

/** Every render mode's integer code, for the shader's `iMode`. */
export function modeCode(render: number): number {
  switch (render) {
    case RENDER.stretched:
      return 1;
    case RENDER['axis-billboard']:
      return 2;
    case RENDER['ground-quad']:
      return 3;
    // A ribbon is drawn as a chain of stretched quads by the layer, and a mesh
    // particle is a billboard until spec 119 gives it real geometry to instance.
    default:
      return 0;
  }
}

/** Release the shared dither texture. Only a context loss needs this. */
export function disposeBatchShared(): void {
  ditherTexture?.dispose();
  ditherTexture = null;
}
