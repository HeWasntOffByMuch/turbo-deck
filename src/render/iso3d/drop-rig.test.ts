/**
 * The drop's three meshes (spec 154).
 *
 * three.js builds geometry and materials with no GL context, so the half of
 * this file a headless test can reach is the half worth reaching: that the rig
 * builds for every tier, that `flare` actually moves the halo rather than being
 * accepted and ignored, and that disposing it releases what it made.
 *
 * What it deliberately does not claim is that any of this *looks* right. That
 * is a picture, and a picture is not something a test asserts.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { RARITY_IDS } from '../../server/data/items.js';
import { DropRig } from './drop-rig.js';

/** The halo is the additive sphere: the one mesh whose scale tracks the flare. */
function halo(rig: DropRig): THREE.Mesh {
  const meshes = rig.group.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);
  const found = meshes.find((mesh) => mesh.geometry instanceof THREE.SphereGeometry);
  if (!found) throw new Error('no halo');
  return found;
}

describe('the drop rig', () => {
  it('builds for every tier', () => {
    for (const rarity of RARITY_IDS) {
      const rig = new DropRig(rarity);
      expect(rig.group.children).toHaveLength(3);
      rig.dispose();
    }
  });

  it('gives each tier its own colour', () => {
    const colors = RARITY_IDS.map((rarity) => {
      const rig = new DropRig(rarity);
      const material = halo(rig).material as THREE.MeshBasicMaterial;
      const hex = material.color.getHex();
      rig.dispose();
      return hex;
    });
    expect(new Set(colors).size).toBe(RARITY_IDS.length);
  });

  it('grows and brightens the halo with the flare, and shrinks it back', () => {
    const rig = new DropRig('rare');
    const lit = halo(rig);

    rig.update(1 / 60, 0);
    const dimScale = lit.scale.x;
    const dimOpacity = (lit.material as THREE.MeshBasicMaterial).opacity;

    rig.update(1 / 60, 1);
    expect(lit.scale.x).toBeGreaterThan(dimScale);
    expect((lit.material as THREE.MeshBasicMaterial).opacity).toBeGreaterThan(dimOpacity);

    rig.update(1 / 60, 0);
    expect(lit.scale.x).toBeCloseTo(dimScale, 9);
    rig.dispose();
  });

  /** A flare outside 0..1 is a bug upstream, not a reason to draw a huge halo. */
  it('clamps a nonsense flare rather than passing it through', () => {
    const rig = new DropRig('exceptional');
    const lit = halo(rig);
    rig.update(1 / 60, 1);
    const peak = lit.scale.x;
    rig.update(1 / 60, 50);
    expect(lit.scale.x).toBeCloseTo(peak, 9);
    rig.update(1 / 60, -3);
    expect(lit.scale.x).toBeLessThan(peak);
    expect((lit.material as THREE.MeshBasicMaterial).opacity).toBeGreaterThanOrEqual(0);
    rig.dispose();
  });

  it('keeps turning and bobbing after the reveal has settled', () => {
    // A drop that stopped moving when it revealed would read as having broken.
    const rig = new DropRig('common');
    const item = rig.group.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.geometry instanceof THREE.OctahedronGeometry,
    );
    if (!item) throw new Error('no item mesh');
    rig.update(1 / 60, 0.12);
    const spin = item.rotation.y;
    for (let i = 0; i < 30; i++) rig.update(1 / 60, 0.12);
    expect(item.rotation.y).toBeGreaterThan(spin);
    rig.dispose();
  });

  it('hovering changes the ring and nothing else', () => {
    const rig = new DropRig('rare');
    const lit = halo(rig);
    rig.update(1 / 60, 0.5);
    const haloScale = lit.scale.x;

    rig.setHovered(true);
    rig.update(1 / 60, 0.5);
    expect(lit.scale.x).toBeCloseTo(haloScale, 9);

    const ring = rig.group.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.geometry instanceof THREE.RingGeometry,
    );
    if (!ring) throw new Error('no ring');
    const hoveredOpacity = (ring.material as THREE.MeshBasicMaterial).opacity;
    rig.setHovered(false);
    rig.update(1 / 60, 0.5);
    expect((ring.material as THREE.MeshBasicMaterial).opacity).toBeLessThan(hoveredOpacity);
    rig.dispose();
  });

  it('disposes everything it made', () => {
    const rig = new DropRig('rare');
    const disposed = new Set<unknown>();
    for (const child of rig.group.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const geometry = child.geometry;
      const material = child.material as THREE.Material;
      geometry.addEventListener('dispose', () => disposed.add(geometry));
      material.addEventListener('dispose', () => disposed.add(material));
    }
    rig.dispose();
    expect(disposed.size).toBe(6);
  });
});
