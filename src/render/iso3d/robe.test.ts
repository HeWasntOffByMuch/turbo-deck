import { describe, expect, it } from 'vitest';
import { defaultRobeTuning, type RobeTuning } from '../cloth/params.js';
import { RobeRig } from './robe.js';

/**
 * The whole robed character, end to end (spec 037).
 *
 * `cloth/solver.test.ts` proves the physics in isolation; this proves the
 * *binding* -- the skinned reference pose, the collider refresh, the motion
 * observation, the jump impulses -- by driving a real {@link RobeRig} through
 * scripted movement. It runs headless: three.js's `Object3D`, `Matrix4` and
 * `BufferAttribute` are plain JavaScript, and nothing here renders, so the same
 * code path the browser runs is exercised in Node with no canvas.
 *
 * The assertions are the qualitative claims the character is supposed to make
 * good on -- fabric lags when you accelerate, settles when you stop, never ends
 * up inside the body, never stretches past its cap -- expressed as numbers.
 */

const DT = 1 / 60;

/** Drive the rig along a straight line at `speed`, returning the final position. */
function walk(rig: RobeRig, speed: number, seconds: number, from = { x: 500, y: 500 }, ry = 0): { x: number; y: number } {
  const pos = { ...from };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    pos.x += Math.cos(-ry) * speed * DT;
    pos.y += Math.sin(-ry) * speed * DT;
    rig.update(DT, pos, ry);
  }
  return pos;
}

/** Hold still at `pos` for `seconds`. */
function stand(rig: RobeRig, pos: { x: number; y: number }, seconds: number, ry = 0): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) rig.update(DT, pos, ry);
}

function quietTuning(): RobeTuning {
  // No wind and no idle sway: both are deliberately never-settling, which would
  // drown out the effects under test.
  const t = defaultRobeTuning();
  t.windEnabled = 0;
  t.windStrength = 0;
  t.gustStrength = 0;
  t.idleSway = 0;
  return t;
}

/** Every simulated particle across every garment, in rig-local space. */
function allLocal(rig: RobeRig): number[] {
  const out: number[] = [];
  for (const piece of rig.clothPieces) out.push(...piece.local);
  return out;
}

/** Mean rig-local position of a garment's free hem row. */
function hemCentre(rig: RobeRig, name: string): { x: number; y: number; z: number } {
  const piece = rig.clothPieces.find((p) => p.geo.name === name);
  if (!piece) throw new Error(`no piece ${name}`);
  const { geo, local } = piece;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let c = 0; c < geo.cols; c++) {
    const i = ((geo.rows - 1) * geo.cols + c) * 3;
    x += local[i] as number;
    y += local[i + 1] as number;
    z += local[i + 2] as number;
  }
  return { x: x / geo.cols, y: y / geo.cols, z: z / geo.cols };
}

