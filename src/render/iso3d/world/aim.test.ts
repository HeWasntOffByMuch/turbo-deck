/**
 * Aiming a skill, and the order it becomes (spec 080). Headless: the whole
 * point of keeping the decision out of the view is that "does the body walk
 * into range and then throw it, once" needs no canvas to answer.
 */

import { describe, expect, it } from 'vitest';
import {
  aimGesture,
  aimShape,
  castOrder,
  startAim,
  type AimOrder,
  type CastOrderInput,
} from './aim.js';
import { HOLD_FRACTION, STANDOFF_FRACTION, type TargetSnapshot } from './target.js';
import { ARRIVE_EPS } from './intent.js';
import { abilityById, ALL_ABILITIES } from '../../../server/data/abilities.js';

function ability(id: string) {
  const found = abilityById(id);
  if (!found) throw new Error(`no ${id}`);
  return found;
}

describe('the gesture an ability asks for (spec 080)', () => {
  it('is nothing for a self cast, a body for a unit cast, and ground for the rest', () => {
    expect(aimGesture(ability('self.mend'))).toBe('none');
    expect(aimGesture(ability('bolt.seek'))).toBe('unit');
    expect(aimGesture(ability('ground.quake'))).toBe('ground');
    expect(aimGesture(ability('melee.heavy'))).toBe('ground');
  });

  it('answers for every ability in the table', () => {
    for (const entry of ALL_ABILITIES) {
      expect(['none', 'unit', 'ground']).toContain(aimGesture(entry));
    }
  });
});

describe('what a press turns into (spec 080)', () => {
  const ready = { readyAtTick: 0, tick: 100 };

  it('asks for a self cast now, and aims everything else', () => {
    expect(startAim(ability('self.mend'), ready)).toEqual({ kind: 'cast' });
    expect(startAim(ability('bolt.seek'), ready)).toEqual({ kind: 'aim', gesture: 'unit' });
    expect(startAim(ability('ground.quake'), ready)).toEqual({ kind: 'aim', gesture: 'ground' });
  });

  it('refuses a press while the ability is on cooldown, whatever it aims at', () => {
    const cooling = { readyAtTick: 120, tick: 100 };
    for (const id of ['self.mend', 'bolt.seek', 'ground.quake', 'melee.heavy']) {
      expect(startAim(ability(id), cooling), id).toEqual({
        kind: 'refused',
        reason: 'onCooldown',
      });
    }
  });

  it('allows it on the very tick the cooldown comes back, and not before', () => {
    expect(startAim(ability('ground.quake'), { readyAtTick: 120, tick: 119 }).kind).toBe('refused');
    expect(startAim(ability('ground.quake'), { readyAtTick: 120, tick: 120 }).kind).toBe('aim');
  });

  it('never refuses an ability with no cooldown standing against it', () => {
    for (const entry of ALL_ABILITIES) {
      expect(startAim(entry, ready).kind, entry.id).not.toBe('refused');
    }
  });
});

describe('the shape drawn on the ground (spec 080)', () => {
  it('draws nothing for a self cast or a named body -- the body is the indicator', () => {
    expect(aimShape(ability('self.mend'))).toEqual({ kind: 'none' });
    expect(aimShape(ability('bolt.seek'))).toEqual({ kind: 'none' });
  });

  it('recovers the wedge the sim will actually test, from arcCosSq', () => {
    const drain = ability('channel.drain');
    const shape = aimShape(drain);
    if (shape.kind !== 'cone') throw new Error('expected a cone');
    expect(shape.length).toBe(drain.range);
    // The half-angle round-trips: cos(half)^2 is the table's number back again.
    expect(Math.cos(shape.halfAngle) ** 2).toBeCloseTo(drain.arcCosSq ?? 0, 6);
  });

  it('draws a circle of the table radius for a blast and for a bursting lob', () => {
    expect(aimShape(ability('ground.quake'))).toEqual({ kind: 'circle', radius: 140 });
    expect(aimShape(ability('bolt.lob'))).toEqual({ kind: 'circle', radius: 90 });
  });

  it('draws the lane a flat shot flies down', () => {
    const bolt = ability('bolt.arcane');
    expect(aimShape(bolt)).toEqual({
      kind: 'line',
      length: bolt.range,
      width: (bolt.projectile?.radius ?? 0) * 2,
    });
  });

  it('produces a shape for every ability in the table without throwing', () => {
    for (const entry of ALL_ABILITIES) {
      expect(() => aimShape(entry)).not.toThrow();
      expect(aimShape(entry).kind).toBeTruthy();
    }
  });
});

