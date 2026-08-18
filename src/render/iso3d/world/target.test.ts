/**
 * The auto-attack driver (spec 070). Headless: the whole point of keeping the
 * decision out of the view is that "does the player stop walking once they are
 * in reach" needs no canvas to answer.
 */

import { describe, expect, it } from 'vitest';
import {
  autoAttack,
  HOLD_FRACTION,
  STANDOFF_FRACTION,
  type AutoAttackInput,
  type Point,
  type TargetSnapshot,
} from './target.js';
import { ARRIVE_EPS } from './intent.js';
import { ALL_ABILITIES } from '../../../server/data/abilities.js';
import { ALL_MONSTERS } from '../../../server/data/monsters.js';
import { mayCast, type CastDecision } from '../../../server/client/combat.js';
import { computeEffectiveStats } from '../../../server/player/stats.js';
import { EMPTY_EQUIPMENT, emptyInventory } from '../../../server/state/types.js';

const TARGET: TargetSnapshot = { id: 7, x: 400, y: 0, radius: 20, health: 40 };
/** The basic attack's reach, before the target's body is added to it. */
const RANGE = 70;

function ask(overrides: Partial<AutoAttackInput> = {}): ReturnType<typeof autoAttack> {
  return autoAttack({
    self: { x: 0, y: 0 },
    selfHealth: 100,
    target: TARGET,
    range: RANGE,
    // Facing it, unless a case says otherwise: alignment is a separate question
    // from reach and cooldown, and every case written before spec 090 was about
    // one of those.
    aligned: true,
    rooted: false,
    // Holding its own footing, unless a case says otherwise (spec 172).
    staggered: false,
    pending: false,
    readyAtTick: 0,
    tick: 100,
    ...overrides,
  });
}

/**
 * The gate the client asks of itself before sending a request: the sim's own
 * `startCast`, over a mirror standing at `from` and aiming at the origin.
 */
function gate(abilityId: string, from: Point, targetRadius: number): CastDecision {
  const stats = computeEffectiveStats({
    id: 'p1',
    displayName: 'P1',
    baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
    skills: [],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    coins: 0,
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'greenmarch',
    level: 1,
    experience: 0,
    unspentSkillPoints: 0,
    unspentAttributePoints: 0,
    health: 200,
    resource: 100,
  });
  return mayCast(
    {
      position: from,
      // Pointing at the origin, so the answer is about reach and nothing else.
      facing: Math.atan2(-from.y, -from.x),
      fallbackCharges: 0,
      // Not staggered; this is a question about reach (spec 172).
      activity: 0,
      activityUntilTick: 0,
      health: stats.maxHealth,
      resource: stats.maxResource,
      cooldowns: {},
      cast: null,
      stats,
      poise: stats.traits.maxPoise,
      shield: 0,
    },
    abilityId,
    { x: 0, y: 0 },
    100,
    100,
    7,
    targetRadius,
  );
}

