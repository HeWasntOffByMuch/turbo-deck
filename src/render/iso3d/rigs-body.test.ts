import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MechRig, defaultMechAppearance, defaultMechTuning } from './rigs.js';
import { monsterLookFor } from './world/monster-look.js';
import { PALETTE } from './palette.js';

/**
 * The mech's upper body (spec 152), and the half of the small spider that only
 * exists once a rig has actually been built from its look.
 *
 * `monster-look.test.ts` beside this pins what the table says. This pins what
 * happens when `scene.ts` hands it to the rig -- which is where the two ways
 * this can silently fail live: a tuned value that falls outside the rig's own
 * bounds is clamped back on the first frame, and a body colour is only the
 * colour of what is actually drawn if the right meshes were built.
 *
 * Headless like every other rig test: three.js scene-graph objects and pure
 * math, no canvas and no GL context.
 */

/** How `scene.ts` builds a monster's rig, so this tests the real path. */
function rigFor(typeId: string): MechRig {
  const look = monsterLookFor(typeId);
  return new MechRig(typeId, undefined, {
    tuning: { ...defaultMechTuning(), ...look?.tuning },
    ...(look === null ? {} : { appearance: look.appearance }),
  });
}

/** The meshes under the carriage: the upper body, without any of the legs. */
function bodyMeshes(rig: MechRig): THREE.Mesh[] {
  const carriage = rig.group.children.find((child) => child.type === 'Group');
  const found: THREE.Mesh[] = [];
  carriage?.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) found.push(node as THREE.Mesh);
  });
  return found;
}

/** Every mesh in the rig: the upper body and all three bones of every leg. */
function allMeshes(rig: MechRig): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  rig.group.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) found.push(node as THREE.Mesh);
  });
  return found;
}

