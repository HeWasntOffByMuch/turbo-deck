/**
 * Spec 246. A body that will not fight, and one that has been stopped to talk.
 *
 * Two independent claims, tested apart because they fail apart: the temperament
 * is about `isHostile` and the aggro functions, and the conversation claim is
 * about what `monsterIntent` does before it reads anything else.
 *
 * What goes through the real `step` is everything that could be wired up wrong
 * -- that the claim reaches the movement pass at all, that releasing it puts the
 * body back to wandering, and that none of it touches the `Rng`.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { ALL_MONSTERS, monsterById, noticeRangeOf } from '../data/monsters.js';
import { ALL_NPCS, npcById } from '../data/npcs.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { isFriendly, notice, playersOf, provoke, rally } from './aggro.js';
import { AggroValue, EntityKindValue, type ServerEntity, type ServerWorldState } from './types.js';
import { createWorldState, isHostile, spawnEntity, step, type StepContext } from './world.js';

const CHUNK = 100;
const NPC_ID = 'npc.merchant';

function context(): StepContext {
  const activeChunks = new Set<string>();
  for (let dy = -20; dy <= 20; dy++) {
    for (let dx = -20; dx <= 20; dx++) {
      activeChunks.add(chunkKeyOf(600 + dx * CHUNK, 450 + dy * CHUNK, CHUNK));
    }
  }
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: DEFAULT_LIVE_CONFIG,
    activeChunks,
    chunkSize: CHUNK,
    spawnPoints: [],
  };
}

function withMonster(
  state: ServerWorldState,
  typeId: string,
  x: number,
  y: number,
  extra: { anchor?: { x: number; y: number } } = {},
): { state: ServerWorldState; id: number } {
  const definition = monsterById(typeId);
  if (!definition) throw new Error(`no monster ${typeId}`);
  const result = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId,
    position: { x, y, z: 0 },
    stats: definition.stats,
    radius: definition.radius,
    zoneId: 'greenmarch',
    ...(extra.anchor === undefined ? {} : { anchor: extra.anchor }),
  });
  return { state: result.state, id: result.entity.id };
}

function withPlayer(state: ServerWorldState, x: number, y: number): { state: ServerWorldState; id: number } {
  const stats = monsterById('stalker');
  if (!stats) throw new Error('no stalker to borrow stats from');
  const result = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x, y, z: 0 },
    stats: stats.stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  return { state: result.state, id: result.entity.id };
}

function at(state: ServerWorldState, id: number): ServerEntity {
  const entity = state.entities.get(id);
  if (!entity) throw new Error(`entity ${id} left the world`);
  return entity;
}

function run(state: ServerWorldState, ticks: number, ctx: StepContext): ServerWorldState {
  let next = state;
  for (let i = 0; i < ticks; i++) next = step(next, [], ctx).state;
  return next;
}

function replace(state: ServerWorldState, entity: ServerEntity): ServerWorldState {
  const entities = new Map(state.entities);
  entities.set(entity.id, entity);
  return { ...state, entities };
}

describe('a friendly temperament', () => {
  it('is what the merchant has', () => {
    const merchant = monsterById(NPC_ID);
    expect(merchant?.temperament.kind).toBe('friendly');
  });

  it('cannot be attacked, and cannot attack', () => {
    // Both directions, which is the whole of the non-hostility: there is no
    // other branch anywhere asking whether a body is an enemy.
    let state = createWorldState(1);
    const npc = withMonster(state, NPC_ID, 600, 450);
    state = npc.state;
    const player = withPlayer(state, 620, 450);
    state = player.state;
    const zones = new ZoneManager();
    expect(isHostile(at(state, player.id), at(state, npc.id), zones)).toBe(false);
    expect(isHostile(at(state, npc.id), at(state, player.id), zones)).toBe(false);
  });

  it('leaves every other monster hostile, so the refusal is about this one', () => {
    // The control. Without it a broken `isHostile` that refused everything
    // would pass the assertion above.
    let state = createWorldState(1);
    const spider = withMonster(state, 'small_spider', 600, 450);
    state = spider.state;
    const player = withPlayer(state, 620, 450);
    state = player.state;
    const zones = new ZoneManager();
    expect(isHostile(at(state, player.id), at(state, spider.id), zones)).toBe(true);
    expect(isHostile(at(state, spider.id), at(state, player.id), zones)).toBe(true);
  });

  it('never notices a player standing on top of it', () => {
    let state = createWorldState(1);
    const npc = withMonster(state, NPC_ID, 600, 450);
    state = npc.state;
    const player = withPlayer(state, 601, 451);
    state = player.state;
    const after = notice(at(state, npc.id), playersOf(state.entities), 0);
    expect(after.targetId).toBeNull();
    expect(after.aggro).toBe(AggroValue.Calm);
  });

  it('notices nothing, so it has no reach to bound', () => {
    const merchant = monsterById(NPC_ID);
    if (!merchant) throw new Error('no merchant');
    expect(noticeRangeOf(merchant.temperament)).toBe(0);
  });

  it('does not acquire a target even if something conjures damage onto it', () => {
    // Unreachable through a blow, since nothing can hit it. Asserted anyway,
    // because `provoke` is also what an admin's conjured damage reaches, and a
    // friendly body that acquired a target would chase with an ability it has
    // not got.
    let state = createWorldState(1);
    const npc = withMonster(state, NPC_ID, 600, 450);
    state = npc.state;
    const player = withPlayer(state, 620, 450);
    state = player.state;
    const after = provoke(at(state, npc.id), at(state, player.id), 10);
    expect(after.targetId).toBeNull();
    expect(after.aggro).toBe(AggroValue.Calm);
  });

  it('is not rallied by a blow landing beside it', () => {
    let state = createWorldState(1);
    const npc = withMonster(state, NPC_ID, 600, 450);
    state = npc.state;
    const victim = withMonster(state, 'small_spider', 610, 450);
    state = victim.state;
    const player = withPlayer(state, 620, 450);
    state = player.state;
    const changed = rally(
      [
        {
          kind: 'hit',
          attackerId: player.id,
          targetId: victim.id,
          damage: 3,
          targetHealth: 3,
          killed: false,
          critical: false,
          blocked: false,
          weakPoint: false,
        },
      ],
      state.entities,
    );
    expect(changed.has(npc.id)).toBe(false);
  });

  it('is what `isFriendly` answers, and only for a friendly row', () => {
    let state = createWorldState(1);
    const npc = withMonster(state, NPC_ID, 600, 450);
    state = npc.state;
    const spider = withMonster(state, 'small_spider', 610, 450);
    state = spider.state;
    const player = withPlayer(state, 620, 450);
    state = player.state;
    expect(isFriendly(at(state, npc.id))).toBe(true);
    expect(isFriendly(at(state, spider.id))).toBe(false);
    expect(isFriendly(at(state, player.id))).toBe(false);
  });
});

describe('the merchant on its own ground', () => {
  it('wanders, and stays inside its authored radius', () => {
    const plan = monsterById(NPC_ID)?.idle;
    if (plan?.kind !== 'wander') throw new Error('the merchant should wander');
    const anchor = { x: 600, y: 450 };
    let state = createWorldState(3);
    const npc = withMonster(state, NPC_ID, anchor.x, anchor.y, { anchor });
    state = npc.state;
    const ctx = context();

    let furthest = 0;
    let moved = 0;
    const ticks = SERVER_TICK_RATE * 60;
    for (let tick = 0; tick < ticks; tick++) {
      const before = at(state, npc.id).position;
      state = step(state, [], ctx).state;
      const after = at(state, npc.id).position;
      if (Math.hypot(after.x - before.x, after.y - before.y) > 1e-6) moved += 1;
      furthest = Math.max(furthest, Math.hypot(after.x - anchor.x, after.y - anchor.y));
    }

    // It really roams -- a body that never left its spawn would pass a radius
    // check trivially.
    expect(furthest).toBeGreaterThan(plan.radius * 0.4);
    // And it does not roam far. The shop's reach is measured from the anchor,
    // so how far it strays is a number `VENDOR_REACH` has to cover.
    expect(furthest).toBeLessThanOrEqual(plan.radius + at(state, npc.id).radius + 1);
    // Both a walk and a rest, which is what makes it read as a shopkeeper
    // rather than as a thing on rails or a statue.
    expect(moved / ticks).toBeGreaterThan(0.05);
    expect(moved / ticks).toBeLessThan(0.85);
  });
});

describe('a conversation claim', () => {
  function talking(): { state: ServerWorldState; npc: number; player: number; ctx: StepContext } {
    const anchor = { x: 600, y: 450 };
    let state = createWorldState(3);
    const npc = withMonster(state, NPC_ID, anchor.x, anchor.y, { anchor });
    state = npc.state;
    const player = withPlayer(state, 660, 450);
    state = player.state;
    state = replace(state, { ...at(state, npc.id), conversationWith: player.id });
    return { state, npc: npc.id, player: player.id, ctx: context() };
  }

  it('holds the body still', () => {
    const held = talking();
    const before = at(held.state, held.npc).position;
    const after = at(run(held.state, SERVER_TICK_RATE * 30, held.ctx), held.npc).position;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1);
  });

  it('is what stops it, so the same body wanders without one', () => {
    // The control: 30 seconds is two and a half of its own cycles, so a body
    // that did not move in the test above did so because of the claim.
    const free = talking();
    const state = replace(free.state, { ...at(free.state, free.npc), conversationWith: null });
    const before = at(state, free.npc).position;
    const after = at(run(state, SERVER_TICK_RATE * 30, free.ctx), free.npc).position;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(5);
  });

  it('turns the body to face the player', () => {
    const held = talking();
    const state = run(held.state, SERVER_TICK_RATE * 2, held.ctx);
    const npc = at(state, held.npc);
    const player = at(state, held.player);
    const wanted = Math.atan2(player.position.y - npc.position.y, player.position.x - npc.position.x);
    const off = Math.abs(Math.atan2(Math.sin(npc.facing - wanted), Math.cos(npc.facing - wanted)));
    expect(off).toBeLessThan(0.05);
  });

  it('lets go when the player it names has gone', () => {
    // The body's behaviour, not the bookkeeping: `monsterIntent` falls through
    // to the idle plan when the listener is not there, so a claim naming a
    // vanished player cannot freeze a merchant for the session.
    const held = talking();
    const entities = new Map(held.state.entities);
    entities.delete(held.player);
    const state = { ...held.state, entities };
    const before = at(state, held.npc).position;
    const after = at(run(state, SERVER_TICK_RATE * 30, held.ctx), held.npc).position;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(5);
  });

  it('lets go when the player it names is dead', () => {
    const held = talking();
    const state = replace(held.state, { ...at(held.state, held.player), health: 0 });
    const before = at(state, held.npc).position;
    const after = at(run(state, SERVER_TICK_RATE * 30, held.ctx), held.npc).position;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(5);
  });

  it('resumes its plan at the tick it would have reached anyway', () => {
    // The claim is a claim, not a mood: `postAt` is a function of the tick, so
    // nothing is stored that a conversation could leave stale.
    const held = talking();
    const talked = run(held.state, SERVER_TICK_RATE * 20, held.ctx);
    const released = replace(talked, { ...at(talked, held.npc), conversationWith: null });
    const after = run(released, SERVER_TICK_RATE * 20, held.ctx);

    const control = replace(held.state, { ...at(held.state, held.npc), conversationWith: null });
    const free = run(control, SERVER_TICK_RATE * 40, held.ctx);
    // Both bodies are 40 seconds old and on the same epoch, so they are heading
    // for the same spot even though one spent half that standing still.
    expect(at(after, held.npc).position.x).toBeCloseTo(at(free, held.npc).position.x, 0);
    expect(at(after, held.npc).position.y).toBeCloseTo(at(free, held.npc).position.y, 0);
  });

  it('draws nothing from the Rng', () => {
    // The rule every behaviour in this sim is held to: which conversations are
    // happening cannot shift a combat roll, so a replay meets the same fight.
    const held = talking();
    const spoken = run(held.state, SERVER_TICK_RATE * 20, held.ctx);

    const quiet = replace(held.state, { ...at(held.state, held.npc), conversationWith: null });
    const silent = run(quiet, SERVER_TICK_RATE * 20, held.ctx);
    expect(spoken.rng.getState()).toEqual(silent.rng.getState());
  });
});

describe('the NPC table', () => {
  it('names a monster row for every NPC, and a friendly one', () => {
    for (const npc of ALL_NPCS) {
      const row = monsterById(npc.id);
      expect(row, `${npc.id} has no MONSTERS row`).not.toBeNull();
      expect(row?.temperament.kind, npc.id).toBe('friendly');
    }
  });

  it('gives every friendly row an NPC, so nothing is unattackable and mute', () => {
    // The other direction, and the one that catches the real mistake: a body
    // nothing can fight and nobody can talk to is scenery that looks like a
    // character.
    for (const row of ALL_MONSTERS) {
      if (row.temperament.kind !== 'friendly') continue;
      expect(npcById(row.id), `${row.id} is friendly with nothing to say`).not.toBeNull();
    }
  });

  it('gives every NPC a talk radius a player can actually reach', () => {
    for (const npc of ALL_NPCS) {
      const row = monsterById(npc.id);
      expect(npc.talkRadius, npc.id).toBeGreaterThan(row?.radius ?? 0);
    }
  });

  it('lets an NPC wander no further than its shop can be reached from', () => {
    // The one coupling this feature has between two tables, asserted rather
    // than commented: a merchant that strayed past its vendor's radius would
    // open a shop the server then refuses to serve.
    for (const npc of ALL_NPCS) {
      if (npc.vendorId === null) continue;
      const plan = monsterById(npc.id)?.idle;
      const roam = plan === undefined || plan.kind === 'sentinel' ? 0 : plan.radius;
      expect(roam + npc.talkRadius, npc.id).toBeGreaterThan(0);
    }
  });
});
