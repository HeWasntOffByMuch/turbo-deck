import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { attachHighlight, highlightEmissive, HOVER_BRIGHTNESS, type HighlightHandle } from './highlight.js';
import { box, makeHeadingArrow } from './meshes.js';
import { PlayerRig } from './rigs.js';

/** The single material a one-colour group's handle owns. */
function only(handle: HighlightHandle): THREE.MeshLambertMaterial {
  const material = handle.materials[0];
  if (!material) throw new Error('the highlight owns no materials');
  return material;
}

/** Every lit mesh under `root`, which is what the highlight is meant to cover. */
function litMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  root.traverse((node) => {
    if (node instanceof THREE.Mesh && node.material instanceof THREE.MeshLambertMaterial) {
      found.push(node);
    }
  });
  return found;
}

describe('the hover highlight (spec 095)', () => {
  it('lifts each channel by the brightness, so the hue is untouched', () => {
    const lit = highlightEmissive(new THREE.Color(0.8, 0.4, 0.2), 0.5);
    expect(lit.r).toBeCloseTo(0.4, 6);
    expect(lit.g).toBeCloseTo(0.2, 6);
    expect(lit.b).toBeCloseTo(0.1, 6);
    // The ratios between channels are what "the same colour" means.
    expect(lit.r / lit.g).toBeCloseTo(2, 6);
    expect(lit.g / lit.b).toBeCloseTo(2, 6);
  });

  it('is black at zero brightness, so an un-highlighted rig is exactly its unlit self', () => {
    expect(highlightEmissive(new THREE.Color(0.8, 0.4, 0.2), 0).getHex()).toBe(0x000000);
  });

  it('covers every lit mesh in a rig, and starts dark', () => {
    const rig = new PlayerRig();
    const lit = litMeshes(rig.group);
    expect(lit.length).toBeGreaterThan(0);

    const handle = attachHighlight(rig.group);
    expect(handle.materials.length).toBeGreaterThan(0);
    // Every lit mesh now draws with a material this handle owns.
    for (const mesh of lit) {
      expect(handle.materials).toContain(mesh.material as THREE.MeshLambertMaterial);
    }
    expect(handle.materials.every((m) => m.emissive.getHex() === 0x000000)).toBe(true);
  });

  it('skips unlit flat overlays such as the heading arrow', () => {
    const group = new THREE.Group();
    group.add(makeHeadingArrow());
    expect(attachHighlight(group).materials).toHaveLength(0);
  });

  it('brightens and un-brightens the whole rig together', () => {
    const handle = attachHighlight(new PlayerRig().group);
    handle.setHighlighted(true);
    expect(handle.materials.every((m) => m.emissive.getHex() !== 0x000000)).toBe(true);
    handle.setHighlighted(false);
    expect(handle.materials.every((m) => m.emissive.getHex() === 0x000000)).toBe(true);
  });

  it('emits its own colour, scaled', () => {
    const group = new THREE.Group();
    const mesh = box(10, 20, 30, 0x806040);
    group.add(mesh);
    const handle = attachHighlight(group, 0.5);
    handle.setHighlighted(true);
    const material = only(handle);
    expect(material.color.getHex()).toBe(0x806040);
    expect(material.emissive.r).toBeCloseTo(material.color.r * 0.5, 6);
    expect(material.emissive.g).toBeCloseTo(material.color.g * 0.5, 6);
    expect(material.emissive.b).toBeCloseTo(material.color.b * 0.5, 6);
  });

  it('gives the rig materials of its own, so a shared cached colour is not lit scene-wide', () => {
    // `flatMaterial` caches on colour alone, so these two start out sharing one
    // material object -- exactly the situation that made an in-place emissive a
    // scenery-wide light switch.
    const mine = new THREE.Group();
    const theirs = new THREE.Group();
    const yours = box(10, 10, 10, 0x334455);
    const others = box(10, 10, 10, 0x334455);
    mine.add(yours);
    theirs.add(others);
    expect(yours.material).toBe(others.material);

    const handle = attachHighlight(mine);
    expect(yours.material).not.toBe(others.material);
    handle.setHighlighted(true);
    expect((others.material as THREE.MeshLambertMaterial).emissive.getHex()).toBe(0x000000);
    expect((others.material as THREE.MeshLambertMaterial).color.getHex()).toBe(0x334455);
  });

  it('clones once per material, not once per mesh, so a rig keeps its own sharing', () => {
    const group = new THREE.Group();
    const a = box(10, 10, 10, 0x223344);
    const b = box(20, 20, 20, 0x223344);
    group.add(a, b);
    const handle = attachHighlight(group);
    expect(handle.materials).toHaveLength(1);
    expect(a.material).toBe(b.material);
  });

  it('covers a block wearing more than one coat role, which arrives as an array', () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), [
      new THREE.MeshLambertMaterial({ color: 0x445566 }),
      new THREE.MeshLambertMaterial({ color: 0x778899 }),
    ]);
    group.add(mesh);
    const handle = attachHighlight(group);
    expect(handle.materials).toHaveLength(2);
    handle.setHighlighted(true);
    const worn = mesh.material as THREE.MeshLambertMaterial[];
    expect(worn.every((m) => m.emissive.getHex() !== 0x000000)).toBe(true);
  });

  it('leaves an unlit entry in a mixed array alone', () => {
    const group = new THREE.Group();
    const unlit = new THREE.MeshBasicMaterial({ color: 0x223344 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), [
      new THREE.MeshLambertMaterial({ color: 0x445566 }),
      unlit,
    ]);
    group.add(mesh);
    expect(attachHighlight(group).materials).toHaveLength(1);
    expect((mesh.material as THREE.Material[])[1]).toBe(unlit);
  });

  it('restores the emissive a material started with, not merely black', () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(4, 4, 4),
      new THREE.MeshLambertMaterial({ color: 0x445566, emissive: 0x110022 }),
    );
    group.add(mesh);
    const handle = attachHighlight(group);
    handle.setHighlighted(true);
    handle.setHighlighted(false);
    expect(only(handle).emissive.getHex()).toBe(0x110022);
  });

  it('defaults to the shared brightness', () => {
    const group = new THREE.Group();
    group.add(box(10, 10, 10, 0x888888));
    const handle = attachHighlight(group);
    handle.setHighlighted(true);
    const material = only(handle);
    expect(material.emissive.r).toBeCloseTo(material.color.r * HOVER_BRIGHTNESS, 6);
  });
});