describe('auto-attacking a named target (spec 070)', () => {
  it('asks for nothing at all with no target', () => {
    expect(ask({ target: null })).toEqual({ chaseTo: null, attack: false, drop: false });
  });

  it('chases when the target is out of reach, and does not swing at nothing', () => {
    const decision = ask();
    expect(decision.attack).toBe(false);
    expect(decision.chaseTo).not.toBeNull();
  });

  it('stops the chase inside reach, on the near side of the target', () => {
    const chase = ask().chaseTo;
    if (!chase) throw new Error('expected a chase');
    const reach = 70 + TARGET.radius;
    const gap = Math.hypot(TARGET.x - chase.x, TARGET.y - chase.y);
    // Inside reach, so arriving means being able to swing...
    expect(gap).toBeLessThan(reach);
    expect(gap).toBeCloseTo(reach * STANDOFF_FRACTION, 6);
    // ...and on our side of it, so the chase never walks through the body.
    expect(chase.x).toBeLessThan(TARGET.x);
    expect(chase.x).toBeGreaterThan(0);
  });

  it('stands still and swings once it is in reach', () => {
    const decision = ask({ self: { x: 340, y: 0 } });
    expect(decision.chaseTo).toBeNull();
    expect(decision.attack).toBe(true);
  });

  it('counts reach to the target\'s edge, not to its centre', () => {
    // 70 out is inside the standoff on `70 + the 20-unit body` (72) and outside
    // the standoff on the range alone (56), so the body's width is the whole of
    // the difference between swinging and walking closer.
    const near = ask({ self: { x: TARGET.x - 70, y: 0 } });
    expect(near.attack).toBe(true);
    const fat = ask({ target: { ...TARGET, radius: 0 }, self: { x: TARGET.x - 70, y: 0 } });
    expect(fat.attack).toBe(false);
  });

  /**
   * Spec 079. The standoff is where a chase *stops*, not merely where it points.
   *
   * It used to be both and neither: the walk aimed at `reach * STANDOFF` and
   * halted the moment it was inside `reach`, so a body came to rest exactly on
   * the edge it was meant to keep clear of.
   */
  it('keeps walking until it is inside the hold, not merely inside reach', () => {
    const reach = RANGE + TARGET.radius;
    // Between the hold and the edge of reach: still closing, not yet swinging,
    // so a body never comes to rest on the line it is measured against.
    const between = ask({ self: { x: TARGET.x - (reach + reach * HOLD_FRACTION) / 2, y: 0 } });
    expect(between.attack).toBe(false);
    expect(between.chaseTo).not.toBeNull();

    // And the chase it asks for aims further in than the line it just failed.
    const chase = between.chaseTo;
    if (!chase) throw new Error('no chase');
    expect(Math.hypot(TARGET.x - chase.x, TARGET.y - chase.y)).toBeCloseTo(
      reach * STANDOFF_FRACTION,
      6,
    );
  });

  /**
   * The bug that made it matter, and the one the collapse into a single
   * threshold caused next: a body that walks into range and does nothing.
   *
   * `moveIntent` stops within `ARRIVE_EPS` of a destination, so if the distance
   * that ends the chase is the same one that allows the swing, the body parks a
   * few units *outside* its own threshold -- not walking, because it has
   * arrived, and not attacking, because it has not. The gap between the two
   * fractions is what makes that impossible, and it has to be bigger than the
   * arrival tolerance for every basic attack against the smallest body in the
   * game.
   */
  it('leaves more room between chasing and swinging than a chase can miss by', () => {
    const smallest = Math.min(...ALL_MONSTERS.map((monster) => monster.radius));
    const basics = ALL_ABILITIES.filter((ability) => ability.basicAttack);
    expect(basics.length).toBeGreaterThan(0);
    expect(HOLD_FRACTION).toBeGreaterThan(STANDOFF_FRACTION);

    for (const ability of basics) {
      const reach = ability.range + smallest;
      const gap = reach * (HOLD_FRACTION - STANDOFF_FRACTION);
      expect(gap, `${ability.id} against a ${smallest}-unit body`).toBeGreaterThan(ARRIVE_EPS);
    }
  });

  /**
   * The same thing end to end, without the arithmetic: walk a body in from out
   * of range one chase at a time and it must end up swinging, not parked.
   */
  it('ends a chase swinging rather than standing', () => {
    for (const range of [70, 300, 420]) {
      const target = { ...TARGET, radius: 20 };
      let self = { x: target.x - range * 3, y: 0 };
      let swung = false;
      for (let step = 0; step < 500 && !swung; step++) {
        const decision = ask({ range, target, self });
        if (decision.attack) { swung = true; break; }
        const chase = decision.chaseTo;
        expect(chase, `range ${range} stopped without swinging`).not.toBeNull();
        if (!chase) break;
        // One tick of walking, and the arrival tolerance the move order applies.
        const dx = chase.x - self.x;
        const dy = chase.y - self.y;
        const left = Math.hypot(dx, dy);
        if (left <= ARRIVE_EPS) { self = chase; continue; }
        const stride = Math.min(3, left);
        self = { x: self.x + (dx / left) * stride, y: self.y + (dy / left) * stride };
      }
      expect(swung, `range ${range}`).toBe(true);
    }
  });

  /**
   * A ranged attack is gated by the server at the ability's own range measured
   * from the caster, so a chase that comes to rest past that number leaves the
   * player standing and asking with every request refused `outOfRange`.
   */
  it('stops a ranged chase inside the range the server gates on', () => {
    for (const range of [300, 420]) {
      const target = { ...TARGET, radius: 22 };
      const decision = ask({ range, target, self: { x: -400, y: 0 } });
      const chase = decision.chaseTo;
      expect(chase, `range ${range}`).not.toBeNull();
      if (!chase) continue;
      const stop = Math.hypot(target.x - chase.x, target.y - chase.y);
      expect(stop, `range ${range}`).toBeLessThan(range);
      // And the attack fires from there rather than from further out.
      expect(ask({ range, target, self: chase }).attack, `range ${range}`).toBe(true);
    }
  });

  /**
   * Spec 080, as a standing property over the whole table: wherever the chase is
   * allowed to come to rest, the gate the client asks of *itself* says yes.
   *
   * The two are the same question asked in two files -- `HOLD_FRACTION` of
   * `range + radius` here, `startCast` over a mirror there -- and until 080 the
   * second was never handed the radius, so it measured to the body's centre
   * while the server measured to its edge. Today's numbers happen to keep the
   * hold inside the range on its own; the first monster with a radius past a
   * ninth of a weapon's range would have parked the order on a spot it refused
   * to fire from. `combat.test.ts` pins the divergence directly, with a body
   * wide enough to show it; this pins the pair that has to stay true.
   */
  it('holds where the client’s own gate would allow the shot', () => {
    const point = ALL_ABILITIES.filter((a) => a.basicAttack && a.targeting === 'point');
    expect(point.length).toBeGreaterThan(0);

    for (const ability of point) {
      for (const monster of ALL_MONSTERS) {
        const reach = ability.range + monster.radius;
        const at = { x: reach * HOLD_FRACTION, y: 0 };
        const label = `${ability.id} vs ${monster.id}`;
        // Where the hold allows a swing...
        expect(
          ask({
            range: ability.range,
            target: { ...TARGET, x: 0, radius: monster.radius },
            self: at,
          }).attack,
          label,
        ).toBe(true);
        // ...the gate the client asks of itself says yes too.
        expect(gate(ability.id, at, monster.radius).ok, label).toBe(true);
      }
    }
  });

  it('does not re-commit while a cast is already running', () => {
    expect(ask({ self: { x: 340, y: 0 }, rooted: true }).attack).toBe(false);
  });

  /**
   * Spec 079. A move order withdraws from a cast now, so a chase issued while
   * committed would call the swing off on the player's behalf -- and the one
   * thing a feint has to be is theirs.
   */
  it('asks for no chase while committed, however far out the target is', () => {
    expect(ask({ self: { x: -900, y: 0 }, rooted: true }).chaseTo).toBeNull();
    expect(ask({ self: { x: 340, y: 0 }, rooted: true }).chaseTo).toBeNull();
    // And it still says so when the target has died under a committed swing.
    expect(ask({ target: { ...TARGET, health: 0 }, rooted: true }).drop).toBe(true);
  });

  it('waits out the cooldown the server gave it', () => {
    const inReach = { self: { x: 340, y: 0 } };
    expect(ask({ ...inReach, readyAtTick: 130, tick: 129 }).attack).toBe(false);
    expect(ask({ ...inReach, readyAtTick: 130, tick: 130 }).attack).toBe(true);
  });

  it('drops a target that has died, and swings at it no more', () => {
    const decision = ask({ self: { x: 340, y: 0 }, target: { ...TARGET, health: 0 } });
    expect(decision.drop).toBe(true);
    expect(decision.attack).toBe(false);
    expect(decision.chaseTo).toBeNull();
  });

  it('keeps chasing a target that walks away, without ever dropping it', () => {
    // The order stands as long as the body does: only death ends it.
    const far = ask({ target: { ...TARGET, x: 4000 } });
    expect(far.drop).toBe(false);
    expect(far.chaseTo).not.toBeNull();
  });

  /**
   * Spec 080. `rooted` is a *cast*, and a request that has been sent and not yet
   * ruled on has no cast behind it -- so on the tick after a press the order saw
   * nothing stopping it and asked again, and again, for the whole round trip.
   *
   * The only thing that ever held it back was the cooldown the client guesses,
   * and it guesses one only when its own mirror expects the server to agree. So
   * every disagreement between the two -- and there is a whole band of them --
   * turned one swing into sixty requests a second, each refused, each a notice.
   */
  it('asks once and then waits to be answered', () => {
    const inReach = { self: { x: 340, y: 0 } };
    expect(ask({ ...inReach, pending: false }).attack).toBe(true);
    expect(ask({ ...inReach, pending: true }).attack).toBe(false);
    // Ready cooldown or not: the question is whether we have already asked.
    expect(ask({ ...inReach, pending: true, readyAtTick: 0, tick: 9999 }).attack).toBe(false);
  });

  it('still closes the gap while a request is in flight', () => {
    // Waiting on an answer is not a reason to stand still out of reach -- the
    // walk is the half of the order that owes nothing to the server.
    const chasing = ask({ pending: true });
    expect(chasing.chaseTo).not.toBeNull();
    expect(chasing.attack).toBe(false);
  });

  /**
   * Spec 080. Nothing dropped the order when the *player* died, and the server's
   * cast pass skips a body at zero health -- so a corpse with a standing order
   * asked sixty times a second into a pass that answered none of them.
   */
  it('drops the order when we are the one who died', () => {
    for (const self of [{ x: 340, y: 0 }, { x: -900, y: 0 }]) {
      const decision = ask({ self, selfHealth: 0 });
      expect(decision.drop).toBe(true);
      expect(decision.attack).toBe(false);
      expect(decision.chaseTo).toBeNull();
    }
  });
});