describe('RobeRig', () => {
  it('settles into a finite, unstretched hang and stays there', () => {
    const rig = new RobeRig({ tuning: quietTuning() });
    stand(rig, { x: 500, y: 500 }, 6);

    for (const piece of rig.clothPieces) {
      for (const v of piece.solver.pos) expect(Number.isFinite(v)).toBe(true);
      expect(piece.solver.maxStretchRatio()).toBeLessThan(rig.tuning.maxStretch + 1e-6);
    }

    // It settles, but it is never *frozen*: the figure breathes, and that alone
    // keeps a couple of units of motion in the hem forever. That is deliberate
    // (a mannequin-still robe reads as a static mesh), so what is asserted is
    // that the motion stays small and bounded rather than that it stops.
    const before = allLocal(rig);
    stand(rig, { x: 500, y: 500 }, 2);
    const after = allLocal(rig);
    let drift = 0;
    for (let i = 0; i < before.length; i++) {
      drift = Math.max(drift, Math.abs((after[i] as number) - (before[i] as number)));
    }
    expect(drift).toBeGreaterThan(0);
    expect(drift).toBeLessThan(3);
  });

  it('hangs the lower robe below the waist when standing still', () => {
    const rig = new RobeRig({ tuning: quietTuning() });
    stand(rig, { x: 500, y: 500 }, 6);
    const hem = hemCentre(rig, 'robe');
    // Near the floor, and roughly centred under the figure rather than pushed
    // off to one side by a stray force.
    expect(hem.y).toBeGreaterThan(0);
    expect(hem.y).toBeLessThan(12);
    expect(Math.hypot(hem.x, hem.z)).toBeLessThan(6);
  });

  it('trails the fabric behind a running figure, and recovers when it stops', () => {
    const rig = new RobeRig({ tuning: quietTuning() });
    stand(rig, { x: 500, y: 500 }, 6);
    const restCape = hemCentre(rig, 'cape');

    // Run along +x (local forward), so trailing fabric moves to local -x.
    const end = walk(rig, 260, 1.5);
    const runningCape = hemCentre(rig, 'cape');
    expect(runningCape.x).toBeLessThan(restCape.x - 3);

    stand(rig, end, 6);
    expect(hemCentre(rig, 'cape').x).toBeCloseTo(restCape.x, 0);
  });

  it('lags harder the more inertia it is given', () => {
    // Peak lag over the whole sprint start, not lag at one arbitrary instant:
    // the fabric oscillates on its way to a trailing steady state, so a single
    // sample can catch a rebound and rank the two settings backwards.
    const peakLag = (inertiaMultiplier: number): number => {
      const t = quietTuning();
      t.inertiaMultiplier = inertiaMultiplier;
      const rig = new RobeRig({ tuning: t });
      stand(rig, { x: 500, y: 500 }, 6);
      const rest = hemCentre(rig, 'cape').x;
      const pos = { x: 500, y: 500 };
      let peak = 0;
      for (let i = 0; i < 120; i++) {
        pos.x += 320 * DT;
        rig.update(DT, pos, 0);
        peak = Math.max(peak, rest - hemCentre(rig, 'cape').x);
      }
      return peak;
    };
    const none = peakLag(0);
    const some = peakLag(1);
    const lots = peakLag(3);
    expect(some).toBeGreaterThan(none);
    expect(lots).toBeGreaterThan(some);
  });

  it('keeps every particle out of the body while walking', () => {
    const rig = new RobeRig({ tuning: quietTuning() });
    const pos = { x: 500, y: 500 };
    const caps = rig.humanoid.colliders;
    let worst = Infinity;

    for (let i = 0; i < 480; i++) {
      pos.x += 180 * DT;
      rig.update(DT, pos, 0);
      if (i < 120) continue; // let it settle before judging
      for (const piece of rig.clothPieces) {
        const { geo, solver } = piece;
        for (let p = 0; p < geo.count; p++) {
          if (geo.pinned[p]) continue;
          for (let j = 0; j < caps.count; j++) {
            if (((caps.mask[j] as number) & geo.colliderMask) === 0) continue;
            worst = Math.min(worst, distanceOutside(solver.pos, p, caps, j));
          }
        }
      }
    }
    // A tether clamp can graze a particle a little way back inside; a real
    // failure looks like whole rows sitting units deep in the torso.
    expect(worst).toBeGreaterThan(-1);
  });

  it('never exceeds maxStretch through a hard turn', () => {
    const rig = new RobeRig({ tuning: quietTuning() });
    const pos = { x: 500, y: 500 };
    stand(rig, pos, 3);
    for (let i = 0; i < 600; i++) {
      const ry = i * 0.09; // ~5 deg per frame: far faster than the sim can turn
      pos.x += Math.cos(-ry) * 240 * DT;
      pos.y += Math.sin(-ry) * 240 * DT;
      rig.update(DT, pos, ry);
      // The guarantee is the *tether*: distance from each particle to its
      // attachment ring. Individual links are soft constraints and can sit over
      // the cap for a frame under a violent yank; the tether cannot.
      for (const piece of rig.clothPieces) {
        const { geo, solver } = piece;
        for (let p = 0; p < geo.count; p++) {
          if (geo.pinned[p]) continue;
          const a = (geo.anchor[p] as number) * 3;
          const d = Math.hypot(
            (solver.pos[p * 3] as number) - (solver.pos[a] as number),
            (solver.pos[p * 3 + 1] as number) - (solver.pos[a + 1] as number),
            (solver.pos[p * 3 + 2] as number) - (solver.pos[a + 2] as number),
          );
          expect(d).toBeLessThanOrEqual((geo.anchorRest[p] as number) * rig.tuning.maxStretch + 1e-6);
        }
      }
    }
  });

  it('lifts the figure on a jump and returns it to the ground', () => {
    const rig = new RobeRig({ tuning: quietTuning() });
    const pos = { x: 500, y: 500 };
    stand(rig, pos, 3);
    expect(rig.jump()).toBe(true);
    expect(rig.jump()).toBe(false); // no double jumps

    let peak = 0;
    for (let i = 0; i < 240; i++) {
      rig.update(DT, pos, 0);
      peak = Math.max(peak, rig.humanoid.liftY);
    }
    expect(peak).toBeGreaterThan(rig.tuning.jumpHeight * 0.85);
    expect(rig.humanoid.liftY).toBe(0);
    expect(rig.debugSnapshot().jumpState).toBe('grounded');
  });

  it('flares the robe on landing from a fall', () => {
    const rig = new RobeRig({ tuning: quietTuning() });
    const pos = { x: 500, y: 500 };
    stand(rig, pos, 6);
    const restHem = hemCentre(rig, 'robe').y;

    expect(rig.drop(200)).toBe(true);
    // Fall to the ground, then catch the frames just after impact.
    let landed = -1;
    for (let i = 0; i < 400 && landed < 0; i++) {
      rig.update(DT, pos, 0);
      if (rig.humanoid.jump.lastEvents.landingSpeed > 0) landed = i;
    }
    expect(landed).toBeGreaterThan(0);
    let peak = restHem;
    for (let i = 0; i < 20; i++) {
      rig.update(DT, pos, 0);
      peak = Math.max(peak, hemCentre(rig, 'robe').y);
    }
    expect(peak).toBeGreaterThan(restHem + 1);

    // And it comes all the way back down. This is the regression guard for the
    // buckling failure: with too little bend stiffness the hem's vertical chains
    // fold into a wave that satisfies every distance constraint, and the robe
    // stays hitched several units up for good.
    stand(rig, pos, 12);
    expect(hemCentre(rig, 'robe').y).toBeCloseTo(restHem, 0);
  });

  it('blows the fabric downwind and settles again when the wind drops', () => {
    const t = quietTuning();
    const rig = new RobeRig({ tuning: t });
    stand(rig, { x: 500, y: 500 }, 6);
    const rest = hemCentre(rig, 'robe');

    t.windEnabled = 1;
    t.windStrength = 300;
    t.gustStrength = 0;
    t.windTurbulence = 0;
    t.windDirection = 90; // world +z
    stand(rig, { x: 500, y: 500 }, 5);
    expect(hemCentre(rig, 'robe').z).toBeGreaterThan(rest.z + 2);

    t.windEnabled = 0;
    stand(rig, { x: 500, y: 500 }, 10);
    expect(hemCentre(rig, 'robe').z).toBeCloseTo(rest.z, 0);
  });

  it('re-seats the cloth on a teleport instead of stretching it', () => {
    const rig = new RobeRig({ tuning: quietTuning() });
    stand(rig, { x: 500, y: 500 }, 4);
    rig.update(DT, { x: 4000, y: 4000 }, 0);
    for (const piece of rig.clothPieces) {
      for (const v of piece.solver.pos) expect(Number.isFinite(v)).toBe(true);
      // Re-seated on the skinned reference pose. That pose is not perfectly
      // relaxed where a garment spans a joint -- each particle is rigidly bound
      // to one bone, so the sleeve rows either side of a bent elbow start a
      // little apart -- but it is nowhere near the stretch cap, and one frame of
      // solving pulls it in.
      expect(piece.solver.maxStretchRatio()).toBeLessThan(1.3);
    }
    for (let i = 0; i < 10; i++) rig.update(DT, { x: 4000, y: 4000 }, 0);
    for (const piece of rig.clothPieces) {
      expect(piece.solver.maxStretchRatio()).toBeLessThan(1.05);
    }
  });

  it('holds its pose on a paused frame', () => {
    const rig = new RobeRig({ tuning: quietTuning() });
    stand(rig, { x: 500, y: 500 }, 3);
    const before = allLocal(rig);
    rig.update(0, { x: 500, y: 500 }, 0);
    rig.update(Number.NaN, { x: 500, y: 500 }, 0);
    expect(allLocal(rig)).toEqual(before);
  });

  it('survives a non-finite position or heading', () => {
    const rig = new RobeRig({ tuning: quietTuning() });
    stand(rig, { x: 500, y: 500 }, 2);
    rig.update(DT, { x: Number.NaN, y: 500 }, Number.NaN);
    rig.update(DT, { x: 500, y: Number.POSITIVE_INFINITY }, 0);
    stand(rig, { x: 500, y: 500 }, 2);
    for (const v of allLocal(rig)) expect(Number.isFinite(v)).toBe(true);
  });

  it('replays identically from the same inputs', () => {
    const run = (): number[] => {
      const rig = new RobeRig({ tuning: defaultRobeTuning(), windSeed: 99 });
      const pos = { x: 500, y: 500 };
      for (let i = 0; i < 300; i++) {
        const ry = Math.sin(i * 0.02) * 0.9;
        pos.x += Math.cos(-ry) * 200 * DT;
        pos.y += Math.sin(-ry) * 200 * DT;
        if (i === 100) rig.jump();
        if (i === 200) rig.gust(400);
        rig.update(DT, pos, ry);
      }
      return allLocal(rig);
    };
    expect(run()).toEqual(run());
  });

  it('reports a debug snapshot covering every piece', () => {
    const rig = new RobeRig({ tuning: quietTuning() });
    stand(rig, { x: 500, y: 500 }, 2);
    const snap = rig.debugSnapshot();
    expect(snap.pieces.map((p) => p.name)).toEqual(['robe', 'cape', 'hood', 'sleeveL', 'sleeveR']);
    expect(snap.particles).toBe(rig.clothPieces.reduce((n, p) => n + p.geo.count, 0));
    expect(snap.links).toBe(rig.clothPieces.reduce((n, p) => n + p.geo.linkCount, 0));
    for (const p of snap.pieces) expect(p.stretch).toBeGreaterThanOrEqual(1);
    // Reused, not reallocated: the debug view calls this every frame.
    expect(rig.debugSnapshot()).toBe(snap);
  });
});

/** How far outside capsule `j` particle `p` sits (negative means penetrating). */
function distanceOutside(
  pos: Float64Array,
  p: number,
  caps: { a: Float64Array; b: Float64Array; radius: Float64Array },
  j: number,
): number {
  const p3 = p * 3;
  const j3 = j * 3;
  const ax = caps.a[j3] as number;
  const ay = caps.a[j3 + 1] as number;
  const az = caps.a[j3 + 2] as number;
  const abx = (caps.b[j3] as number) - ax;
  const aby = (caps.b[j3 + 1] as number) - ay;
  const abz = (caps.b[j3 + 2] as number) - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  const px = pos[p3] as number;
  const py = pos[p3 + 1] as number;
  const pz = pos[p3 + 2] as number;
  let s = len2 > 1e-9 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len2 : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  const d = Math.hypot(px - (ax + abx * s), py - (ay + aby * s), pz - (az + abz * s));
  return d - (caps.radius[j] as number);
}
