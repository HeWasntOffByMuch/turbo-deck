import * as THREE from 'three';
import { MAX_CLIMB_ANGLE_DEG, MAX_WALK_ANGLE_DEG } from '../../../sim/constants.js';
import { footprintRadius, type MapChunkStore } from '../../../terrain/index.js';
import { NAV_CELL_CLIMB, NAV_CELL_WALK } from './nav.js';

/**
 * The nav overlay (spec 053) — the picture that answers "why can't units path
 * here".
 *
 * Three colours, because there are three answers (spec 227). **Steep** ground is
 * crossed at `CLIMB_PACE` and routed at `NAV_STEEP_COST`; **cliff** is ground
 * nothing gets up at all; **prop footprints** are drawn on top of both but never
 * baked, because a tree is not terrain and re-baking nav every time a bush is
 * planted would be absurd. Seeing them apart is the whole point: "that is a
 * scramble", "that is a cliff" and "that is a tree" are three different problems
 * with three different fixes, and the overlay used to say only the last two --
 * against a threshold the game did not use.
 *
 * Unwalkable cells are drawn at their own four jittered corners, so the overlay
 * lies exactly on the surface it describes rather than hovering over it in a
 * lattice the mesh does not actually use.
 */

/** A cliff, ground that is only a scramble, and the ring a prop blocks. */
const GROUND_COLOR = 0xff5c5c;
const CLIMB_COLOR = 0x4c9cff;
const PROP_COLOR = 0xffc04c;

/**
 * What the two bands are, in degrees, for whoever is reading the picture.
 *
 * Exported rather than printed here because `nav-view.ts` is the three.js half
 * and the panel is where a legend belongs -- and because the numbers are the
 * sim's, so nothing here may spell them out.
 */
export const NAV_LEGEND = {
  walkUpToDeg: MAX_WALK_ANGLE_DEG,
  climbUpToDeg: MAX_CLIMB_ANGLE_DEG,
} as const;

/** How far the overlay floats above the surface, to clear z-fighting. */
const LIFT = 1.6;

/** Segments around a prop's footprint circle. */
const FOOTPRINT_SEGMENTS = 14;

export interface NavViewHandle {
  readonly object: THREE.Object3D;
  /** Rebuild from the store's baked nav plus the props standing on it. */
  refresh(store: MapChunkStore, layerId: string, heightAt: (x: number, z: number) => number): void;
  setVisible(visible: boolean): void;
  get isVisible(): boolean;
  dispose(): void;
}

export function createNavView(): NavViewHandle {
  const group = new THREE.Group();
  group.visible = false;
  group.renderOrder = 15;

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  let geometry = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  group.add(mesh);

  return {
    object: group,
    refresh(store: MapChunkStore, layerId: string, heightAt: (x: number, z: number) => number): void {
      const layer = store.layerInfo(layerId);
      if (!layer) return;
      const positions: number[] = [];
      const colors: number[] = [];
      const ground = new THREE.Color(GROUND_COLOR);
      const climb = new THREE.Color(CLIMB_COLOR);
      const prop = new THREE.Color(PROP_COLOR);

      const tri = (
        a: readonly [number, number, number],
        b: readonly [number, number, number],
        c: readonly [number, number, number],
        colour: THREE.Color,
      ): void => {
        positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        for (let i = 0; i < 3; i++) colors.push(colour.r, colour.g, colour.b);
      };

      for (let cz = layer.grid.minCz; cz <= layer.grid.maxCz; cz++) {
        for (let cx = layer.grid.minCx; cx <= layer.grid.maxCx; cx++) {
          const nav = store.chunkNav(layerId, cx, cz);
          const chunk = nav ? store.buildChunk(layerId, cx, cz) : null;
          if (!nav || !chunk) continue;
          const stride = chunk.cols + 1;
          const corner = (i: number, j: number): readonly [number, number, number] => {
            const k = j * stride + i;
            return [chunk.cornerX[k] ?? 0, (chunk.heights[k] ?? 0) + LIFT, chunk.cornerZ[k] ?? 0];
          };
          for (let j = 0; j < chunk.rows; j++) {
            for (let i = 0; i < chunk.cols; i++) {
              // Only the cells that cost a unit something; a map is mostly
              // walkable, so drawing the complement would be most of the world.
              const cell = nav[j * chunk.cols + i];
              if (cell === NAV_CELL_WALK) continue;
              if (!store.cellSolid(layerId, chunk.startCol + i, chunk.startRow + j)) continue;
              const colour = cell === NAV_CELL_CLIMB ? climb : ground;
              const c00 = corner(i, j);
              const c10 = corner(i + 1, j);
              const c01 = corner(i, j + 1);
              const c11 = corner(i + 1, j + 1);
              tri(c00, c01, c11, colour);
              tri(c00, c11, c10, colour);
            }
          }
        }
      }

      // Prop footprints as discs on the ground, in the second colour.
      for (const p of store.props(layerId)) {
        const radius = footprintRadius(p);
        const centre: readonly [number, number, number] = [p.x, heightAt(p.x, p.y) + LIFT, p.y];
        for (let seg = 0; seg < FOOTPRINT_SEGMENTS; seg++) {
          const a = (seg / FOOTPRINT_SEGMENTS) * Math.PI * 2;
          const b = ((seg + 1) / FOOTPRINT_SEGMENTS) * Math.PI * 2;
          const ax = p.x + Math.cos(a) * radius;
          const az = p.y + Math.sin(a) * radius;
          const bx = p.x + Math.cos(b) * radius;
          const bz = p.y + Math.sin(b) * radius;
          tri(centre, [ax, heightAt(ax, az) + LIFT, az], [bx, heightAt(bx, bz) + LIFT, bz], prop);
        }
      }

      geometry.dispose();
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      mesh.geometry = geometry;
    },
    setVisible(visible: boolean): void {
      group.visible = visible;
    },
    get isVisible(): boolean {
      return group.visible;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
      group.clear();
    },
  };
}
