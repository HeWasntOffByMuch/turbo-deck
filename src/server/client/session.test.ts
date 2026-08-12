/**
 * The client session end to end (spec 057): a real `GameClient` against a real
 * `GameServer` over a real loopback transport, exchanging real encoded frames.
 *
 * Nothing here reaches past the wire format. If a field is not in the protocol
 * the client cannot see it, which is the property that makes single-player over
 * a loopback a genuine test of multiplayer rather than a separate code path.
 */

import { describe, expect, it } from 'vitest';
import { BROADCAST_EVERY_N_TICKS, SERVER_TICK_RATE } from '../config.js';
import { EntityKindValue, type ServerEntity } from '../sim/types.js';
import { EntityKind } from '../net/protocol.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';
import { abilityById } from '../data/abilities.js';
import { CastEndReason } from '../sim/types.js';

/** Lets the loopback's queued microtasks drain. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  readonly server: GameServer;
  readonly transport: LoopbackTransport;
}

function harness(seed = 5): Harness {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed, transport });
  server.liveConfig.set('spawnRateMultiplier', 0);
  // `start()` would also run the loop off a real clock; tests drive `tick()`.
  transport.onConnection((channel) => server.accept(channel));
  return { server, transport };
}

async function connect(test: Harness, playerId: string): Promise<GameClient> {
  const client = new GameClient(test.transport.connect(), { playerId, displayName: playerId });
  const welcomed = client.connect();
  await settle();
  await welcomed;
  return client;
}

/**
 * Runs whole broadcast periods, finishing *on* a broadcast tick.
 *
 * Landing anywhere else leaves the world one or two ticks ahead of the last
 * delta the client was sent, which is correct behaviour and useless to compare
 * against -- a replica is only supposed to match the server as of the frame it
 * was told about.
 */
async function advance(test: Harness, periods: number): Promise<void> {
  for (let i = 0; i < periods * BROADCAST_EVERY_N_TICKS; i++) test.server.tick();
  while (test.server.world.tick % BROADCAST_EVERY_N_TICKS !== 0) test.server.tick();
  await settle();
}

/**
 * One tick with an input in it. The settle before the tick matters: the loopback
 * delivers asynchronously, exactly as a socket does, so an input sent in the
 * same breath as a tick has not arrived yet when that tick runs.
 */
/**
 * Drops a player to zero health outright. The map is readonly to everything
 * that plays by the rules; a test that wants a death without spending a minute
 * of simulated combat to get one reaches through it deliberately.
 */
function kill(test: Harness, entityId: number): void {
  const live = test.server.world.entities as Map<number, ServerEntity>;
  const entity = live.get(entityId);
  if (entity) live.set(entityId, { ...entity, health: 0 });
}

async function inputTick(
  test: Harness,
  client: GameClient,
  intent: { moveX: number; moveY: number; facing: number; buttons: number },
): Promise<void> {
  client.sendInput(intent);
  await settle();
  test.server.tick();
  await settle();
}