/**
 * Asking to swing only once the body is facing the mark (spec 090).
 *
 * Reported as two wind-up bars: one filling to about a fifth and vanishing, then
 * a second running to the end. It is one cast, drawn twice. The client turns its
 * own body a tick or two ahead of the server, so with a mark off to the side its
 * local heading reads as aligned while the server is still coming round; the
 * client predicts `Windup` and fills a bar, the server starts the cast in
 * `Turning`, and `castBar` -- correctly -- draws a turning cast as empty. The
 * fill is thrown away and starts again when the real wind-up begins.
 *
 * Fixed at the source: do not ask until the *replica* says the body is facing
 * it. Both sides then agree on the phase, and there is one bar.
 */
describe('a swing waits to be facing its mark (spec 090)', () => {
  /** Well inside the standoff, so reach and cooldown are both satisfied. */
  const NEAR = { ...TARGET, x: RANGE * 0.5 };

  it('holds while the body is still coming round, then asks', () => {
    // In reach and off cooldown -- the only thing missing is the heading.
    expect(ask({ target: NEAR, aligned: false, readyAtTick: 0, tick: 100 }).attack).toBe(false);
    expect(ask({ target: NEAR, aligned: true, readyAtTick: 0, tick: 100 }).attack).toBe(true);
  });

  it('does not confuse waiting to turn with letting the order go', () => {
    // The order stands and nothing is dropped: the body is turning into it.
    const turning = ask({ target: NEAR, aligned: false, readyAtTick: 0, tick: 100 });
    expect(turning.drop).toBe(false);
    // And in reach there is no chase to give back either, so the body simply
    // stands and turns rather than shuffling toward a mark it is already at.
    expect(turning.chaseTo).toBeNull();
  });

  it('still chases an out-of-reach mark it is not yet facing', () => {
    // Alignment gates the *swing*, not the walk -- a body that had to be facing
    // its target before it would approach one would never close the gap.
    const far = ask({
      aligned: false,
      target: { ...TARGET, x: RANGE * 6 },
      readyAtTick: 0,
      tick: 100,
    });
    expect(far.chaseTo).not.toBeNull();
    expect(far.attack).toBe(false);
  });
});

