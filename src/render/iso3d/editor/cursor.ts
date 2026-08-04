import * as THREE from 'three';

/**
 * The brush cursor (spec 050) — and the entire gizmo system.
 *
 * A line loop whose vertices are placed on the ground around the brush circle,
 * so the cursor lies *on* the terrain and follows every ridge and hollow inside
 * its footprint.
 *
 * A single flat ring oriented to the surface normal is the obvious build and it
 * does not survive contact with a heightfield: a plane laid against a hillside
 * buries half of itself, and a hillside is the one place a terrain brush is used.
 * This is the same amount of geometry and the same absence of a gizmo framework;
 * it just follows the thing it is measuring.
 */

/** Segments around the ring. Enough that the circle reads as one at any zoom. */
const SEGMENTS = 72;

/** How far the ring floats above the ground, so it is never z-fought by it. */
const LIFT = 1.2;

export interface BrushCursorHandle {
  readonly object: THREE.Object3D;
  /** Redraw the ring at a world point. */
  moveTo(x: number, z: number, radius: number, heightAt: (x: number, z: number) => number): void;
  setVisible(visible: boolean): void;
  /** Tint the ring, e.g. to show which tool is armed. */
  setColor(hex: number): void;
  dispose(): void;
}

export function createBrushCursor(color = 0xffe27a): BrushCursorHandle {
  const positions = new Float32Array(SEGMENTS * 3);
  const attribute = new THREE.BufferAttribute(positions, 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', attribute);
  // The ring is a cursor, not scenery: it must be legible against dark rock and
  // bright snow alike, so it does not take the scene's lighting.
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 });
  const loop = new THREE.LineLoop(geometry, material);
  // It never occludes anything and nothing should occlude it -- a cursor you
  // cannot see behind the hill you are about to sculpt is not a cursor.
  loop.renderOrder = 10;
  material.depthTest = false;
  loop.frustumCulled = false;
  loop.visible = false;

  return {
    object: loop,
    moveTo(x: number, z: number, radius: number, heightAt: (x: number, z: number) => number): void {
      for (let i = 0; i < SEGMENTS; i++) {
        const angle = (i / SEGMENTS) * Math.PI * 2;
        const px = x + Math.cos(angle) * radius;
        const pz = z + Math.sin(angle) * radius;
        positions[i * 3] = px;
        positions[i * 3 + 1] = heightAt(px, pz) + LIFT;
        positions[i * 3 + 2] = pz;
      }
      attribute.needsUpdate = true;
    },
    setVisible(visible: boolean): void {
      loop.visible = visible;
    },
    setColor(hex: number): void {
      material.color.setHex(hex);
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