describe('loopback session', () => {
  it('connects, and the server counts it as a player like any other', async () => {
    const test = harness();
    const client = await connect(test, 'alice');

    const view = client.view();
    expect(view.connected).toBe(true);
    expect(view.selfEntityId).toBeGreaterThan(0);
    expect(view.stats?.maxHealth).toBeGreaterThan(0);
    // The thing the admin console lists -- an in-tab server is not a special case.
    expect(test.server.listPlayers().map((row) => row.playerId)).toEqual(['alice']);
  });

  /**
   * Spec 063: a 3D client has to build the ground it is standing on, and being
   * told which world this is on connect is the only honest way it can. A client
   * that guessed would draw trees the server walks through.
   */
  it('is told which world the server is running', async () => {
    const test = harness(4242);
    const client = await connect(test, 'alice');

    expect(client.view().worldSeed).toBe(4242);
  });

  it('knows no world before the welcome lands', () => {
    const test = harness();
    const client = new GameClient(test.transport.connect(), { playerId: 'alice' });

    expect(client.view().worldSeed).toBeNull();
  });

  it('replicates the world from deltas alone', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    const at = test.server.world.entities.get(client.view().selfEntityId)?.position;
    expect(at).toBeDefined();
    test.server.spawnEntities('grazer', (at?.x ?? 0) + 60, at?.y ?? 0, 2);

    await advance(test, 1);

    const view = client.view();
    // Itself plus the two grazers, and nothing invented.
    expect(view.entities).toHaveLength(3);
    const monsters = view.entities.filter((e) => e.kind === EntityKindValue.Monster);
    expect(monsters).toHaveLength(2);
    expect(monsters[0]?.typeId).toBe('grazer');
    expect(monsters[0]?.maxHealth).toBeGreaterThan(0);
  });

  it('agrees with the server about every entity it can see', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    test.server.spawnEntities('stalker', 640, 450, 3);

    for (let round = 0; round < 20; round++) {
      await inputTick(test, client, { moveX: 1, moveY: 0, facing: 0, buttons: 0 });
    }
    await advance(test, 1);

    const view = client.view();
    expect(view.entities.length).toBeGreaterThan(1);
    for (const replica of view.entities) {
      // Projectiles are spawned and resolved between broadcasts, so a replica
      // can legitimately still hold one the server has already retired.
      if (replica.kind === EntityKind.Projectile) continue;
      const authoritative = test.server.world.entities.get(replica.id);
      expect(authoritative, `entity ${replica.id} should exist server-side`).toBeDefined();
      if (!authoritative) continue;
      expect(replica.x).toBeCloseTo(authoritative.position.x, 2);
      expect(replica.y).toBeCloseTo(authoritative.position.y, 2);
      expect(replica.health).toBeCloseTo(authoritative.health, 2);
      expect(replica.typeId).toBe(authoritative.typeId);
    }
  });

  it('drops an entity from the replica when the server removes it', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    test.server.spawnEntities('grazer', 640, 450, 1);
    await advance(test, 1);

    const monster = client.view().entities.find((e) => e.kind === EntityKindValue.Monster);
    expect(monster).toBeDefined();

    test.server.despawnEntity(monster?.id ?? -1);
    await advance(test, 1);
    expect(client.view().entities.some((e) => e.id === monster?.id)).toBe(false);
  });

  it('predicts silently while walking in the open', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    for (let round = 0; round < 40; round++) {
      await inputTick(test, client, { moveX: 0, moveY: 1, facing: Math.PI / 2, buttons: 0 });
    }
    expect(client.correctionCount).toBe(0);

    // And the prediction is where the server actually is.
    const authoritative = test.server.world.entities.get(client.view().selfEntityId);
    expect(client.view().self?.y).toBeCloseTo(authoritative?.position.y ?? 0, 1);
  });

  it('re-derives stats server-side when the client asks to equip', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    const before = client.view().stats?.maxHealth ?? 0;

    client.equip('head', 'helm.leather');
    await settle();
    expect(client.view().stats?.maxHealth ?? 0).toBeGreaterThan(before);
  });

  it('reports an illegal skill spend without changing anything', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    const errors: string[] = [];
    client.onError((_code, message) => errors.push(message));

    client.spendSkillPoint('might.bulwark');
    await settle();
    expect(errors).toHaveLength(1);
    expect(test.server.playerManager.get('alice')?.record.skills).toEqual([]);
  });

  it('surfaces combat results, and moves nobody (spec 065)', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);
    const self = test.server.world.entities.get(client.view().selfEntityId);
    test.server.spawnEntities('grazer', (self?.position.x ?? 0) + 40, self?.position.y ?? 0, 1);

    const results: number[] = [];
    client.onCombatResult((result) => results.push(result.damage));
    // Read the id server-side: the spawn has not been broadcast yet, so the
    // replica does not know about it at this point in the tick.
    const targetId = [...test.server.world.entities.values()].find(
      (entity) => entity.kind === EntityKindValue.Monster,
    )?.id;

    // Commit to the basic melee, then run out its wind-up -- the table's own
    // number, since it moves (spec 094), plus room for the turn in front of it.
    const swing = abilityById('melee.slash');
    client.useAbility('melee.slash', (self?.position.x ?? 0) + 40, self?.position.y ?? 0);
    await settle();
    for (let i = 0; i < (swing?.windupTicks ?? 0) + 30; i++) {
      test.server.tick();
      await settle();
    }

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toBeGreaterThan(0);

    // Nothing was displaced. A grazer is passive and never moves itself, so any
    // travel here would be knockback coming back.
    const struck = test.server.world.entities.get(targetId ?? -1);
    expect(struck).toBeDefined();
    expect(struck?.position.x).toBeCloseTo((self?.position.x ?? 0) + 40, 6);
    expect(struck?.position.y).toBeCloseTo(self?.position.y ?? 0, 6);
  });

  it('refuses admin messages -- an in-tab server has no admin channel', async () => {
    const test = harness();
    await connect(test, 'alice');
    const replies: number[] = [];
    const channel = test.transport.connect();
    channel.onMessage((bytes) => replies.push(bytes[0] ?? 0));
    // admin:auth with an empty token.
    channel.send(new Uint8Array([0x80, 0x00]));
    await settle();
    // 0xa1 is the admin error reply.
    expect(replies).toEqual([0xa1]);
  });
});