const MARK: TargetSnapshot = { id: 9, x: 600, y: 0, radius: 24, health: 50 };
const UNIT_ORDER: AimOrder = { abilityId: 'bolt.seek', targetEntityId: MARK.id, x: MARK.x, y: MARK.y, range: 480 };
const GROUND_ORDER: AimOrder = { abilityId: 'ground.quake', targetEntityId: 0, x: 900, y: 0, range: 420 };

function step(overrides: Partial<CastOrderInput> = {}): ReturnType<typeof castOrder> {
  return castOrder({
    self: { x: 0, y: 0 },
    order: UNIT_ORDER,
    target: MARK,
    rooted: false,
    // Holding its own footing, unless a case says otherwise (spec 172).
    staggered: false,
    readyAtTick: 0,
    tick: 100,
    ...overrides,
  });
}

describe('one tick of a confirmed aim (spec 080)', () => {
  it('asks for nothing at all with no order', () => {
    expect(step({ order: null })).toEqual({ chaseTo: null, cast: null, drop: false });
  });

  it('walks toward a mark that is out of reach, and throws nothing on the way', () => {
    const decision = step();
    expect(decision.cast).toBeNull();
    expect(decision.drop).toBe(false);
    const chase = decision.chaseTo;
    if (!chase) throw new Error('expected a chase');
    // On the near side of the mark, and inside the range the server will gate.
    expect(chase.x).toBeLessThan(MARK.x);
    expect(Math.hypot(chase.x - MARK.x, chase.y - MARK.y)).toBeLessThan(UNIT_ORDER.range);
  });

  it('throws it exactly once, and drops the order in the same step', () => {
    const decision = step({ self: { x: 400, y: 0 } });
    expect(decision.chaseTo).toBeNull();
    expect(decision.cast).toEqual({
      abilityId: 'bolt.seek',
      x: MARK.x,
      y: MARK.y,
      targetEntityId: MARK.id,
    });
    expect(decision.drop).toBe(true);
  });

  it('holds while the body is committed, in reach or out of it', () => {
    expect(step({ rooted: true })).toEqual({ chaseTo: null, cast: null, drop: false });
    expect(step({ rooted: true, self: { x: 400, y: 0 } })).toEqual({
      chaseTo: null,
      cast: null,
      drop: false,
    });
  });

  it('drops rather than waiting when it arrives with the ability not ready', () => {
    // An order waits on the range and on nothing else: parking here would be
    // the queue `startAim` refuses a press to avoid, reached by the back door.
    const early = step({ self: { x: 400, y: 0 }, tick: 100, readyAtTick: 120 });
    expect(early).toEqual({ chaseTo: null, cast: null, drop: true });
    const ready = step({ self: { x: 400, y: 0 }, tick: 120, readyAtTick: 120 });
    expect(ready.cast?.abilityId).toBe('bolt.seek');
  });

  it('still walks toward a mark while the ability comes back, and gives up on arrival', () => {
    // Out of reach, the cooldown is not what is stopping it, so it walks.
    const far = step({ self: { x: -600, y: 0 }, tick: 100, readyAtTick: 120 });
    expect(far.chaseTo).not.toBeNull();
    expect(far.drop).toBe(false);
  });

  it('drops a unit order whose mark died or left the world', () => {
    expect(step({ target: { ...MARK, health: 0 } })).toEqual({
      chaseTo: null,
      cast: null,
      drop: true,
    });
    expect(step({ target: null })).toEqual({ chaseTo: null, cast: null, drop: true });
  });

  it('follows a mark that moves rather than the point it was clicked at', () => {
    const moved = { ...MARK, x: 300 };
    const decision = step({ self: { x: 0, y: 0 }, target: moved });
    // Close enough to throw at where it is now, though the click named x=600.
    expect(decision.cast?.x).toBe(300);
    const chasing = step({ self: { x: -900, y: 0 }, target: moved });
    const chase = chasing.chaseTo;
    if (!chase) throw new Error('expected a chase');
    expect(Math.hypot(chase.x - moved.x, chase.y - moved.y)).toBeLessThan(UNIT_ORDER.range);
  });

  it('measures a unit order to the mark s edge, not its centre', () => {
    // Just outside `range * HOLD` measured centre-to-centre, but inside once the
    // body's own radius is added -- which is the band `startCast` allows.
    const reach = UNIT_ORDER.range + MARK.radius;
    const between = MARK.x - (UNIT_ORDER.range * HOLD_FRACTION + reach * HOLD_FRACTION) / 2;
    expect(step({ self: { x: between, y: 0 } }).cast).not.toBeNull();
  });

  it('leaves a ground order where it was placed, and stops inside its range', () => {
    const far = castOrder({
      self: { x: 0, y: 0 },
      order: GROUND_ORDER,
      target: null,
      rooted: false,
      staggered: false,
      readyAtTick: 0,
      tick: 100,
    });
    const chase = far.chaseTo;
    if (!chase) throw new Error('expected a chase');
    expect(Math.hypot(chase.x - GROUND_ORDER.x, chase.y - GROUND_ORDER.y)).toBeLessThan(
      GROUND_ORDER.range,
    );

    const near = castOrder({
      self: { x: 700, y: 0 },
      order: GROUND_ORDER,
      target: null,
      rooted: false,
      staggered: false,
      readyAtTick: 0,
      tick: 100,
    });
    expect(near.cast).toEqual({
      abilityId: 'ground.quake',
      x: GROUND_ORDER.x,
      y: GROUND_ORDER.y,
      targetEntityId: 0,
    });
  });

  it('comes to rest somewhere it may actually cast from, for every ability on the bar', () => {
    // The bug spec 079 names, in this file's terms: a body that has to be *at*
    // its destination to act stops within ARRIVE_EPS of it and is therefore
    // just outside its own threshold, forever. The gap between the two
    // fractions is what makes that impossible, so assert the gap is real for
    // every range in the table.
    for (const entry of ALL_ABILITIES) {
      if (entry.range <= 0) continue;
      expect(entry.range * (HOLD_FRACTION - STANDOFF_FRACTION)).toBeGreaterThan(ARRIVE_EPS);
    }
  });

  it('walks a body in from far away and ends in a cast rather than a stand', () => {
    // The seam, not the halves: step the chase forward by hand until it either
    // throws the bolt or gives up walking.
    let self = { x: -1200, y: 0 };
    let cast: ReturnType<typeof castOrder>['cast'] = null;
    for (let i = 0; i < 400 && !cast; i++) {
      const decision = castOrder({
        self,
        order: UNIT_ORDER,
        target: MARK,
        rooted: false,
      staggered: false,
        readyAtTick: 0,
        tick: 100 + i,
      });
      cast = decision.cast;
      if (!decision.chaseTo) break;
      // A crude 20-units-per-tick walk straight at the chase point, which is
      // all the fidelity this assertion needs.
      const dx = decision.chaseTo.x - self.x;
      const dy = decision.chaseTo.y - self.y;
      const length = Math.hypot(dx, dy);
      if (length <= ARRIVE_EPS) break;
      const stepLength = Math.min(20, length);
      self = { x: self.x + (dx / length) * stepLength, y: self.y + (dy / length) * stepLength };
    }
    expect(cast?.abilityId).toBe('bolt.seek');
  });
});

