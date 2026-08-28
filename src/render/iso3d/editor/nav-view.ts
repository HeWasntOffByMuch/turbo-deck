import * as THREE from 'three';
import { MAX_WALK_ANGLE_DEG } from '../../../sim/constants.js';
import { footprintRadius, type MapChunkStore } from '../../../terrain/index.js';
import { NAV_CELL_WALK } from './nav.js';

/**
 * The nav overlay (spec 053) — the picture that answers "why can't units path
 * here".
 *
 * Two colours, because there are two answers. Unwalkable **ground** is what
 * `bakeChunkNav` decides, through the sim's own `MAX_WALK_SLOPE` since spec 228
 * rather than through a threshold of the editor's own that the game did not
 * use; **prop footprints** are drawn on top of it but never baked, because a
 * tree is not terrain and re-baking nav every time a bush is planted would be
 * absurd. Seeing them apart is the whole point: "that is too steep" and "that
 * is a tree" are different problems with different fixes.
 *
 * Unwalkable cells are drawn at their own four jittered corners, so the overlay
 * lies exactly on the surface it describes rather than hovering over it in a
 * lattice the mesh does not actually use.
 */

/** Unwalkable ground, and the ring a prop blocks. */
const GROUND_COLOR = 0xff5c5c;
const PROP_COLOR = 0xffc04c;

/**
 * The angle the red means, for whoever is reading the picture.
 *
 * Exported rather than printed here because `nav-view.ts` is the three.js half
 * and a legend belongs on the panel -- and because the number is the sim's, so
 * nothing here may spell it out.
 */
export const NAV_LEGEND = { walkUpToDeg: MAX_WALK_ANGLE_DEG } as const;

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
              // Only the cells a unit cannot cross; a map is mostly walkable, so
              // drawing the complement would be most of the world.
              if (nav[j * chunk.cols + i] === NAV_CELL_WALK) continue;
              if (!store.cellSolid(layerId, chunk.startCol + i, chunk.startRow + j)) continue;
              const c00 = corner(i, j);
              const c10 = corner(i + 1, j);
              const c01 = corner(i, j + 1);
              const c11 = corner(i + 1, j + 1);
              tri(c00, c01, c11, ground);
              tri(c00, c11, c10, ground);
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