describe('the rate split', () => {
  it('advances the sim at 60Hz and describes it at 20', async () => {
    expect(SERVER_TICK_RATE).toBe(60);
    expect(SERVER_TICK_RATE / BROADCAST_EVERY_N_TICKS).toBe(20);

    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    // Seeded with what the client already knows, so the loop counts only the
    // broadcasts it causes.
    const ticksSeen: number[] = [client.view().tick];
    const startTick = test.server.world.tick;
    for (let i = 0; i < 30; i++) {
      await inputTick(test, client, { moveX: 1, moveY: 0, facing: 0, buttons: 0 });
      const seen = client.view().tick;
      if (ticksSeen[ticksSeen.length - 1] !== seen) ticksSeen.push(seen);
    }
    ticksSeen.shift();

    expect(test.server.world.tick - startTick).toBe(30);
    // 30 sim ticks is 10 broadcasts, and each one is three ticks newer.
    expect(ticksSeen).toHaveLength(10);
    for (let i = 1; i < ticksSeen.length; i++) {
      expect((ticksSeen[i] ?? 0) - (ticksSeen[i - 1] ?? 0)).toBe(BROADCAST_EVERY_N_TICKS);
    }
  });

  it('leaves an honest client uncorrected across a whole run of ticks', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);
    for (let i = 0; i < 30; i++) {
      await inputTick(test, client, { moveX: 1, moveY: 0, facing: 0, buttons: 0 });
    }
    expect(client.correctionCount).toBe(0);
  });
});

describe('loopback is the socket', () => {
  it('carries real encoded frames, not shared objects', async () => {
    // The loopback deliberately does not shortcut encoding, so a field missing
    // from the wire format fails here exactly as it would over a network. The
    // proof: everything the client knows survived a round trip through bytes,
    // and mutating the server's own entity afterwards does not reach it.
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    const replica = client.view().entities[0];
    expect(replica).toBeDefined();
    const authoritative = test.server.world.entities.get(replica?.id ?? -1);
    expect(authoritative).toBeDefined();
    expect(replica).not.toBe(authoritative);
    expect(replica?.x).toBeCloseTo(authoritative?.position.x ?? -1, 3);
  });
});

describe('dying', () => {
  it('puts a player back on their feet without changing who they are', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    const entityId = client.view().selfEntityId;
    const maxHealth = client.view().stats?.maxHealth ?? 0;
    expect(maxHealth).toBeGreaterThan(0);

    expect(test.server.world.entities.get(entityId)).toBeDefined();
    kill(test, entityId);

    test.server.tick();
    await settle();
    // The body stays: sweeping it up would take the id the client knows itself
    // by, and leave it rendering an empty world.
    expect(test.server.world.entities.has(entityId)).toBe(true);

    for (let i = 0; i < SERVER_TICK_RATE * 4; i++) test.server.tick();
    await settle();

    const revived = test.server.world.entities.get(entityId);
    expect(revived?.health).toBeCloseTo(maxHealth, 3);
    // Same entity id, so the client never lost track of itself.
    expect(client.view().selfEntityId).toBe(entityId);
    expect(client.view().entities.some((e) => e.id === entityId)).toBe(true);
  });

  it('does not flag the first input after a respawn as a speed hack', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);
    const entityId = client.view().selfEntityId;

    // Walk away from spawn, so respawning is a long jump backwards.
    for (let i = 0; i < 60; i++) {
      await inputTick(test, client, { moveX: 1, moveY: 0, facing: 0, buttons: 0 });
    }
    const before = client.correctionCount;

    kill(test, entityId);
    for (let i = 0; i < SERVER_TICK_RATE * 4; i++) test.server.tick();
    await settle();

    // The teleport correction is expected; what must not follow is a speed
    // violation on every input afterwards.
    const afterRespawn = client.correctionCount;
    for (let i = 0; i < 20; i++) {
      await inputTick(test, client, { moveX: 0, moveY: 1, facing: Math.PI / 2, buttons: 0 });
    }
    expect(client.correctionCount).toBe(afterRespawn);
    expect(afterRespawn).toBeGreaterThan(before);
  });
});

