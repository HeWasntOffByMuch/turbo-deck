import { describe, expect, it } from 'vitest';
import {
  ARRIVAL_GRACE_TICKS,
  BURROW_TICKS,
  DIG_DROP,
  DIG_UNTIL,
  FEET_OUT,
  SETTLED,
  SpawnPresentations,
  arrives,
  bodyDropAt,
  buriedAt,
  isCommitted,
  spawnEffectFor,
  spawnEffectScale,
  spawnSeed,
  spawnStyleFor,
  type SpawnBody,
} from './spawn-presentation.js';
import { appearanceOf } from './appearance.js';
import { monsterCritterFor } from './monster-critter.js';
import { authoredUnitFor } from './unit-catalog.js';
import { BURROW_DIRT_TICKS, POOF_TICKS, BRUSH_EFFECTS } from '../vfx/brush.js';
import { ALL_MONSTERS } from '../../../server/data/monsters.js';
import { EntityActivity, EntityKind } from '../../../server/net/protocol.js';

const monster = (typeId: string) => appearanceOf({ kind: EntityKind.Monster, typeId });

function body(overrides: Partial<SpawnBody> = {}): SpawnBody {
  return {
    id: 1,
    style: 'burrow',
    spawnTick: 100,
    dead: false,
    committed: false,
    ...overrides,
  };
}

describe('spawnStyleFor', () => {
  it('burrows the two bodies that share the mech rig', () => {
    // The whole of why these two share a presentation: they share a rig, and it
    // is the only one here whose feet are world-locked.
    expect(spawnStyleFor(monster('small_spider'), false)).toBe('burrow');
    expect(spawnStyleFor(monster('warden'), false)).toBe('burrow');
  });

  it('gives the generic arrival to everything that is not on the mech rig', () => {
    // The player, and the two kinds of body that are drawn by another rig: an
    // animal off `monster-critter.ts` and an authored unit off the catalog.
    const player = appearanceOf({ kind: EntityKind.Player, typeId: 'player' });
    expect(spawnStyleFor(player, false)).toBe('generic');
    expect(spawnStyleFor(monster('sheep'), false)).toBe('generic');
    // An authored unit is drawn by a `UnitRig`, which has no world-locked foot
    // to plant -- so it gets the poof whatever else is true of the row.
    for (const npc of ['npc.merchant', 'npc.quartermaster', 'npc.armourer']) {
      expect(spawnStyleFor(monster(npc), true), npc).toBe('generic');
    }
  });

  it('answers for every monster in the roster, and agrees with the rig chain', () => {
    // The rule rather than a list of ids: a body burrows exactly when
    // `scene.ts`'s construction chain would reach the mech branch for it. Pins
    // the whole roster, so giving the spider a critter row fails here rather
    // than silently changing what a spawn looks like.
    let burrows = 0;
    let generic = 0;
    for (const row of ALL_MONSTERS) {
      const look = monster(row.id);
      const authored = authoredUnitFor(look) !== null;
      const mech = !authored && monsterCritterFor(row.id) === null;
      expect(spawnStyleFor(look, authored), row.id).toBe(mech ? 'burrow' : 'generic');
      if (mech) burrows += 1;
      else generic += 1;
    }
    // Both directions, because a function that answered one way for everything
    // would pass either half alone.
    expect(burrows).toBeGreaterThan(0);
    expect(generic).toBeGreaterThan(0);
  });

  it('gives a projectile, a prop and a drop no arrival at all', () => {
    // They carry their own entrance -- a shot is drawn flying, a drop is thrown
    // and withholds itself, a mote hops.
    expect(arrives(EntityKind.Player)).toBe(true);
    expect(arrives(EntityKind.Monster)).toBe(true);
    expect(arrives(EntityKind.Projectile)).toBe(false);
    expect(arrives(EntityKind.Prop)).toBe(false);
    expect(arrives(EntityKind.Drop)).toBe(false);
    expect(arrives(EntityKind.Mote)).toBe(false);
  });

  it('names an effect the registry actually holds, for both styles', () => {
    // A typo here is an arrival that silently plays nothing, which is exactly
    // what a table lookup is supposed to make impossible.
    const ids = new Set(BRUSH_EFFECTS.map((effect) => effect.id));
    expect(ids.has(spawnEffectFor('generic'))).toBe(true);
    expect(ids.has(spawnEffectFor('burrow'))).toBe(true);
    expect(spawnEffectFor('generic')).not.toBe(spawnEffectFor('burrow'));
  });
});

