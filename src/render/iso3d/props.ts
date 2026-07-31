import * as THREE from 'three';
import { PALETTE } from './palette.js';
import type { Prop } from '../../terrain/vegetation.js';

/**
 * Batched scenery for the whole world (spec 043). The scatter puts hundreds of
 * trees and bushes across the terrain, which is what turns a heightfield into a
 * place worth walking around in -- but as individual `Group`s that would be
 * thousands of draw calls. Each part of a tree or bush therefore becomes an
 * `InstancedMesh` carrying many copies of it.
 *
 * Those instanced meshes are **bucketed by region** rather than one per part for
 * the whole world. A single world-spanning batch has a world-spanning bounding
 * sphere, so the camera can never cull any of it and every tree is submitted
 * every frame no matter where the player is -- for a world this much wider than
 * the view, that is nearly all of them wasted. Per-region batches each get a
 * tight bounding sphere, so the ones behind the camera drop out for free.
 *
 * Instancing also buys the variety cheaply: every instance gets its own colour,
 * so foliage drifts in shade across the world and the occasional tree turns
 * autumn -- the same silhouette repeated, never the same colour twice in a row.
 */

/**
 * Edge of one batching region, in world units. Big enough that the view holds
 * only a few (so the draw-call count stays low), small enough that a region is
 * a meaningful fraction of what is on screen (so culling actually bites).
 */
const REGION_SIZE = 1100;

/** One part of a prop: a shared geometry plus where it sits in the prop's local space. */
interface PropPart {
  readonly geometry: THREE.BufferGeometry;
  readonly offsetY: number;
  /** Local XZ offset, for the bush's off-centre second blob. */
  readonly offsetX?: number;
  readonly offsetZ?: number;
  readonly scaleY?: number;
  /** Base colour, tinted per instance. `foliage` parts also take the autumn turn. */
  readonly color: number;
  readonly foliage: boolean;
}

// The tree's three tapering tiers, matching `makeTree` exactly so a batched tree
// and a standalone one are the same object.
const TREE_TIERS: readonly [radius: number, height: number, baseY: number, color: number][] = [
  [34, 34, 26, PALETTE.leafDeep],
  [26, 30, 44, PALETTE.leafMid],
  [17, 26, 60, PALETTE.leafBright],
];

function treeParts(): PropPart[] {
  const parts: PropPart[] = [
    { geometry: new THREE.BoxGeometry(10, 26, 10), offsetY: 13, color: PALETTE.trunk, foliage: false },
  ];
  for (const [radius, height, baseY, color] of TREE_TIERS) {
    parts.push({
      geometry: new THREE.ConeGeometry(radius, height, 7),
      offsetY: baseY + height / 2,
      color,
      foliage: true,
    });
  }
  return parts;
}

function bushParts(): PropPart[] {
  return [
    { geometry: new THREE.IcosahedronGeometry(20, 0), offsetY: 14, scaleY: 0.7, color: PALETTE.bush, foliage: true },
    {
      geometry: new THREE.IcosahedronGeometry(13, 0),
      offsetX: 9,
      offsetY: 20,
      offsetZ: -4,
      scaleY: 0.7,
      color: PALETTE.bushBright,
      foliage: true,
    },
  ];
}

/** Warm autumn foliage, for the fraction of trees that turn. */
const AUTUMN = [0xb8502a, 0xd0722c, 0xe0a334] as const;
/** Tint above which a prop goes autumn. ~18% of them, so it stays an accent. */
const AUTUMN_ABOVE = 0.64;

/**
 * The colour one instance of a foliage part takes. Most props only drift a
 * little either side of the base green; the ones past the autumn threshold swap
 * to the warm ramp instead, keeping the same dark-to-bright tier ordering.
 */
function foliageColor(base: number, tier: number, tint: number): number {
  if (tint > AUTUMN_ABOVE) return AUTUMN[Math.min(tier, AUTUMN.length - 1)] ?? base;
  const scale = 0.88 + 0.24 * ((tint + 1) / 2);
  const r = Math.min(255, Math.round(((base >> 16) & 0xff) * scale));
  const g = Math.min(255, Math.round(((base >> 8) & 0xff) * scale));
  const b = Math.min(255, Math.round((base & 0xff) * scale));
  return (r << 16) | (g << 8) | b;
}

export interface PropFieldHandle {
  readonly group: THREE.Group;
  dispose(): void;
}

/**
 * Build the instanced meshes for a list of scattered props, standing each one on
 * the terrain via `heightAt`. Static: instance matrices are written once, since
 * scenery never moves.
 */
export function buildPropField(props: readonly Prop[], heightAt: (x: number, z: number) => number): PropFieldHandle {
  const group = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const build = (parts: readonly PropPart[], of: readonly Prop[]): void => {
    if (of.length === 0) return;
    parts.forEach((part, tier) => {
      const material = new THREE.MeshLambertMaterial({ flatShading: true });
      const mesh = new THREE.InstancedMesh(part.geometry, material, of.length);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      const color = new THREE.Color();

      of.forEach((prop, i) => {
        const s = prop.scale;
        // Local offset, scaled with the prop and spun by its rotation.
        const lx = (part.offsetX ?? 0) * s;
        const lz = (part.offsetZ ?? 0) * s;
        const cos = Math.cos(prop.rotation);
        const sin = Math.sin(prop.rotation);
        position.set(
          prop.x + lx * cos - lz * sin,
          heightAt(prop.x, prop.y) + part.offsetY * s,
          prop.y + lx * sin + lz * cos,
        );
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), prop.rotation);
        scale.set(s, s * (part.scaleY ?? 1), s);
        mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
        color.setHex(part.foliage ? foliageColor(part.color, tier - 1, prop.tint) : part.color);
        mesh.setColorAt(i, color);
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
      geometries.push(part.geometry);
      materials.push(material);
    });
  };

  // Group props into square regions, then batch each region's trees and bushes
  // separately, so each batch's bounds are small enough for the camera to cull.
  const regions = new Map<string, Prop[]>();
  for (const prop of props) {
    const key = `${Math.floor(prop.x / REGION_SIZE)},${Math.floor(prop.y / REGION_SIZE)}`;
    const bucket = regions.get(key);
    if (bucket) bucket.push(prop);
    else regions.set(key, [prop]);
  }
  // Sorted, so the scene graph is built in the same order for the same input.
  for (const key of [...regions.keys()].sort()) {
    const bucket = regions.get(key) ?? [];
    build(treeParts(), bucket.filter((p) => p.kind === 'tree'));
    build(bushParts(), bucket.filter((p) => p.kind === 'bush'));
  }

  return {
    group,
    dispose(): void {
      for (const geo of geometries) geo.dispose();
      for (const mat of materials) mat.dispose();
      group.clear();
    },
  };
}