describe('a broken body does nothing with a standing cast order (spec 172)', () => {
  it('does not chase while staggered', () => {
    expect(step({ staggered: true, self: { x: 0, y: 0 } }).chaseTo).toBeNull();
  });

  it('does not cast while staggered, even in reach and off cooldown', () => {
    // The failure this closes: a break *clears* the cast it interrupted, so
    // `rooted` is false for the whole window. An order running on `rooted`
    // alone treats a stunned body as a free one and sends a request the server
    // answers with `'staggered'`.
    expect(step({ staggered: true, self: { x: MARK.x - 100, y: 0 } }).cast).toBeNull();
  });

  it('keeps the order rather than spending it', () => {
    // The same rule the standing attack order follows: half a second of being
    // stunned must not also cost the player their plan.
    expect(step({ staggered: true, self: { x: MARK.x - 100, y: 0 } }).drop).toBe(false);
  });

  it('still drops an order whose mark has died', () => {
    // Being staggered does not suspend the rule above it.
    expect(
      step({ staggered: true, target: { ...MARK, health: 0 } }).drop,
    ).toBe(true);
  });

  it('acts again the moment the window ends', () => {
    expect(step({ staggered: false, self: { x: MARK.x - 100, y: 0 } }).cast).not.toBeNull();
  });
});