describe('the emergence staging', () => {
  it('holds the body at one depth for the whole time the legs come out', () => {
    // The claim the first stage rests on: the body's own height above the
    // ground is `-(buried + bodyDrop)` in hidden depths, and it does not change
    // at all while the feet are rising. What moves is the legs and only the
    // legs -- which is what separates being pushed up from being translated.
    for (let p = 0; p <= FEET_OUT; p += 0.005) {
      expect(buriedAt(p) + bodyDropAt(p)).toBeCloseTo(1, 6);
    }
  });

  it('brings the feet out before the body', () => {
    // Under at the start, planted by `FEET_OUT`, and the body at its full drop
    // -- the one instant it is as deep as it ever gets with its feet on the
    // ground, which is the frame that is legs and nothing else.
    expect(buriedAt(0)).toBeCloseTo(1, 6);
    expect(buriedAt(FEET_OUT)).toBeCloseTo(0, 6);
    expect(bodyDropAt(FEET_OUT)).toBeCloseTo(1, 6);
    // And barely moves through the first half of the dig: the ramp is eased in,
    // so the window of legs-out-and-nothing-else is a window rather than an
    // instant.
    const half = FEET_OUT + (DIG_UNTIL - FEET_OUT) / 2;
    expect(bodyDropAt(half)).toBeGreaterThan(0.9);
    // The dig ends with the body still down by most of its depth: the shoulders
    // are through and the body has not been lifted yet.
    expect(bodyDropAt(DIG_UNTIL)).toBeCloseTo(DIG_DROP, 6);
    expect(DIG_DROP).toBeGreaterThan(0.5);
    expect(DIG_DROP).toBeLessThan(1);
  });

  it('rises monotonically from the moment the feet land, and lands exactly at standing', () => {
    // "Exactly" matters more than "monotonically": an emergence that ended at
    // 0.001 of a hidden depth is a body permanently a little in the ground. And
    // monotone from `FEET_OUT` rather than from `DIG_UNTIL`, because the dig is
    // a rise now too -- a body that sank back mid-emergence would read as
    // slipping.
    expect(buriedAt(1)).toBe(0);
    expect(bodyDropAt(1)).toBe(0);
    let previous = Number.POSITIVE_INFINITY;
    for (let p = FEET_OUT; p <= 1.0001; p += 0.005) {
      const drop = bodyDropAt(p);
      expect(drop).toBeLessThanOrEqual(previous + 1e-9);
      previous = drop;
    }
  });

  it('never lets the body sink while it is arriving', () => {
    // The whole curve, not just half of it: the body's height above the ground
    // is `-(buried + bodyDrop)`, and it must only ever climb. A stage boundary
    // that overshot would be a body bobbing back down into its own hole.
    let previous = Number.NEGATIVE_INFINITY;
    for (let p = 0; p <= 1.0001; p += 0.005) {
      const height = -(buriedAt(p) + bodyDropAt(p));
      expect(height).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = height;
    }
  });

  it('clamps a phase outside its own range rather than extrapolating', () => {
    expect(buriedAt(-1)).toBeCloseTo(1, 6);
    expect(bodyDropAt(2)).toBe(0);
    expect(buriedAt(Number.NaN)).toBeCloseTo(1, 6);
    expect(bodyDropAt(Number.NaN)).toBeCloseTo(0, 6);
  });

  it('is authored to the same length as the dirt it throws', () => {
    // Stated in both files and asserted here rather than trusted: dirt that
    // outlasts the digging is dirt coming off a body that has finished.
    expect(BURROW_TICKS).toBe(BURROW_DIRT_TICKS);
    // And the poof is over well inside it -- a quick cue, not a smokescreen.
    expect(POOF_TICKS).toBeLessThan(BURROW_TICKS);
  });
});

