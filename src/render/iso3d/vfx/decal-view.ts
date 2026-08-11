/**
 * Decals, drawn (spec 120).
 *
 * One merged geometry per map chunk, rebuilt only when that chunk's bucket is
 * dirty. `props.ts` reached the same arrangement for the prop field (spec 086)
 * and for the same reason: a decal is a handful of triangles, merging a bucket is
 * cheap, and merging the whole field on every hit is not.
 *
 * ## Fitted, not projected
 *
 * Each decal is a small grid whose vertices sample the real terrain height, so it
 * follows the ground it lies on. That is a few dozen vertices instead of a
 * projection pass, it needs no depth buffer, and it cannot z-fight -- there is no
 * coplanar surface to fight with, because the decal *is* the surface, lifted.
 *
 * ## Why it is never inked
 *
 * `transparent: true` and `depthWrite: false`, which is the same pair the
 * particle batches use and the same condition `HikeBuffers.capture` skips on. A
 * bloodstain is a mark on a surface, not a form with a silhouette, and the
 * outline pass would draw a hard line around every one of them.
 *
 * ## One atlas, generated
 *
 * Splats are baked into a single atlas texture at startup rather than one
 * texture per decal: a texture swap is a draw call, and the whole point of
 * bucketing was to have few of those. Which cell a decal uses is its seed modulo
 * the atlas size, so a decal's look still follows from its seed.
 */

import * as THREE from 'three';
import { decalGrid, decalGridIndices, decalGridUvs, type ChunkKey, type DecalField } from './decals.js';
import { FLUIDS, generateSplat, type FluidKind } from './splat.js';
import { VFX_PALETTE, unpackInto } from './palette.js';

/** Grid samples across a decal. 4x4 follows a hillside without being a mesh. */
const GRID = 4;
/** Distinct splats baked into the atlas. */
const ATLAS_CELLS = 16;
/** Each cell's resolution. A decal is ~30 world units; this is plenty. */
const CELL = 32;
/** How far off the surface a decal sits, in world units. */
const LIFT = 1.2;

const scratchPositions = new Float32Array(GRID * GRID * 3);
const scratchUvs = new Float32Array(GRID * GRID * 2);

/**
 * The splat atlas: `ATLAS_CELLS` masks in a row, generated once.
 *
 * Alpha only in effect -- the RGB is white and the tint comes from the vertex
 * colour, which is what lets one atlas serve blood, sap, ichor, oil and slime.
 */
