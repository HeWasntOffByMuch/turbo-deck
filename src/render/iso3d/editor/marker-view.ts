import * as THREE from 'three';
import type { MapMarker, MapMarkerKind, MapRect } from '../../../terrain/index.js';
import { MARKER_COLORS, MARKER_GLYPHS } from './markers.js';

/**
 * Drawing markers and the arena outline (spec 052).
 *
 * Two pieces per marker, and the second is the one that matters. A billboard
 * alone tells you roughly where a marker is, and roughly is not good enough for
 * a spawn point on sloping ground -- so every billboard floats above a **stem**
 * dropped to the exact point it marks.
 *
 * Everything here draws with the depth test off, like the brush cursor. A marker
 * hidden behind the hill it sits on is a marker you will forget exists.
 */

/** Billboard size in world units, and how high it floats above its point. */
const BILLBOARD_SIZE = 46;
const STEM_HEIGHT = 90;

/** Texture resolution for the generated disc. Small: it is a disc and a letter. */
const TEXTURE_PX = 64;

/**
 * The disc texture for a kind, drawn once and shared by every marker of it. A
 * filled circle in the kind's colour, a dark rim so it reads against bright
 * snow, and its initial.
 */
const textures = new Map<MapMarkerKind, THREE.Texture>();

function markerTexture(kind: MapMarkerKind): THREE.Texture {
  const cached = textures.get(kind);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_PX;
  canvas.height = TEXTURE_PX;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  // The canvas is painted with sRGB colours -- `MARKER_COLORS` as a CSS hex --
  // and a texture's colour space defaults to none, meaning "already linear". So
  // without this the bytes skip the decode every other use of the same constant
  // gets, and the disc comes out the one place in the renderer where
  // MARKER_COLORS does not draw as MARKER_COLORS (spec 087).
  texture.colorSpace = THREE.SRGBColorSpace;
  if (!ctx) return texture;

  const mid = TEXTURE_PX / 2;
  ctx.beginPath();
  ctx.arc(mid, mid, mid - 5, 0, Math.PI * 2);
  ctx.fillStyle = `#${MARKER_COLORS[kind].toString(16).padStart(6, '0')}`;
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(12, 12, 18, 0.9)';
  ctx.stroke();

  ctx.fillStyle = 'rgba(12, 12, 18, 0.9)';
  ctx.font = `bold ${TEXTURE_PX * 0.5}px "Courier New", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(MARKER_GLYPHS[kind], mid, mid + 2);

  texture.needsUpdate = true;
  textures.set(kind, texture);
  return texture;
}

const materials = new Map<MapMarkerKind, THREE.SpriteMaterial>();

function markerMaterial(kind: MapMarkerKind): THREE.SpriteMaterial {
  const cached = materials.get(kind);
  if (cached) return cached;
  const material = new THREE.SpriteMaterial({ map: markerTexture(kind), depthTest: false, transparent: true });
  materials.set(kind, material);
  return material;
}

export interface MarkerViewHandle {
  readonly group: THREE.Object3D;
  /** Redraw every marker. Cheap enough to call whenever the set changes. */
  render(markers: readonly MapMarker[], heightAt: (x: number, z: number) => number): void;
  dispose(): void;
}

/** Billboards and stems for the map's markers. */
export function createMarkerView(): MarkerViewHandle {
  const group = new THREE.Group();
  group.renderOrder = 20;

  const stemMaterial = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true });
  const stemGeometry = new THREE.BufferGeometry();
  const stems = new THREE.LineSegments(stemGeometry, stemMaterial);
  stems.frustumCulled = false;
  stems.renderOrder = 20;
  group.add(stems);

  const sprites: THREE.Sprite[] = [];

  return {
    group,
    render(markers: readonly MapMarker[], heightAt: (x: number, z: number) => number): void {
      // One stem segment per marker, all in a single LineSegments: a marker set
      // is small, but a draw call each would still be a draw call each.
      const positions = new Float32Array(markers.length * 6);
      const colors = new Float32Array(markers.length * 6);
      const colour = new THREE.Color();

      markers.forEach((marker, i) => {
        const ground = heightAt(marker.x, marker.z);
        positions.set([marker.x, ground, marker.z, marker.x, ground + STEM_HEIGHT, marker.z], i * 6);
        colour.setHex(MARKER_COLORS[marker.kind]);
        colors.set([colour.r, colour.g, colour.b, colour.r, colour.g, colour.b], i * 6);

        let sprite = sprites[i];
        if (!sprite) {
          sprite = new THREE.Sprite(markerMaterial(marker.kind));
          sprite.scale.setScalar(BILLBOARD_SIZE);
          sprite.renderOrder = 21;
          sprites.push(sprite);
          group.add(sprite);
        }
        // Reused across renders, so the material may need swapping for the kind
        // that now occupies this slot.
        sprite.material = markerMaterial(marker.kind);
        sprite.position.set(marker.x, ground + STEM_HEIGHT, marker.z);
        sprite.visible = true;
      });

      // Surplus sprites are hidden rather than destroyed: placing and erasing
      // the same marker repeatedly would otherwise churn objects every stroke.
      for (let i = markers.length; i < sprites.length; i++) {
        const spare = sprites[i];
        if (spare) spare.visible = false;
      }

      stemGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      stemGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      stems.visible = markers.length > 0;
    },
    dispose(): void {
      stemGeometry.dispose();
      stemMaterial.dispose();
      group.clear();
      sprites.length = 0;
    },
  };
}

/** Segments along each edge of the arena outline. Enough to hug rolling ground. */
const ARENA_SEGMENTS_PER_EDGE = 48;

export interface ArenaOutlineHandle {
  readonly object: THREE.Object3D;
  /** Re-drape the outline over the terrain, after it has been sculpted. */
  refresh(rect: MapRect, heightAt: (x: number, z: number) => number): void;
  dispose(): void;
}

/**
 * The play rectangle, drawn on the ground.
 *
 * Not editable here -- it is the box you are laying a map out inside, and being
 * able to see it is the whole point. Its vertices are sampled at `heightAt` so
 * it lies on the terrain the way the brush cursor does, rather than cutting
 * through every rise it crosses.
 */
export function createArenaOutline(color = 0xffffff): ArenaOutlineHandle {
  const count = ARENA_SEGMENTS_PER_EDGE * 4;
  const positions = new Float32Array(count * 3);
  const attribute = new THREE.BufferAttribute(positions, 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', attribute);
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55, depthTest: false });
  const loop = new THREE.LineLoop(geometry, material);
  loop.frustumCulled = false;
  loop.renderOrder = 19;

  return {
    object: loop,
    refresh(rect: MapRect, heightAt: (x: number, z: number) => number): void {
      const corners: readonly (readonly [number, number])[] = [
        [rect.minX, rect.minZ],
        [rect.maxX, rect.minZ],
        [rect.maxX, rect.maxZ],
        [rect.minX, rect.maxZ],
      ];
      let at = 0;
      for (let edge = 0; edge < 4; edge++) {
        const from = corners[edge] ?? [0, 0];
        const to = corners[(edge + 1) % 4] ?? [0, 0];
        for (let step = 0; step < ARENA_SEGMENTS_PER_EDGE; step++) {
          const t = step / ARENA_SEGMENTS_PER_EDGE;
          const x = from[0] + (to[0] - from[0]) * t;
          const z = from[1] + (to[1] - from[1]) * t;
          positions[at * 3] = x;
          positions[at * 3 + 1] = heightAt(x, z) + 2;
          positions[at * 3 + 2] = z;
          at++;
        }
      }
      attribute.needsUpdate = true;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