describe('SpawnPresentations', () => {
  it('plays an arrival for a body the server has just made', () => {
    const spawns = new SpawnPresentations();
    const first = spawns.read(body({ spawnTick: 100 }), 102);
    expect(first.began).toBe(true);
    expect(first.phase).toBeCloseTo(0, 6);
    expect(first.buried).toBeCloseTo(1, 6);
  });

  it('plays nothing for a body that was merely walked up to', () => {
    // The case `spawnTick` exists for. Without it the Spawn bit alone would
    // poof every body on the map as the player approached it.
    const spawns = new SpawnPresentations();
    const stage = spawns.read(body({ spawnTick: 100 }), 100 + ARRIVAL_GRACE_TICKS + 1);
    expect(stage).toEqual(SETTLED);
    expect(stage.began).toBe(false);
  });

  it('fires the effect once, not once a frame', () => {
    const spawns = new SpawnPresentations();
    let fired = 0;
    for (let tick = 100; tick < 100 + BURROW_TICKS + 20; tick += 1) {
      if (spawns.read(body({ spawnTick: 100 }), tick).began) fired += 1;
    }
    expect(fired).toBe(1);
  });

  it('plays a respawn off the edge it watched, for the same style', () => {
    const spawns = new SpawnPresentations();
    const spider = body({ spawnTick: 100 });
    // Arrive, finish, die.
    spawns.read(spider, 100);
    spawns.read(spider, 100 + BURROW_TICKS + 10);
    expect(spawns.read({ ...spider, dead: true }, 400).began).toBe(false);
    // Back on its feet: a fresh arrival, in the same style, with no new
    // `spawnTick` anywhere -- the entity is reused, so this is the edge alone.
    const back = spawns.read({ ...spider, dead: false }, 500);
    expect(back.began).toBe(true);
    expect(back.style).toBe('burrow');
    expect(back.buried).toBeCloseTo(1, 6);
  });

  it('plays nothing for a body first seen after somebody else respawned it', () => {
    // `stagger-flinch.ts`'s rule: the start is observed, so a client that was
    // not watching draws nothing rather than inventing a moment it missed.
    const spawns = new SpawnPresentations();
    expect(spawns.read(body({ spawnTick: 1 }), 900)).toEqual(SETTLED);
  });

  it('treats a body first seen dead as a corpse rather than an arrival', () => {
    const spawns = new SpawnPresentations();
    expect(spawns.read(body({ spawnTick: 100, dead: true }), 101)).toEqual(SETTLED);
  });

  it('yields the moment the body commits to something', () => {
    // The whole of "a unit is never seen attacking from under the ground". The
    // arrival gets out of the way; it never holds the body.
    const spawns = new SpawnPresentations();
    const spider = body({ spawnTick: 100 });
    const mid = spawns.read(spider, 105);
    expect(mid.buried).toBeGreaterThan(0);
    const casting = spawns.read({ ...spider, committed: true }, 106);
    expect(casting).toEqual(SETTLED);
    // And it stays settled rather than resuming once the cast ends.
    expect(spawns.read(spider, 107)).toEqual(SETTLED);
  });

  it('yields when the body dies mid-emergence', () => {
    const spawns = new SpawnPresentations();
    const spider = body({ spawnTick: 100 });
    spawns.read(spider, 101);
    expect(spawns.read({ ...spider, dead: true }, 104)).toEqual(SETTLED);
  });

  it('never starts an arrival on a body that is already committed', () => {
    const spawns = new SpawnPresentations();
    const stage = spawns.read(body({ spawnTick: 100, committed: true }), 101);
    expect(stage).toEqual(SETTLED);
  });

  it('reads exactly settled once the emergence is over', () => {
    // Not "close to": a leftover offset is a body standing permanently a little
    // in the ground, and it is the failure repeated respawns would accumulate.
    const spawns = new SpawnPresentations();
    const spider = body({ spawnTick: 100 });
    spawns.read(spider, 100);
    const done = spawns.read(spider, 100 + BURROW_TICKS);
    expect(done.phase).toBe(1);
    expect(done.buried).toBe(0);
    expect(done.bodyDrop).toBe(0);
  });

  it('accumulates nothing over repeated arrivals on one id', () => {
    // Ten deaths and ten respawns, checking the offsets land back at exactly
    // zero every time and that the track count never grows.
    const spawns = new SpawnPresentations();
    const spider = body({ spawnTick: 100 });
    let tick = 100;
    for (let round = 0; round < 10; round += 1) {
      const start = spawns.read(spider, tick);
      expect(start.began).toBe(true);
      tick += BURROW_TICKS + 5;
      const settled = spawns.read(spider, tick);
      expect(settled.buried).toBe(0);
      expect(settled.bodyDrop).toBe(0);
      tick += 5;
      spawns.read({ ...spider, dead: true }, tick);
      tick += 5;
      expect(spawns.tracked).toBe(1);
    }
  });

  it('re-arrives when an id is reused for a different body', () => {
    // The other door into the same state: the server reuses entity ids, so a
    // track that outlived its body would refuse the new one's arrival.
    const spawns = new SpawnPresentations();
    spawns.read(body({ spawnTick: 100 }), 100);
    spawns.read(body({ spawnTick: 100 }), 100 + BURROW_TICKS + 10);
    const remade = spawns.read(body({ spawnTick: 900 }), 902);
    expect(remade.began).toBe(true);
    expect(remade.buried).toBeCloseTo(1, 6);
  });

  it('drops tracks for bodies that have gone', () => {
    const spawns = new SpawnPresentations();
    spawns.read(body({ id: 1, spawnTick: 100 }), 100);
    spawns.read(body({ id: 2, spawnTick: 100 }), 100);
    expect(spawns.tracked).toBe(2);
    spawns.retain(new Set([1]));
    expect(spawns.tracked).toBe(1);
    spawns.forget(1);
    expect(spawns.tracked).toBe(0);
  });

  it('gives the generic style no offsets at all, only its poof', () => {
    // A critter and an authored unit have no world-locked foot to plant, so
    // there is nothing to stage: the poof is the whole presentation, and the
    // body is drawn exactly as it always is.
    const spawns = new SpawnPresentations();
    const stage = spawns.read(body({ style: 'generic', spawnTick: 100 }), 101);
    expect(stage.began).toBe(true);
    expect(stage.style).toBe('generic');
    expect(stage.buried).toBe(0);
    expect(stage.bodyDrop).toBe(0);
  });

  it('survives a nonsense clock rather than launching a body', () => {
    const spawns = new SpawnPresentations();
    const stage = spawns.read(body({ spawnTick: Number.NaN }), Number.NaN);
    expect(Number.isFinite(stage.buried)).toBe(true);
    expect(Number.isFinite(stage.bodyDrop)).toBe(true);
    expect(stage.buried).toBeLessThanOrEqual(1);
    expect(stage.bodyDrop).toBeLessThanOrEqual(1);
  });
});