function buildAtlas(): THREE.DataTexture {
  const width = CELL * ATLAS_CELLS;
  const pixels = new Uint8Array(width * CELL * 4);
  const fluids: readonly FluidKind[] = ['blood', 'blood', 'blood', 'sap', 'ichor', 'oil', 'slime'];

  for (let cell = 0; cell < ATLAS_CELLS; cell++) {
    // A spread of directions and throws across the atlas, so a chunk full of
    // decals is not a chunk full of one silhouette rotated.
    const angle = (cell / ATLAS_CELLS) * Math.PI * 2;
    const fluid = fluids[cell % fluids.length] ?? 'blood';
    const mask = generateSplat(0x5b100d + cell * 9176, {
      size: CELL,
      ...FLUIDS[fluid],
      dirX: Math.cos(angle),
      dirY: Math.sin(angle),
      throwStrength: 0.3 + (cell % 4) * 0.22,
      mass: 0.32 + (cell % 3) * 0.06,
    });
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const at = (y * width + cell * CELL + x) * 4;
        pixels[at] = 255;
        pixels[at + 1] = 255;
        pixels[at + 2] = 255;
        pixels[at + 3] = mask[y * CELL + x] ?? 0;
      }
    }
  }

  const texture = new THREE.DataTexture(pixels as Uint8Array<ArrayBuffer>, width, CELL, THREE.RGBAFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // Coverage, not colour: it must not be decoded as sRGB on the way in.
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const FLUID_COLOR: Record<FluidKind, number> = {
  blood: VFX_PALETTE.bloodFresh,
  sap: VFX_PALETTE.sapAmber,
  ichor: VFX_PALETTE.ichorViolet,
  oil: VFX_PALETTE.oilBlack,
  slime: VFX_PALETTE.slimeGreen,
};

const VERTEX_SHADER = /* glsl */ `
attribute vec3 tint;
attribute float fade;
varying vec2 vUv;
varying vec3 vTint;
varying float vFade;
void main() {
  vUv = uv;
  vTint = tint;
  vFade = fade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision mediump float;
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec3 vTint;
varying float vFade;
void main() {
  float coverage = texture2D(uAtlas, vUv).a;
  // A decal is a silhouette, so its edge is a cut and not a ramp -- the same
  // decision splat.ts makes when it thresholds the mask. (No backticks in here:
  // this is a template literal, and one closes it.) The fade is ordered against
  // the screen so a dying stain thins out rather than going translucent, which
  // is what the frame's quantizer would band anyway.
  if (coverage < 0.5) discard;
  vec2 cell = mod(floor(gl_FragCoord.xy), 4.0);
  float threshold = (cell.x * 4.0 + cell.y) / 16.0;
  if (vFade <= threshold) discard;
  gl_FragColor = vec4(vTint, 1.0);
}
`;

/** One chunk's worth of decals, as a single mesh. */
interface Bucket {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
}

export class DecalView {
  readonly root = new THREE.Object3D();
  private readonly buckets = new Map<string, Bucket>();
  private readonly material: THREE.ShaderMaterial;
  private readonly atlas: THREE.DataTexture;
  private readonly rgb = new Float32Array(3);

  constructor(
    private readonly field: DecalField,
    private readonly ground: (x: number, z: number) => number,
  ) {
    this.atlas = buildAtlas();
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: { uAtlas: { value: this.atlas } },
      transparent: true,
      // Both jobs at once, as with the particle batches: the right blend state,
      // and the condition that keeps these out of the outline buffers.
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });
    this.root.name = 'vfx-decals';
    this.root.frustumCulled = false;
  }

  /** Rebuild whatever changed. Cheap when nothing did, which is most frames. */
  sync(): void {
    for (const key of this.field.takeDirty()) this.rebuild(key);
  }

  private rebuild(key: ChunkKey): void {
    const name = `${key.cx},${key.cz}`;
    const existing = this.buckets.get(name);
    if (existing) {
      this.root.remove(existing.mesh);
      existing.geometry.dispose();
      this.buckets.delete(name);
    }

    const decals = this.field.bucket(key.cx, key.cz);
    if (decals.length === 0) return;

    const vertexCount = decals.length * GRID * GRID;
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const tints = new Float32Array(vertexCount * 3);
    const fades = new Float32Array(vertexCount);
    const indices: number[] = [];

    decalGridUvs(GRID, scratchUvs);

    decals.forEach((decal, index) => {
      const base = index * GRID * GRID;
      decalGrid(decal, GRID, this.ground, LIFT, scratchPositions);
      positions.set(scratchPositions, base * 3);

      // Which atlas cell, from the decal's own seed -- so its look follows from
      // the particle that made it, like everything else here.
      const cell = ((decal.seed % ATLAS_CELLS) + ATLAS_CELLS) % ATLAS_CELLS;
      for (let i = 0; i < GRID * GRID; i++) {
        const u = scratchUvs[i * 2] ?? 0;
        const v = scratchUvs[i * 2 + 1] ?? 0;
        uvs[(base + i) * 2] = (cell + u) / ATLAS_CELLS;
        uvs[(base + i) * 2 + 1] = v;
      }

      unpackInto(FLUID_COLOR[decal.fluid] ?? VFX_PALETTE.bloodFresh, this.rgb, 0);
      for (let i = 0; i < GRID * GRID; i++) {
        tints[(base + i) * 3] = this.rgb[0] ?? 0;
        tints[(base + i) * 3 + 1] = this.rgb[1] ?? 0;
        tints[(base + i) * 3 + 2] = this.rgb[2] ?? 0;
        fades[base + i] = decal.opacity;
      }

      decalGridIndices(GRID, base, indices);
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('tint', new THREE.BufferAttribute(tints, 3));
    geometry.setAttribute('fade', new THREE.BufferAttribute(fades, 1));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.renderOrder = 5;
    this.root.add(mesh);
    this.buckets.set(name, { mesh, geometry });
  }

  /** How many chunk meshes are up. What the debug HUD reads. */
  get bucketCount(): number {
    return this.buckets.size;
  }

  dispose(): void {
    for (const bucket of this.buckets.values()) {
      this.root.remove(bucket.mesh);
      bucket.geometry.dispose();
    }
    this.buckets.clear();
    this.material.dispose();
    this.atlas.dispose();
  }
}
