import { describe, expect, it } from 'vitest';
import { CapsuleSet, MASK_ALL } from './colliders.js';
import { FIGURE } from './figure.js';
import { buildCape, buildSkirt, type ClothGeometry } from './geometry.js';
import { defaultRobeTuning, sanitizeRobeTuning, type RobeTuning } from './params.js';
import { ClothSolver, createStepContext, type ClothStepContext } from './solver.js';

/**
 * The cloth solver (spec 046). Everything here runs headless: the solver is pure
 * TypeScript over typed arrays, so the properties that actually keep the robe on
 * the character -- it never stretches past its cap, never ends up inside the
 * body, never goes non-finite, and replays identically -- are all assertable in
 * Node without a canvas.
 */

/** A quiet world: no wind, no body motion, the character standing at the origin. */
function quietContext(geo: ClothGeometry, capsules = 0): ClothStepContext {
  const ref = new Float64Array(geo.bind);
  return createStepContext(ref, new CapsuleSet(capsules));
}

function run(solver: ClothSolver, ctx: ClothStepContext, t: RobeTuning, frames: number, dt = 1 / 60): void {
  for (let i = 0; i < frames; i++) {
    ctx.time += dt;
    solver.step(dt, t, ctx);
  }
}

function allFinite(a: Float64Array): boolean {
  for (const v of a) if (!Number.isFinite(v)) return false;
  return true;
}

/** Distance from particle `i` to its tether anchor. */
function anchorDistance(solver: ClothSolver, i: number): number {
  const g = solver.geo;
  const a = (g.anchor[i] as number) * 3;
  const p = solver.pos;
  return Math.hypot(
    (p[i * 3] as number) - (p[a] as number),
    (p[i * 3 + 1] as number) - (p[a + 1] as number),
    (p[i * 3 + 2] as number) - (p[a + 2] as number),
  );
}

