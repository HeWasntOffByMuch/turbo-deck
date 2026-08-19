/**
 * The drop's three meshes (spec 158).
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
import { THEME } from '../../ui/theme/theme.js';
import { rarityToken } from '../../ui/widgets/item-slot.js';
import { DropRig } from './drop-rig.js';

/** The halo is the additive sphere: the one mesh whose scale tracks the flare. */
function halo(rig: DropRig): THREE.Mesh {
  const meshes = rig.group.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);
  // The inner of the two shells: the first one added, and the one whose radius
  // the flare is quoted in.
  const found = meshes.find((mesh) => mesh.geometry instanceof THREE.SphereGeometry);
  if (!found) throw new Error('no halo');
  return found;
}

describe('the drop rig', () => {
  it('builds for every tier', () => {
    for (const rarity of RARITY_IDS) {
      const rig = new DropRig(rarity);
      expect(rig.group.children).toHaveLength(4);
      rig.dispose();
    }
  });

  /**
   * The rule the whole reveal rests on, expressed where it could be broken by a
   * one-line edit: a rig is built in the neutral colour whatever its tier, so
   * the tier is not readable off a drop that has not revealed.
   */
  it('builds every tier in the same neutral colour', () => {
    const colors = RARITY_IDS.map((rarity) => {
      const rig = new DropRig(rarity);
      const hex = (halo(rig).material as THREE.MeshBasicMaterial).color.getHex();
      rig.dispose();
      return hex;
    });
    expect(new Set(colors).size).toBe(1);
  });

  it('gives each tier its own colour once the mix arrives', () => {
    const colors = RARITY_IDS.map((rarity) => {
      const rig = new DropRig(rarity);
      rig.setTierMix(1);
      const hex = (halo(rig).material as THREE.MeshBasicMaterial).color.getHex();
      rig.dispose();
      return hex;
    });
    expect(new Set(colors).size).toBe(RARITY_IDS.length);
  });

  /**
   * The grass and the bag say the same thing (spec 185).
   *
   * The two used to be two tables, and this is the assertion that keeps them one
   * -- retune the interface's `rarityRare` and this fails until the drop follows,
   * which is the whole reason the palette grew by three rather than the drop rig
   * keeping its own copy.
   */
  it('is the colour the interface draws the same item in', () => {
    for (const rarity of RARITY_IDS) {
      const rig = new DropRig(rarity);
      rig.setTierMix(1);
      const { r, g, b } = THEME.color(rarityToken(rarity));
      expect((halo(rig).material as THREE.MeshBasicMaterial).color.getHex(), rarity).toBe(
        (r << 16) | (g << 8) | b,
      );
      rig.dispose();
    }
  });

  it('blends toward the tier rather than snapping to it', () => {
    const rig = new DropRig('exceptional');
    const material = halo(rig).material as THREE.MeshBasicMaterial;
    const neutral = material.color.getHex();
    rig.setTierMix(0.5);
    const half = material.color.getHex();
    rig.setTierMix(1);
    const full = material.color.getHex();
    expect(half).not.toBe(neutral);
    expect(half).not.toBe(full);
    // ...and it goes back, so a mix that fell is not a one-way door.
    rig.setTierMix(0);
    expect(material.color.getHex()).toBe(neutral);
    rig.dispose();
  });

  it('scales and lifts the object with the beat, together', () => {
    const rig = new DropRig('rare');
    const item = rig.group.children.find(
      (child): child is THREE.Mesh =>
        child instanceof THREE.Mesh && child.geometry instanceof THREE.OctahedronGeometry,
    );
    if (!item) throw new Error('no item mesh');

    rig.update(0, 0.5, 1);
    const restScale = item.scale.x;
    const restY = item.position.y;

    // Same `dt` of zero, so the idle bob cannot be what moved it.
    rig.update(0, 0.5, 1.13);
    expect(item.scale.x).toBeGreaterThan(restScale);
    expect(item.position.y).toBeGreaterThan(restY);

    rig.update(0, 0.5, 1);
    expect(item.scale.x).toBeCloseTo(restScale, 9);
    expect(item.position.y).toBeCloseTo(restY, 9);
    rig.dispose();
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

  it('grows the whole rig and fades it as the pop runs', () => {
    const rig = new DropRig('rare');
    const lit = halo(rig);

    rig.update(0, 0.45, 1);
    const restingAlpha = (lit.material as THREE.MeshBasicMaterial).opacity;
    expect(rig.group.scale.x).toBeCloseTo(1, 9);

    rig.setPop({ scale: 1.8, alpha: 0.4 });
    rig.update(0, 0.45, 1);
    expect(rig.group.scale.x).toBeCloseTo(1.8, 9);
    expect((lit.material as THREE.MeshBasicMaterial).opacity).toBeLessThan(restingAlpha);

    // Gone means gone: every surface at zero, the solid one included.
    rig.setPop({ scale: 2.2, alpha: 0 });
    rig.update(0, 0.45, 1);
    for (const child of rig.group.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      expect((child.material as THREE.Material & { opacity: number }).opacity).toBe(0);
    }
    rig.dispose();
  });

  /** A drop merely lying there pays nothing for a blend mode it does not use. */
  it('leaves the object opaque until a pop actually starts', () => {
    const rig = new DropRig('common');
    rig.update(0, 0.12, 1);
    const item = rig.group.children.find(
      (child): child is THREE.Mesh =>
        child instanceof THREE.Mesh && child.geometry instanceof THREE.OctahedronGeometry,
    );
    expect((item?.material as THREE.Material | undefined)?.transparent).toBe(false);
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
    expect(disposed.size).toBe(8);
  });
});