/**
 * Cancelling, over the wire (spec 064).
 *
 * The rule itself is pinned in `sim/abilities.test.ts`. What is pinned here is
 * that a player pressing the key actually reaches it: `cancelCast()` travels as
 * its own message, on a tick that may carry no movement input at all, and if it
 * is dropped anywhere along that path the wind-up simply runs to release and the
 * player is charged for a blow they called off.
 */
describe('calling off a cast', () => {
  it('refunds the cost and the cooldown from the client side', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    const entityId = client.view().selfEntityId;
    const heavy = abilityById('melee.heavy');
    expect(heavy).toBeDefined();
    if (!heavy) return;
    expect(heavy.cost).toBeGreaterThan(0);

    const before = test.server.world.entities.get(entityId)?.resource ?? 0;

    client.useAbility('melee.heavy', 900, 500);
    await settle();
    test.server.tick();
    await settle();

    const casting = test.server.world.entities.get(entityId);
    expect(casting?.cast?.abilityId).toBe('melee.heavy');
    expect(casting?.resource ?? 0).toBeCloseTo(before - heavy.cost, 6);
    // The cost is spent at the commit; the cooldown is not, and since spec 091
    // there is nothing to refund because nothing was taken.
    expect(casting?.cooldowns['melee.heavy']).toBeUndefined();

    // Call it off partway through the wind-up, deliberately on a tick with no
    // movement input behind it.
    for (let i = 0; i < 5; i++) test.server.tick();
    client.cancelCast();
    await settle();
    test.server.tick();
    await settle();

    const after = test.server.world.entities.get(entityId);
    expect(after?.cast).toBeNull();
    expect(after?.resource ?? 0).toBeGreaterThanOrEqual(before);
    expect(after?.cooldowns['melee.heavy']).toBeUndefined();

    // And it can be committed to again at once, because nothing was spent.
    client.useAbility('melee.heavy', 900, 500);
    await settle();
    test.server.tick();
    await settle();
    expect(test.server.world.entities.get(entityId)?.cast?.abilityId).toBe('melee.heavy');
  });

  it('tells the client the cast is over, so the bar clears', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    client.useAbility('melee.heavy', 900, 500);
    await settle();
    test.server.tick();
    await settle();
    expect(client.view().casts).toHaveLength(1);

    client.cancelCast();
    await settle();
    test.server.tick();
    await settle();
    expect(client.view().casts).toHaveLength(0);
    expect(client.view().requestedAbilityId).toBeNull();
  });

  /**
   * The client's cast has to last exactly as long as the server's, because the
   * client roots itself for it. `castEnded` used to fire at the *release* tick
   * while the server went on rooting through recovery, so the client believed
   * itself free and predicted movement the server refused -- a correction per
   * tick, for the length of every recovery.
   */
  it('keeps the cast until the server is finished with it', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    const entityId = client.view().selfEntityId;
    const at = test.server.world.entities.get(entityId)?.position;
    if (!at) return;

    client.useAbility('melee.heavy', at.x + 60, at.y);
    await settle();

    let disagreements = 0;
    for (let i = 0; i < 200; i++) {
      test.server.tick();
      client.advanceTick();
      await settle();
      const serverCasting = test.server.world.entities.get(entityId)?.cast !== null;
      const clientCasting = client.view().casts.some((cast) => cast.entityId === entityId);
      if (serverCasting !== clientCasting) disagreements += 1;
    }

    expect(disagreements).toBe(0);
    // And it did finish, rather than both sides agreeing it never ended.
    expect(test.server.world.entities.get(entityId)?.cast).toBeNull();
  });
});

/**
 * However a cast ends, it has to be *announced*, not just done.
 *
 * `applyDamage` used to clear the target's cast. Doing that without an event
 * left the client holding a cast the server had dropped -- and since a client
 * roots itself while it believes it is casting (spec 064), the player was stuck
 * on the spot permanently. Measured at 288 ticks of phantom cast before the fix.
 * A hit no longer ends a cast at all (spec 068), but the rule it taught stands
 * for every remaining ending: death, a cancel, and the release.
 */