describe('ClothSolver', () => {
  it('holds pinned particles exactly on their pin targets', () => {
    const geo = buildCape(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    solver.reset(ctx.ref);
    run(solver, ctx, t, 30);

    for (let i = 0; i < geo.count; i++) {
      if (!geo.pinned[i]) continue;
      for (let k = 0; k < 3; k++) {
        expect(solver.pos[i * 3 + k] as number).toBeCloseTo(ctx.ref[i * 3 + k] as number, 10);
      }
    }
  });

  it('follows the pins when the whole attachment moves', () => {
    const geo = buildCape(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    solver.reset(ctx.ref);

    // Walk the attachment 300 units along +x over a second.
    for (let f = 0; f < 60; f++) {
      for (let i = 0; i < geo.count; i++) ctx.ref[i * 3] = (geo.bind[i * 3] as number) + (f + 1) * 5;
      ctx.time += 1 / 60;
      solver.step(1 / 60, t, ctx);
    }

    // Every particle came along; the free hem lags behind the pinned top edge,
    // which is exactly the secondary motion the whole system exists for.
    const pinX = solver.pos[0] as number;
    const hemX = solver.pos[(geo.rows - 1) * geo.cols * 3] as number;
    expect(pinX).toBeGreaterThan(250);
    expect(hemX).toBeLessThan(pinX);
    expect(hemX).toBeGreaterThan(150);
  });

  it('settles to a still hang under gravity and then stays put', () => {
    const geo = buildCape(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    t.idleSway = 0; // the sway force deliberately never lets it be perfectly still
    solver.reset(ctx.ref);

    run(solver, ctx, t, 30);
    const early = solver.kineticEnergy();
    run(solver, ctx, t, 600);
    const settled = solver.kineticEnergy();
    expect(settled).toBeLessThan(early * 0.05);

    const before = Float64Array.from(solver.pos);
    run(solver, ctx, t, 120);
    for (let i = 0; i < before.length; i++) {
      expect(solver.pos[i] as number).toBeCloseTo(before[i] as number, 2);
    }
  });

  it('never lets a particle exceed maxStretch, even on a teleport', () => {
    const geo = buildSkirt(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    solver.reset(ctx.ref);
    run(solver, ctx, t, 60);

    // Teleport the attachment 4000 units away in a single frame.
    for (let i = 0; i < geo.count; i++) {
      ctx.ref[i * 3] = (geo.bind[i * 3] as number) + 4000;
      ctx.ref[i * 3 + 2] = (geo.bind[i * 3 + 2] as number) - 2500;
    }
    ctx.time += 1 / 60;
    solver.step(1 / 60, t, ctx);

    for (let i = 0; i < geo.count; i++) {
      if (geo.pinned[i]) continue;
      const cap = (geo.anchorRest[i] as number) * t.maxStretch;
      expect(anchorDistance(solver, i)).toBeLessThanOrEqual(cap + 1e-6);
    }
  });

  it('respects maxStretch at other body scales', () => {
    const geo = buildSkirt(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    ctx.scale = 2.5;
    for (let i = 0; i < ctx.ref.length; i++) ctx.ref[i] = (geo.bind[i] as number) * 2.5;
    solver.reset(ctx.ref);
    ctx.windX = 900;
    run(solver, ctx, t, 180);

    for (let i = 0; i < geo.count; i++) {
      if (geo.pinned[i]) continue;
      const cap = (geo.anchorRest[i] as number) * 2.5 * t.maxStretch;
      expect(anchorDistance(solver, i)).toBeLessThanOrEqual(cap + 1e-6);
    }
  });

  it('pushes every particle out of the capsules it collides with', () => {
    const geo = buildSkirt(FIGURE);
    const solver = new ClothSolver(geo);
    const caps = new CapsuleSet(1);
    // A fat vertical capsule straight through the lower robe. Its axis runs well
    // below the floor and above the hem, so every free particle projects onto
    // the axis interior and the test reduces to a clean horizontal radius --
    // no interaction with the ground clamp to reason about.
    caps.set(0, 0, -30, 0, 0, 45, 0, 10, MASK_ALL);
    const ctx = createStepContext(new Float64Array(geo.bind), caps);
    const t = defaultRobeTuning();
    solver.reset(ctx.ref);
    run(solver, ctx, t, 240);

    const r = 10 + t.collisionRadius;
    for (let i = 0; i < geo.count; i++) {
      if (geo.pinned[i]) continue;
      const px = solver.pos[i * 3] as number;
      const pz = solver.pos[i * 3 + 2] as number;
      expect(Math.hypot(px, pz)).toBeGreaterThanOrEqual(r - 1e-6);
    }
  });

  it('lets maxStretch win when a collider is too fat for the garment', () => {
    // The row just below the gathered waist is tethered to it at ~6 units, so it
    // simply cannot stand 6 units proud of the hips -- real fabric cannot either.
    // When collision and the stretch cap disagree, the cap is the one that holds:
    // a hem clipping a limb for a frame is a far cheaper artefact than a robe
    // visibly ballooning off the body.
    const geo = buildSkirt(FIGURE);
    const solver = new ClothSolver(geo);
    const caps = new CapsuleSet(1);
    caps.set(0, 0, -30, 0, 0, 45, 0, 30, MASK_ALL);
    const ctx = createStepContext(new Float64Array(geo.bind), caps);
    const t = defaultRobeTuning();
    solver.reset(ctx.ref);
    run(solver, ctx, t, 240);

    for (let i = 0; i < geo.count; i++) {
      if (geo.pinned[i]) continue;
      const cap = (geo.anchorRest[i] as number) * t.maxStretch;
      expect(anchorDistance(solver, i)).toBeLessThanOrEqual(cap + 1e-6);
    }
  });

  it('ignores capsules outside the piece mask', () => {
    const geo = buildSkirt(FIGURE);
    const solver = new ClothSolver(geo);
    const caps = new CapsuleSet(1);
    caps.set(0, 0, 5, 0, 0, 45, 0, 14, 0); // mask 0: nothing may collide with it
    const ctx = createStepContext(new Float64Array(geo.bind), caps);
    const t = defaultRobeTuning();
    solver.reset(ctx.ref);
    run(solver, ctx, t, 120);

    // With no collision the robe hangs inward under gravity, so at least one
    // particle ends up inside the (ignored) capsule's radius.
    let anyInside = false;
    for (let i = 0; i < geo.count; i++) {
      if (geo.pinned[i]) continue;
      const px = solver.pos[i * 3] as number;
      const pz = solver.pos[i * 3 + 2] as number;
      if (Math.hypot(px, pz) < 14) anyInside = true;
    }
    expect(anyInside).toBe(true);
  });

  it('keeps the hem above the ground plane', () => {
    const geo = buildSkirt(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    t.gravityMultiplier = 4;
    t.springStrength = 0;
    t.recoverySpeed = 0;
    solver.reset(ctx.ref);
    run(solver, ctx, t, 300);

    for (let i = 0; i < geo.count; i++) {
      if (geo.pinned[i]) continue;
      expect(solver.pos[i * 3 + 1] as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('billows downwind and comes back when the wind stops', () => {
    const geo = buildCape(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    t.idleSway = 0;
    solver.reset(ctx.ref);
    run(solver, ctx, t, 300);
    // The cape hangs down the back (its normal points along -x), so a wind
    // along -x hits it broadside.
    const restX = solver.pos[(geo.count - 1) * 3] as number;

    ctx.windX = -320;
    run(solver, ctx, t, 200);
    const blownX = solver.pos[(geo.count - 1) * 3] as number;
    expect(blownX).toBeLessThan(restX - 8);

    ctx.windX = 0;
    run(solver, ctx, t, 600);
    expect(solver.pos[(geo.count - 1) * 3] as number).toBeCloseTo(restX, 0);
  });

  it('lifts far more from a broadside wind than an edge-on one', () => {
    const geo = buildCape(FIGURE);
    const displace = (wx: number, wz: number): number => {
      const solver = new ClothSolver(geo);
      const ctx = quietContext(geo);
      const t = { ...defaultRobeTuning(), idleSway: 0 };
      solver.reset(ctx.ref);
      run(solver, ctx, t, 300);
      const x0 = solver.pos[(geo.count - 1) * 3] as number;
      const z0 = solver.pos[(geo.count - 1) * 3 + 2] as number;
      ctx.windX = wx;
      ctx.windZ = wz;
      run(solver, ctx, t, 200);
      return Math.hypot((solver.pos[(geo.count - 1) * 3] as number) - x0, (solver.pos[(geo.count - 1) * 3 + 2] as number) - z0);
    };
    // Same wind speed: normal to the sheet must move it several times further
    // than along it. This is the whole point of projecting pressure onto the
    // vertex normal instead of pushing every particle equally.
    expect(displace(-320, 0)).toBeGreaterThan(displace(0, 320) * 3);
  });

  it('lags behind an accelerating body (inertia)', () => {
    const geo = buildCape(FIGURE);
    const heavy = new ClothSolver(geo);
    const light = new ClothSolver(geo);
    const ctxHeavy = quietContext(geo);
    const ctxLight = quietContext(geo);
    const t = defaultRobeTuning();
    t.idleSway = 0;
    heavy.reset(ctxHeavy.ref);
    light.reset(ctxLight.ref);

    // Same acceleration, different inertia multipliers: more inertia must trail
    // further behind, in the direction opposing the acceleration.
    ctxHeavy.bodyAccX = 900;
    ctxLight.bodyAccX = 900;
    const strong = { ...t, inertiaMultiplier: 3 };
    const weak = { ...t, inertiaMultiplier: 0 };
    run(heavy, ctxHeavy, strong, 20);
    run(light, ctxLight, weak, 20);

    const hemStrong = heavy.pos[(geo.count - 1) * 3] as number;
    const hemWeak = light.pos[(geo.count - 1) * 3] as number;
    expect(hemStrong).toBeLessThan(hemWeak);
  });

  it('kicks the fabric on an impulse and recovers afterwards', () => {
    const geo = buildCape(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    t.idleSway = 0;
    solver.reset(ctx.ref);
    run(solver, ctx, t, 200);
    const restY = solver.pos[(geo.count - 1) * 3 + 1] as number;

    solver.addImpulse(0, 400, 0);
    run(solver, ctx, t, 6);
    expect(solver.pos[(geo.count - 1) * 3 + 1] as number).toBeGreaterThan(restY);

    run(solver, ctx, t, 600);
    expect(solver.pos[(geo.count - 1) * 3 + 1] as number).toBeCloseTo(restY, 0);
  });

  it('is deterministic: same geometry, tuning and inputs give identical positions', () => {
    const geo = buildSkirt(FIGURE);
    const drive = (): Float64Array => {
      const solver = new ClothSolver(geo);
      const ctx = quietContext(geo);
      const t = defaultRobeTuning();
      solver.reset(ctx.ref);
      for (let f = 0; f < 200; f++) {
        ctx.time += 1 / 60;
        ctx.windX = Math.sin(f * 0.07) * 200;
        ctx.windZ = Math.cos(f * 0.05) * 150;
        ctx.bodyAccX = f % 40 === 0 ? 800 : 0;
        ctx.idle = f > 100 ? 1 : 0;
        for (let i = 0; i < geo.count; i++) ctx.ref[i * 3] = (geo.bind[i * 3] as number) + f * 1.5;
        if (f === 50) solver.addImpulse(0, 300, 0);
        solver.step(1 / 60, t, ctx);
      }
      return Float64Array.from(solver.pos);
    };
    expect(Array.from(drive())).toEqual(Array.from(drive()));
  });

  it('reuses its buffers: stepping never reallocates', () => {
    const geo = buildCape(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    const pos = solver.pos;
    const vel = solver.vel;
    const normal = solver.normal;
    solver.reset(ctx.ref);
    run(solver, ctx, t, 50);
    expect(solver.pos).toBe(pos);
    expect(solver.vel).toBe(vel);
    expect(solver.normal).toBe(normal);
  });

  it('holds its pose on a paused frame (dt of 0 or NaN)', () => {
    const geo = buildCape(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    solver.reset(ctx.ref);
    run(solver, ctx, t, 40);
    const before = Float64Array.from(solver.pos);
    solver.step(0, t, ctx);
    solver.step(Number.NaN, t, ctx);
    solver.step(-1, t, ctx);
    expect(Array.from(solver.pos)).toEqual(Array.from(before));
  });

  it('stays finite through a huge timestep', () => {
    const geo = buildSkirt(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    solver.reset(ctx.ref);
    ctx.windX = 4000;
    for (let i = 0; i < 20; i++) {
      ctx.time += 10;
      solver.step(10, t, ctx);
    }
    expect(allFinite(solver.pos)).toBe(true);
    expect(allFinite(solver.vel)).toBe(true);
    expect(allFinite(solver.normal)).toBe(true);
  });

  it('recovers from non-finite tuning instead of staying broken', () => {
    const geo = buildCape(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    solver.reset(ctx.ref);
    run(solver, ctx, t, 30);

    // Straight NaN into the solve: the repair pass must park the piece back on
    // its reference pose rather than leaving it permanently invisible.
    const broken = { ...t, stiffness: Number.NaN, fabricWeight: 0, damping: Number.NaN };
    solver.step(1 / 60, broken, ctx);
    expect(allFinite(solver.pos)).toBe(true);
    expect(allFinite(solver.vel)).toBe(true);

    run(solver, ctx, t, 120);
    expect(allFinite(solver.pos)).toBe(true);
    expect(solver.maxStretchRatio()).toBeLessThan(t.maxStretch + 1e-6);
  });

  it('survives sanitised garbage tuning', () => {
    const geo = buildSkirt(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    solver.reset(ctx.ref);
    const junk = {
      ...t,
      fabricWeight: 0,
      stiffness: Number.POSITIVE_INFINITY,
      bendStiffness: -5,
      damping: Number.NaN,
      substeps: 0,
      iterations: -3,
      maxStretch: 0,
      collisionRadius: Number.NaN,
    };
    sanitizeRobeTuning(junk);
    run(solver, ctx, junk, 120);
    expect(allFinite(solver.pos)).toBe(true);
  });

  it('handles a collider sitting exactly on a particle', () => {
    const geo = buildSkirt(FIGURE);
    const solver = new ClothSolver(geo);
    const caps = new CapsuleSet(1);
    const ctx = createStepContext(new Float64Array(geo.bind), caps);
    const t = defaultRobeTuning();
    solver.reset(ctx.ref);
    // Zero-length capsule centred exactly on particle 20's bind position.
    const px = geo.bind[20 * 3] as number;
    const py = geo.bind[20 * 3 + 1] as number;
    const pz = geo.bind[20 * 3 + 2] as number;
    caps.set(0, px, py, pz, px, py, pz, 6, MASK_ALL);
    run(solver, ctx, t, 60);
    expect(allFinite(solver.pos)).toBe(true);
  });

  it('reports a stretch ratio inside the configured cap', () => {
    const geo = buildSkirt(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    const t = defaultRobeTuning();
    solver.reset(ctx.ref);
    ctx.windX = 700;
    ctx.windZ = -500;
    run(solver, ctx, t, 300);
    expect(solver.maxStretchRatio()).toBeGreaterThanOrEqual(1);
    // Distance constraints are soft, so the per-link ratio can sit slightly over
    // the tether cap; it must still be nowhere near a visibly stretched robe.
    expect(solver.maxStretchRatio()).toBeLessThan(1.6);
  });

  it('produces unit normals', () => {
    const geo = buildCape(FIGURE);
    const solver = new ClothSolver(geo);
    const ctx = quietContext(geo);
    solver.reset(ctx.ref);
    run(solver, ctx, defaultRobeTuning(), 30);
    for (let i = 0; i < geo.count; i++) {
      const len = Math.hypot(
        solver.normal[i * 3] as number,
        solver.normal[i * 3 + 1] as number,
        solver.normal[i * 3 + 2] as number,
      );
      expect(len).toBeCloseTo(1, 6);
    }
  });

  it('settles faster with a higher recovery speed', () => {
    const geo = buildCape(FIGURE);
    const measure = (recoverySpeed: number): number => {
      const solver = new ClothSolver(geo);
      const ctx = quietContext(geo);
      const t = { ...defaultRobeTuning(), idleSway: 0, recoverySpeed };
      solver.reset(ctx.ref);
      run(solver, ctx, t, 200);
      const rest = Float64Array.from(solver.pos);
      solver.addImpulse(260, 0, 180);
      run(solver, ctx, t, 45);
      let drift = 0;
      for (let i = 0; i < rest.length; i++) drift += Math.abs((solver.pos[i] as number) - (rest[i] as number));
      return drift;
    };
    expect(measure(12)).toBeLessThan(measure(0));
  });
});