describe('isCommitted', () => {
  it('is a cast and only a cast', () => {
    // Walking is deliberately not a commitment: a monster's idle plan sets off
    // on its second tick, so yielding to movement would mean the emergence
    // never plays at all.
    expect(isCommitted(EntityActivity.Casting)).toBe(true);
    expect(isCommitted(EntityActivity.Idle)).toBe(false);
    expect(isCommitted(EntityActivity.Moving)).toBe(false);
  });
});

describe('the play options an arrival is fired with', () => {
  it('scales the effect off the body rather than playing every one the same size', () => {
    const small = spawnEffectScale(12);
    const large = spawnEffectScale(30);
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });

  it('refuses a zero radius rather than collapsing the effect to nothing', () => {
    expect(spawnEffectScale(0)).toBeGreaterThan(0);
    expect(spawnEffectScale(Number.NaN)).toBeGreaterThan(0);
  });

  it('seeds off which body and when, so two clients paint one arrival alike', () => {
    // The same body and the same spawn tick is the same painting, whatever each
    // client's own clock happens to read.
    expect(spawnSeed(7, 500, 900)).toBe(spawnSeed(7, 500, 20));
    expect(spawnSeed(7, 500, 900)).not.toBe(spawnSeed(8, 500, 900));
    expect(spawnSeed(7, 500, 900)).not.toBe(spawnSeed(7, 501, 900));
    // A respawn has no fresh spawn tick, so it falls back to the drawn one --
    // which is what makes two arrivals on one id two paintings.
    expect(spawnSeed(7, 0, 100)).not.toBe(spawnSeed(7, 0, 400));
  });
});