describe('a cast the client is holding', () => {
  it('is never one the server has already dropped', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    const entityId = client.view().selfEntityId;
    const at = test.server.world.entities.get(entityId)?.position;
    expect(at).toBeDefined();
    if (!at) return;

    // Something big, already facing us, close enough to swing at once.
    test.server.spawnEntities('ravager', at.x + 40, at.y, 1);
    const live = test.server.world.entities as Map<number, ServerEntity>;
    for (const [id, entity] of live) {
      // Facing us, and already fighting us: nothing initiates since spec 076, so
      // a monster that is meant to swing has to be handed the grudge a hit
      // would have given it.
      if (entity.typeId === 'ravager') {
        live.set(id, { ...entity, facing: Math.PI, targetId: entityId });
      }
    }

    // A long cast, aimed away, so there is plenty of wind-up to be knocked out of.
    client.useAbility('ground.quake', at.x + 200, at.y);
    await settle();

    let phantomTicks = 0;
    for (let i = 0; i < 300; i++) {
      test.server.tick();
      await settle();
      const serverCasting = test.server.world.entities.get(entityId)?.cast !== null;
      const clientCasting = client.view().casts.some((cast) => cast.entityId === entityId);
      if (!serverCasting && clientCasting) phantomTicks += 1;
    }

    expect(phantomTicks).toBe(0);
    // And the fight actually happened -- otherwise this asserts nothing.
    expect(test.server.world.entities.get(entityId)?.health ?? 0).toBeLessThan(
      client.view().stats?.maxHealth ?? 0,
    );
  });

  it('survives being hit: the cast it was holding still releases (spec 068)', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    const entityId = client.view().selfEntityId;
    const at = test.server.world.entities.get(entityId)?.position;
    expect(at).toBeDefined();
    if (!at) return;
    const fullHealth = test.server.world.entities.get(entityId)?.health ?? 0;

    // Close enough and already facing us, so it swings while we are winding up.
    test.server.spawnEntities('ravager', at.x + 40, at.y, 1);
    const live = test.server.world.entities as Map<number, ServerEntity>;
    for (const [id, entity] of live) {
      // Facing us, and already fighting us: nothing initiates since spec 076, so
      // a monster that is meant to swing has to be handed the grudge a hit
      // would have given it.
      if (entity.typeId === 'ravager') {
        live.set(id, { ...entity, facing: Math.PI, targetId: entityId });
      }
    }

    const reasons: number[] = [];
    client.onCastEnded((end) => {
      if (end.entityId === entityId) reasons.push(end.reason);
    });

    // A long wind-up, aimed away, so there is plenty of it to be hit during.
    client.useAbility('ground.quake', at.x + 200, at.y);
    await settle();
    for (let i = 0; i < 200 && reasons.length === 0; i++) {
      test.server.tick();
      await settle();
    }

    // It was hit, it lived, and the blow it committed to went off anyway.
    const health = test.server.world.entities.get(entityId)?.health ?? 0;
    expect(health).toBeLessThan(fullHealth);
    expect(health).toBeGreaterThan(0);
    expect(reasons).toEqual([CastEndReason.Released]);
  });
});

/**
 * The client's clock.
 *
 * `view.tick` is the tick of the last delta, and deltas are suppressed when
 * nothing changed -- so a rooted caster alone in a field freezes it completely.
 * Anything drawn against it froze too: the cast bar stopped partway through a
 * wind-up and sat there while the wind-up ran on without it.
 */
describe('the estimated tick', () => {
  it('keeps time when the server has nothing to say', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    const entityId = client.view().selfEntityId;
    const at = test.server.world.entities.get(entityId)?.position;
    if (!at) return;

    // Commit to something long. The caster is rooted, nothing else is alive, so
    // the server stops sending deltas entirely.
    client.useAbility('ground.quake', at.x + 100, at.y);
    await settle();

    for (let i = 0; i < 40; i++) {
      test.server.tick();
      client.advanceTick();
      await settle();
    }

    const view = client.view();
    // The delta tick has genuinely stalled -- that is the condition, not a bug.
    expect(test.server.world.tick - view.tick).toBeGreaterThan(10);
    // ...and the estimate has not.
    expect(view.estimatedTick).toBe(test.server.world.tick);
  });

  it('never runs backwards when a delta describes an older frame', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    // Run the estimate ahead of anything the server has broadcast.
    for (let i = 0; i < 20; i++) client.advanceTick();
    const ahead = client.view().estimatedTick;

    await advance(test, 1);
    expect(client.view().estimatedTick).toBeGreaterThanOrEqual(ahead);
  });
});