function channels(mesh: THREE.Mesh): readonly number[] {
  const hex = (mesh.material as THREE.MeshLambertMaterial).color.getHex();
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

/** Walk the rig forward a while, which is when the tuning is sanitized. */
function walk(rig: MechRig, frames: number): void {
  let x = 0;
  for (let i = 0; i < frames; i++) {
    x += 1.9;
    rig.update(1 / 60, { x, y: 0 }, 0);
  }
}

/** The femur's colour: the one bone the rig draws in the leg colour undarkened. */
function femurColor(rig: MechRig): number {
  const bodies = bodyMeshes(rig).length;
  const material = allMeshes(rig)[bodies + 1]?.material as THREE.MeshLambertMaterial;
  return material.color.getHex();
}

describe('the mech body', () => {
  it('draws the chassis, its plate, a head and an eye by default', () => {
    // What every monster without a look row still gets, unchanged.
    expect(bodyMeshes(new MechRig('grazer'))).toHaveLength(4);
    expect(
      bodyMeshes(new MechRig('grazer', 0, { appearance: defaultMechAppearance(0x808080) })),
    ).toHaveLength(4);
  });

  it('draws a sphere body as one part and nothing else', () => {
    // The plate, the head and the eye exist to say which way a chassis points.
    // A round body says it with its legs, and a black one cannot say it at all.
    const appearance = { ...defaultMechAppearance(0x808080), shape: 'sphere' as const };
    expect(bodyMeshes(new MechRig('x', 0, { appearance }))).toHaveLength(1);
  });

  it('colours the legs off the body unless the look says otherwise', () => {
    const auto = new MechRig('x', 0xc0c0c0);
    const stated = new MechRig('x', 0, {
      appearance: { ...defaultMechAppearance(0xc0c0c0), legColor: 0x102030 },
    });
    expect(femurColor(auto)).not.toBe(0xc0c0c0);
    expect(femurColor(stated)).toBe(0x102030);
  });
});

/**
 * The half the movement sandbox needs (spec 152): both records are read every
 * frame, so an edit while the rig is running has to reach the meshes.
 */
describe('a live appearance', () => {
  it('swaps the body when the shape changes, without touching the legs', () => {
    const rig = new MechRig('x', 0xc0c0c0);
    walk(rig, 30);
    expect(bodyMeshes(rig)).toHaveLength(4);

    rig.appearance.shape = 'sphere';
    walk(rig, 1);
    expect(bodyMeshes(rig)).toHaveLength(1);
    expect(allMeshes(rig)).toHaveLength(1 + 3 * 4);
  });

  it('repaints the body and the legs when the colours change', () => {
    const rig = new MechRig('x', 0xc0c0c0);
    walk(rig, 30);

    rig.appearance.bodyColor = 0x203040;
    rig.appearance.legColor = 0x405060;
    walk(rig, 1);
    expect((bodyMeshes(rig)[0]?.material as THREE.MeshLambertMaterial).color.getHex()).toBe(0x203040);
    expect(femurColor(rig)).toBe(0x405060);
  });

  /**
   * Walk two identical rigs in lockstep, edit one of them, step both again, and
   * hand back where each one's feet ended up.
   *
   * A control rather than a tolerance, because a foot mid-swing travels several
   * units in a frame all by itself -- so "did the edit move it" cannot be asked
   * of one rig's before and after. Against a control it is asked exactly: same
   * seedless rig, same steps, so any difference at all is the edit's.
   */
  function stepAgainstControl(edit: (rig: MechRig) => void): {
    edited: readonly THREE.Vector3[];
    control: readonly THREE.Vector3[];
  } {
    const appearance = { ...defaultMechAppearance(0xc0c0c0), shape: 'sphere' as const };
    const edited = new MechRig('x', 0, { appearance: { ...appearance } });
    const control = new MechRig('x', 0, { appearance: { ...appearance } });
    let x = 0;
    for (let i = 0; i < 90; i++) {
      x += 1.9;
      edited.update(1 / 60, { x, y: 0 }, 0);
      control.update(1 / 60, { x, y: 0 }, 0);
    }
    edit(edited);
    x += 1.9;
    edited.update(1 / 60, { x, y: 0 }, 0);
    control.update(1 / 60, { x, y: 0 }, 0);
    return {
      edited: edited.debugSnapshot().legs.map((leg) => leg.foot.clone()),
      control: control.debugSnapshot().legs.map((leg) => leg.foot.clone()),
    };
  }

  it('does not re-plant the feet to change a colour', () => {
    // A repaint that rebuilt the legs would drop every foot back onto its rest
    // spot, so picking a colour would make the unit hop where it stands.
    const { edited, control } = stepAgainstControl((rig) => {
      rig.appearance.legColor = 0x405060;
    });
    edited.forEach((foot, i) => {
      expect(foot.distanceTo(control[i] as THREE.Vector3), `leg ${i}`).toBe(0);
    });
  });

  it('resizes the body against its legs without moving the legs', () => {
    const appearance = { ...defaultMechAppearance(0xc0c0c0), shape: 'sphere' as const };
    const rig = new MechRig('x', 0, { appearance });
    const bodyHeight = (): number => {
      const box = new THREE.Box3().setFromObject(bodyMeshes(rig)[0] as THREE.Mesh);
      return box.max.y - box.min.y;
    };
    walk(rig, 60);
    const before = bodyHeight();

    rig.tuning.bodySize = 2.5;
    rig.update(1 / 60, { x: 1.9 * 61, y: 0 }, 0);
    expect(bodyHeight() / before).toBeCloseTo(2.5, 5);

    // And the legs are untouched: `bodySize` changes the body against its legs,
    // and `sizeScale` is the knob that moves both.
    const { edited, control } = stepAgainstControl((r) => {
      r.tuning.bodySize = 2.5;
    });
    edited.forEach((foot, i) => {
      expect(foot.distanceTo(control[i] as THREE.Vector3), `leg ${i}`).toBe(0);
    });
  });
});

describe('the small spider', () => {
  it('is one black sphere on legs that are black too', () => {
    const rig = rigFor('small_spider');
    expect(bodyMeshes(rig)).toHaveLength(1);

    const meshes = allMeshes(rig);
    // Body + three bones per leg. Four legs, because `numLegs` was not one of
    // the values the spider was tuned to.
    expect(meshes).toHaveLength(1 + 3 * 4);
    const brightest = Math.max(...[16, 8, 0].map((s) => (PALETTE.enemySpider >> s) & 0xff));
    for (const mesh of meshes) {
      // Reads black: every mesh at or under the palette's own brightest channel,
      // which is what "the body is black and the legs are black as well" means
      // once the rig has darkened a bone or two off it.
      for (const value of channels(mesh)) expect(value).toBeLessThanOrEqual(brightest);
    }
    // And not painted out to nothing -- a body with no lit facet is a hole.
    expect(channels(meshes[0] as THREE.Mesh).some((value) => value > 0)).toBe(true);
  });

  it('keeps the tuned values through the rig’s own sanitizer', () => {
    // Every field is clamped to a safe range on the frame it is used, so a
    // tuned value outside one is silently replaced and the spider draws at a
    // size nobody chose.
    const rig = rigFor('small_spider');
    walk(rig, 240);
    expect(rig.tuning.sizeScale).toBe(0.6);
    expect(rig.tuning.bodySize).toBe(1.25);
    expect(rig.tuning.raisedLegs).toBe(0);
    expect(rig.tuning.pitchGain).toBe(0.0006);
    expect(rig.tuning.rollGain).toBe(0.03);
    expect(rig.tuning.coxaReach).toBe(0);
    expect(rig.tuning.femurScale).toBe(1.05);
  });

  it('leaves every other tuning field at the shared default', () => {
    const rig = rigFor('small_spider');
    const defaults = defaultMechTuning();
    const tuned = new Set([
      'sizeScale',
      'bodySize',
      'raisedLegs',
      'pitchGain',
      'rollGain',
      'coxaReach',
      'femurScale',
    ]);
    for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
      if (tuned.has(key)) continue;
      expect(rig.tuning[key], key).toBe(defaults[key]);
    }
  });

  it('draws a body the same order of size as the collider the sim gives it', () => {
    // The two halves are authored in different files and nothing forces them to
    // agree, so the failure worth pinning is a 12-unit collider under a body
    // drawn at full mech size. The bound is tight enough to mean it: this rig
    // measures 27.6 across the feet at the tuned 0.6 and 42.9 at 1.0, so losing
    // `sizeScale` fails here rather than in a screenshot nobody takes.
    const rig = rigFor('small_spider');
    walk(rig, 120);
    const box = new THREE.Box3().setFromObject(rig.group);
    const halfWidth = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
    expect(halfWidth).toBeGreaterThan(12);
    expect(halfWidth).toBeLessThan(36);
    // And it stands lower than the player it is coming for (a cow at ~60).
    expect(box.max.y - box.min.y).toBeLessThan(35);
  });
});

describe('a monster with no look row', () => {
  it('builds exactly what it built before the table existed', () => {
    const plain = new MechRig('grazer');
    const viaTable = rigFor('grazer');
    expect(bodyMeshes(viaTable)).toHaveLength(bodyMeshes(plain).length);
    expect(viaTable.tuning).toEqual(plain.tuning);
    const color = (rig: MechRig): number =>
      ((bodyMeshes(rig)[0] as THREE.Mesh).material as THREE.MeshLambertMaterial).color.getHex();
    expect(color(viaTable)).toBe(color(plain));
    // And the palette's spider black is not what it drew.
    expect(color(viaTable)).not.toBe(PALETTE.enemySpider);
  });
});
