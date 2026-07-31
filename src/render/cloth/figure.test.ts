import { describe, expect, it } from 'vitest';
import {
  BONE_COUNT,
  boneRestLayout,
  buildCapsuleDefs,
  FIGURE,
  type CapsuleDef,
  type FigureMetrics,
} from './figure.js';
import { buildRobePieces } from './geometry.js';
import { defaultRobeTuning } from './params.js';

/**
 * The figure's proportions against its garments (spec 037).
 *
 * The test that earns its keep here is the **bind-pose clearance** one. A
 * garment cut inside a body capsule is pushed out on every frame of its life,
 * fighting its own distance constraints, and the symptom is fabric that hangs
 * permanently inflated and permanently strained -- which is close to invisible
 * in a shaded render, because inflated cloth still looks like cloth. It showed
 * up first as a 1.8x strain reading in the debug viewport, with every piece
 * between 1.2 and 7.3 units *inside* the body. Nothing about that is
 * self-correcting, so it is pinned down here.
 */

/** Bind-pose world position of every bone: the rest chain is translation-only. */
function boneRestWorld(f: FigureMetrics): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (const rest of boneRestLayout(f)) {
    const parent = rest.parent < 0 ? { x: 0, y: 0, z: 0 } : out[rest.parent];
    if (!parent) throw new Error(`bone ${rest.bone} listed before its parent`);
    out[rest.bone] = { x: parent.x + rest.x, y: parent.y + rest.y, z: parent.z + rest.z };
  }
  return out;
}

/** Distance from a point to a capsule's axis segment, in bind-pose world space. */
function distanceToAxis(
  cap: CapsuleDef,
  origin: { x: number; y: number; z: number },
  px: number,
  py: number,
  pz: number,
): number {
  const ax = origin.x + cap.ax;
  const ay = origin.y + cap.ay;
  const az = origin.z + cap.az;
  const abx = cap.bx - cap.ax;
  const aby = cap.by - cap.ay;
  const abz = cap.bz - cap.az;
  const len2 = abx * abx + aby * aby + abz * abz;
  let s = len2 > 1e-9 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len2 : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  return Math.hypot(px - (ax + abx * s), py - (ay + aby * s), pz - (az + abz * s));
}

describe('figure', () => {
  const capsules = buildCapsuleDefs(FIGURE);
  const rest = boneRestWorld(FIGURE);

  it('lays out every bone exactly once, parents before children', () => {
    const layout = boneRestLayout(FIGURE);
    expect(layout).toHaveLength(BONE_COUNT);
    const seen = new Set<number>();
    for (const b of layout) {
      expect(seen.has(b.bone)).toBe(false);
      if (b.parent >= 0) expect(seen.has(b.parent)).toBe(true);
      seen.add(b.bone);
    }
    expect(seen.size).toBe(BONE_COUNT);
  });

  it('gives every capsule a real bone and a positive radius', () => {
    expect(capsules.length).toBeGreaterThan(0);
    for (const cap of capsules) {
      expect(cap.bone).toBeGreaterThanOrEqual(0);
      expect(cap.bone).toBeLessThan(BONE_COUNT);
      expect(cap.radius).toBeGreaterThan(0);
      expect(cap.mask).toBeGreaterThan(0);
    }
  });

  it('cuts garments with more clearance than the default collision margin', () => {
    // The whole point of `drapeClearance`: it has to beat the margin the solver
    // pushes cloth out by, or the two settings fight on frame one.
    expect(FIGURE.drapeClearance).toBeGreaterThan(defaultRobeTuning().collisionRadius);
  });

  it('cuts every garment outside every capsule it can collide with', () => {
    const margin = defaultRobeTuning().collisionRadius;
    for (const g of buildRobePieces(FIGURE)) {
      for (let i = 0; i < g.count; i++) {
        const px = g.bind[i * 3] as number;
        const py = g.bind[i * 3 + 1] as number;
        const pz = g.bind[i * 3 + 2] as number;
        for (const cap of capsules) {
          if ((cap.mask & g.colliderMask) === 0) continue;
          const origin = rest[cap.bone];
          if (!origin) throw new Error(`capsule ${cap.name} has no rest bone`);
          const clearance = distanceToAxis(cap, origin, px, py, pz) - (cap.radius + margin);
          expect(
            clearance,
            `${g.name} particle ${i} (row ${Math.floor(i / g.cols)}) starts ` +
              `${(-clearance).toFixed(2)} inside the ${cap.name} capsule`,
          ).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('keeps the sleeves off the torso capsule by masking, not by geometry', () => {
    // A round torso capsule cannot represent a body that arms hang beside, so
    // the sleeves opt out of it. If that mask is ever widened, the clearance
    // test above will start failing -- which is the intent.
    for (const g of buildRobePieces(FIGURE)) {
      if (!g.name.startsWith('sleeve')) continue;
      for (const cap of capsules) {
        if (cap.name !== 'torso' && cap.name !== 'pelvis') continue;
        expect(cap.mask & g.colliderMask).toBe(0);
      }
    }
  });

  it('keeps the whole figure standing on the ground, head above the trees line', () => {
    const foot = FIGURE.hipY - FIGURE.thighLen - FIGURE.shinLen;
    expect(foot).toBeCloseTo(FIGURE.ankleY, 6);
    expect(FIGURE.headY + FIGURE.headRadius).toBeGreaterThan(70);
    expect(FIGURE.headY + FIGURE.headRadius).toBeLessThan(100);
  });
});