/**
 * Cooldowns on the wire (spec 065). Before this the client could not know an
 * ability was unavailable until it asked and was refused, so a hotbar button had
 * nothing to draw.
 */
describe('cooldowns', () => {
  it('start empty, and are announced when a cast spends one', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);
    expect(client.view().cooldowns).toEqual({});

    const heavy = abilityById('melee.heavy');
    expect(heavy).toBeDefined();
    if (!heavy) return;

    client.useAbility('melee.heavy', 900, 500);
    await settle();
    test.server.tick();
    await settle();
    // Not while the blow is still being wound up (spec 091) -- it is spent by
    // the swing, not by the decision to start one.
    expect(client.view().cooldowns['melee.heavy']).toBeUndefined();

    await advance(test, heavy.windupTicks + 1);

    const readyAt = client.view().cooldowns['melee.heavy'];
    expect(readyAt).toBeGreaterThan(0);
    // And it is the server's number, not one the client worked out.
    const entityId = client.view().selfEntityId;
    expect(readyAt).toBe(test.server.world.entities.get(entityId)?.cooldowns['melee.heavy']);
  });

  /**
   * Spec 062 stamped the cooldown at the commit and handed it back on a cancel,
   * so that a last-moment withdrawal was not free. Spec 091 takes the earlier
   * half away instead: a wind-up that is withdrawn from never stamps one, so
   * there is no refund to announce and the button never greys for a swing that
   * did not happen. Pinned because "no cooldown, ever" is the whole claim.
   */
  it('are never announced for a cast that is withdrawn from', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    client.useAbility('melee.heavy', 900, 500);
    await settle();
    test.server.tick();
    await settle();
    expect(client.view().cooldowns['melee.heavy']).toBeUndefined();

    client.cancelCast();
    await settle();
    test.server.tick();
    await settle();
    expect(client.view().cooldowns['melee.heavy']).toBeUndefined();
  });

  /**
   * An entry the client already holds goes stale on its own: nothing needs to be
   * sent, because `readyAtTick` is in the past and the client's own subtraction
   * comes out negative. What must not happen is a *fresh* frame carrying it.
   */
  it('leaves an expired entry inert, and never re-sends it', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    const slash = abilityById('melee.slash');
    expect(slash).toBeDefined();
    if (!slash) return;

    client.useAbility('melee.slash', 900, 500);
    await settle();
    // The basic attack's cooldown is the caster's own delay, not the table's
    // number (spec 070, and since spec 088 the delay *is* the stat), so the
    // wait is asked for rather than assumed.
    const cadence = client.view().stats?.baseAttackTimeTicks ?? slash.cooldownTicks;
    for (let i = 0; i < cadence + slash.windupTicks + 10; i++) {
      test.server.tick();
      await settle();
    }

    // Held, but in the past -- the button draws no sweep.
    const readyAt = client.view().cooldowns['melee.slash'] ?? 0;
    expect(readyAt).toBeLessThan(test.server.world.tick);

    // Landing something else re-sends the map, and the dead entry is not in it.
    // It has to *land*: since spec 091 the stamp -- and so the frame -- waits
    // for the release rather than the commit.
    const heavy = abilityById('melee.heavy');
    expect(heavy).toBeDefined();
    if (!heavy) return;
    client.useAbility('melee.heavy', 900, 500);
    await settle();
    await advance(test, heavy.windupTicks + 2);
    expect(client.view().cooldowns['melee.slash']).toBeUndefined();
    expect(client.view().cooldowns['melee.heavy']).toBeGreaterThan(0);
  });
});

/**
 * The predicted root (spec 067). The server roots a caster and only says so a
 * round trip later; the client stops asking to move the moment it commits.
 */
