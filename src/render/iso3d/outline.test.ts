import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { attachOutline, MAX_OUTLINE_RATIO, outlineScale } from './outline.js';
import { box, makeHeadingArrow } from './meshes.js';
import { PlayerRig } from './rigs.js';

/** Meshes under `root` that are outline shells (unlit white, back faces). */
function shells(root: THREE.Object3D): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  root.traverse((node) => {
    if (node instanceof THREE.Mesh && node.material instanceof THREE.MeshBasicMaterial && node.material.side === THREE.BackSide) {
      found.push(node);
    }
  });
  return found;
}

describe('unit hover outlines (spec 039)', () => {
  it('outlines every lit mesh in a rig, and starts hidden', () => {
    const rig = new PlayerRig();
    const lit: THREE.Mesh[] = [];
    rig.group.traverse((node) => {
      if (node instanceof THREE.Mesh && node.material instanceof THREE.MeshLambertMaterial) lit.push(node);
    });

    const handle = attachOutline(rig.group);
    expect(lit.length).toBeGreaterThan(0);
    expect(handle.meshes).toHaveLength(lit.length);
    expect(handle.meshes.every((m) => !m.visible)).toBe(true);
    // One shell per lit mesh, each parented to the mesh it traces so it follows
    // that part's animation.
    for (const mesh of lit) expect(mesh.children.filter((c) => handle.meshes.includes(c as THREE.Mesh))).toHaveLength(1);
  });

  it('skips unlit flat overlays such as the heading arrow', () => {
    const group = new THREE.Group();
    group.add(makeHeadingArrow());
    expect(attachOutline(group).meshes).toHaveLength(0);
  });

  it('toggles the whole outline together', () => {
    const handle = attachOutline(new PlayerRig().group);
    handle.setVisible(true);
    expect(handle.meshes.every((m) => m.visible)).toBe(true);
    handle.setVisible(false);
    expect(handle.meshes.every((m) => m.visible)).toBe(false);
  });

  it('does not outline the outlines when called on an already-outlined rig', () => {
    const rig = new PlayerRig();
    const first = attachOutline(rig.group);
    expect(shells(rig.group)).toHaveLength(first.meshes.length);
  });

  it('inflates each axis by the same absolute amount, so a long bone gets an even border', () => {
    const thickness = 2;
    const scale = outlineScale(new THREE.Vector3(30, 90, 30), thickness);
    // A uniform scale would give the long axis a border 3x the short axes'.
    expect((scale.x - 1) * 30).toBeCloseTo(2 * thickness, 6);
    expect((scale.y - 1) * 90).toBeCloseTo(2 * thickness, 6);
    expect(scale.y).toBeLessThan(scale.x);
  });

  it('caps the inflation, so a tiny part is rimmed rather than blown up into a blob', () => {
    // A 4-unit foot would otherwise be scaled to 2x by the body's thickness, and
    // the swollen shell would cover the model instead of tracing it.
    const scale = outlineScale(new THREE.Vector3(4, 4, 4), 2);
    expect(scale.x).toBe(MAX_OUTLINE_RATIO);
    expect(scale.y).toBe(MAX_OUTLINE_RATIO);
    expect(scale.z).toBe(MAX_OUTLINE_RATIO);
  });

  it('leaves a degenerate (flat) axis unscaled instead of blowing it up', () => {
    expect(outlineScale(new THREE.Vector3(10, 0, 10), 2).y).toBe(1);
  });

  it('traces the mesh it is attached to (same geometry, back faces only)', () => {
    const group = new THREE.Group();
    const mesh = box(10, 20, 30, 0x445566);
    group.add(mesh);
    const shell = attachOutline(group).meshes[0];
    expect(shell?.geometry).toBe(mesh.geometry);
    expect((shell?.material as THREE.MeshBasicMaterial).side).toBe(THREE.BackSide);
    expect((shell?.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xffffff);
  });
});