/** Close enough to swing, so a refusal below is about the break and nothing else. */
const IN_REACH = { x: 340, y: 0 };

describe('a broken body holds its order and asks for nothing (spec 172)', () => {
  it('does not ask while staggered', () => {
    // In reach and otherwise ready, so the only thing stopping the swing is the
    // break. `IN_REACH` is the same position the plain in-reach case uses.
    expect(ask({ staggered: true, self: IN_REACH }).attack).toBe(false);
  });

  it('does not chase while staggered', () => {
    // Out of reach, so a body that could walk would be told to. It cannot.
    expect(ask({ staggered: true, self: { x: -400, y: 0 } }).chaseTo).toBeNull();
  });

  it('keeps the mark', () => {
    // A stagger is half a second. Dropping the target would make every break
    // cost the player their order as well as their footing.
    expect(ask({ staggered: true, self: IN_REACH }).drop).toBe(false);
  });

  it('asks again the moment the window ends', () => {
    expect(ask({ staggered: false, self: IN_REACH }).attack).toBe(true);
  });

  it('still drops a corpse while staggered', () => {
    // Being staggered does not suspend the rule above it: a dead mark is not a
    // mark, whatever is happening to the body holding the order.
    expect(ask({ staggered: true, self: IN_REACH, target: { ...TARGET, health: 0 } }).drop).toBe(true);
  });
});