describe('committing before the server has answered', () => {
  it('roots the client the moment the button is pressed', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);
    expect(client.view().selfRoot).toBeNull();

    client.useAbility('melee.slash', 900, 500);
    // No settle, no tick: nothing has been anywhere near the server.
    expect(client.view().selfRoot).toEqual({ x: 900, y: 500 });
  });

  it('gives the legs back when the server refuses', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    client.useAbility('melee.slash', 900, 500);
    await settle();
    test.server.tick();
    await settle();
    // Accepted, so the confirmed cast is what roots us now.
    expect(client.view().selfRoot).not.toBeNull();

    // A second press while that one runs is refused.
    client.useAbility('melee.slash', 900, 500);
    await settle();
    test.server.tick();
    await settle();

    const slash = abilityById('melee.slash');
    expect(slash).toBeDefined();
    if (!slash) return;
    // Run past the end of the cast and its cooldown; nothing may still root us.
    // The basic attack's cooldown is the caster's own delay, not the table's
    // number (spec 070, and since spec 088 the delay *is* the stat), so the
    // wait is asked for rather than assumed.
    const cadence = client.view().stats?.baseAttackTimeTicks ?? slash.cooldownTicks;
    for (let i = 0; i < cadence + slash.windupTicks + 10; i++) {
      test.server.tick();
      await settle();
    }
    expect(client.view().selfRoot).toBeNull();
  });

  it('does not predict a root for an ability it knows is on cooldown', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    client.useAbility('melee.heavy', 900, 500);
    await settle();
    test.server.tick();
    await settle();
    // Let the cast finish, leaving only the cooldown standing.
    const heavy = abilityById('melee.heavy');
    expect(heavy).toBeDefined();
    if (!heavy) return;
    for (let i = 0; i < heavy.windupTicks + 4; i++) {
      test.server.tick();
      await settle();
    }
    expect(client.view().selfRoot).toBeNull();
    expect(client.view().cooldowns['melee.heavy']).toBeGreaterThan(client.view().estimatedTick);

    // Pressing it again is refused by the server, and the client knows enough
    // not to stand still waiting to be told.
    client.useAbility('melee.heavy', 900, 500);
    expect(client.view().selfRoot).toBeNull();
  });

  it('lets go of a request nobody ever answered', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    // Ask, then lose the connection's ear: the server never sees it.
    client.useAbility('melee.slash', 900, 500);
    expect(client.view().selfRoot).not.toBeNull();
    for (let i = 0; i < 200; i++) client.advanceTick();
    expect(client.view().selfRoot).toBeNull();
  });

  it('withdraws the root when the cast is called off', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    client.useAbility('melee.heavy', 900, 500);
    expect(client.view().selfRoot).not.toBeNull();
    client.cancelCast();
    expect(client.view().selfRoot).toBeNull();
  });
});

/**
 * Turning (spec 064). The client asks for a heading; the server decides how much
 * of that turn actually happens this tick.
 */
describe('turn rate', () => {
  it('turns toward the requested heading rather than snapping to it', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    const entityId = client.view().selfEntityId;
    const turnRate = client.view().stats?.turnRate ?? 0;
    expect(turnRate).toBeGreaterThan(0);

    const start = test.server.world.entities.get(entityId)?.facing ?? 0;
    // Ask for a full reversal in one tick.
    await inputTick(test, client, { moveX: 0, moveY: 0, facing: start + Math.PI, buttons: 0 });

    const after = test.server.world.entities.get(entityId)?.facing ?? 0;
    const moved = Math.abs(after - start);
    expect(moved).toBeGreaterThan(0);
    // One tick of turn, not half a revolution.
    expect(moved).toBeLessThanOrEqual((turnRate * Math.PI) / 180 / SERVER_TICK_RATE + 1e-9);
  });

  it('gets there eventually, at the rate its stats allow', async () => {
    const test = harness();
    const client = await connect(test, 'alice');
    await advance(test, 1);

    const entityId = client.view().selfEntityId;
    const turnRate = client.view().stats?.turnRate ?? 0;
    const target = (test.server.world.entities.get(entityId)?.facing ?? 0) + Math.PI / 2;

    // A quarter turn takes 90/turnRate seconds; give it that many ticks plus one.
    const ticks = Math.ceil((90 / turnRate) * SERVER_TICK_RATE) + 1;
    for (let i = 0; i < ticks; i++) {
      await inputTick(test, client, { moveX: 0, moveY: 0, facing: target, buttons: 0 });
    }

    expect(test.server.world.entities.get(entityId)?.facing ?? 0).toBeCloseTo(target, 6);
  });
});
