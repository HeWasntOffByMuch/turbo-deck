import * as THREE from 'three';
import type { MapMarker, MapMarkerKind, MapRect } from '../../../terrain/index.js';
import { markerCaption, MARKER_COLORS, MARKER_GLYPHS } from './markers.js';

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
 * The captioned billboard: the same disc with a name written under it.
 *
 * Three times as wide as the plain one and a quarter again as tall, and the
 * sprite is scaled by the same factors -- so the **disc comes out exactly the
 * size it always was** and the caption is extra canvas around it rather than
 * the marker shrinking to make room. Getting that wrong is subtle and ugly: a
 * uniform sprite scale on a wider texture squashes every disc on the map the
 * moment one marker is given a name.
 */
const CAPTION_W = TEXTURE_PX * 3;
const CAPTION_H = TEXTURE_PX * 1.25;
/** Font size for the caption, in texture pixels. */
const CAPTION_PX = 19;
/**
 * How far a captioned billboard is lowered so its disc lands where a plain
 * one's does.
 *
 * A sprite is centred on its position, and the caption is extra canvas *below*
 * the disc -- so without this the disc rides up by half the added height and
 * the stem, which is drawn to the exact point being marked, stops short of the
 * thing it is pointing at. Half the growth, which is what recentring on the
 * disc rather than on the picture comes to.
 */
const CAPTION_DISC_DROP = BILLBOARD_SIZE * 0.5 * (CAPTION_H / TEXTURE_PX - 1);

/**
 * The disc texture for a kind, drawn once and shared by every marker of it. A
 * filled circle in the kind's colour, a dark rim so it reads against bright
 * snow, and its initial.
 */
// Keyed by kind *and* caption: two spawners naming different monsters are two
// different pictures, and a cache on the kind alone would hand the second one
// the first one's name.
const textures = new Map<string, THREE.Texture>();

function markerTexture(kind: MapMarkerKind, caption: string): THREE.Texture {
  const key = `${kind}|${caption}`;
  const cached = textures.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = caption === '' ? TEXTURE_PX : CAPTION_W;
  canvas.height = caption === '' ? TEXTURE_PX : CAPTION_H;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  // The canvas is painted with sRGB colours -- `MARKER_COLORS` as a CSS hex --
  // and a texture's colour space defaults to none, meaning "already linear". So
  // without this the bytes skip the decode every other use of the same constant
  // gets, and the disc comes out the one place in the renderer where
  // MARKER_COLORS does not draw as MARKER_COLORS (spec 097).
  texture.colorSpace = THREE.SRGBColorSpace;
  if (!ctx) return texture;

  // The disc is drawn at the same pixel size on either canvas, centred in the
  // top `TEXTURE_PX` band -- which is what keeps a captioned marker's disc the
  // same size on screen as an uncaptioned one.
  const cx = canvas.width / 2;
  const mid = TEXTURE_PX / 2;
  ctx.beginPath();
  ctx.arc(cx, mid, mid - 5, 0, Math.PI * 2);
  ctx.fillStyle = `#${MARKER_COLORS[kind].toString(16).padStart(6, '0')}`;
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(12, 12, 18, 0.9)';
  ctx.stroke();

  ctx.fillStyle = 'rgba(12, 12, 18, 0.9)';
  ctx.font = `bold ${TEXTURE_PX * 0.5}px "Courier New", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(MARKER_GLYPHS[kind], cx, mid + 2);

  if (caption !== '') {
    const baseline = TEXTURE_PX + (CAPTION_H - TEXTURE_PX) / 2;
    ctx.font = `bold ${CAPTION_PX}px "Courier New", monospace`;
    // Drawn dark-on-light rather than straight onto the terrain: the map under
    // a marker is snow, grass or rock depending where it was dropped, and a
    // single text colour is illegible over at least one of them. A pill sized
    // to the text is one measure and no layout.
    const width = ctx.measureText(caption).width + 12;
    ctx.fillStyle = 'rgba(12, 12, 18, 0.82)';
    ctx.fillRect(cx - width / 2, baseline - CAPTION_PX * 0.72, width, CAPTION_PX * 1.4);
    ctx.fillStyle = 'rgba(244, 244, 248, 0.96)';
    ctx.fillText(caption, cx, baseline);
  }

  texture.needsUpdate = true;
  textures.set(key, texture);
  return texture;
}

const materials = new Map<string, THREE.SpriteMaterial>();

function markerMaterial(kind: MapMarkerKind, caption: string): THREE.SpriteMaterial {
  const key = `${kind}|${caption}`;
  const cached = materials.get(key);
  if (cached) return cached;
  const material = new THREE.SpriteMaterial({
    map: markerTexture(kind, caption),
    depthTest: false,
    transparent: true,
  });
  materials.set(key, material);
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

        const caption = markerCaption(marker);
        let sprite = sprites[i];
        if (!sprite) {
          sprite = new THREE.Sprite();
          sprite.renderOrder = 21;
          sprites.push(sprite);
          group.add(sprite);
        }
        // Reused across renders, so both the material and the scale may need
        // swapping for whatever now occupies this slot -- a captioned marker's
        // sprite is wider, and a slot that held one and now holds a plain
        // marker would otherwise stay stretched.
        sprite.material = markerMaterial(marker.kind, caption);
        if (caption === '') sprite.scale.set(BILLBOARD_SIZE, BILLBOARD_SIZE, 1);
        else sprite.scale.set((BILLBOARD_SIZE * CAPTION_W) / TEXTURE_PX, (BILLBOARD_SIZE * CAPTION_H) / TEXTURE_PX, 1);
        sprite.position.set(
          marker.x,
          ground + STEM_HEIGHT - (caption === '' ? 0 : CAPTION_DISC_DROP),
          marker.z,
        );
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
