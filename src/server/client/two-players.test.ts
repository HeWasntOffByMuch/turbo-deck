/**
 * Two players, one world (spec 145): two real clients, one real server.
 *
 * `trade-wire.test.ts` already proved two clients can share a server. This is
 * the rest of what "playable by two people" means, and every assertion here is
 * about something one client can observe about *the other* -- which is the
 * whole category nothing has ever tested, because until spec 144 there was
 * never a second person to observe.
 *
 * No browser. The wire is the same wire either way, and the loopback exchanges
 * the identical bytes a socket would (see transport-loop.ts) -- the socket path
 * itself is covered in `net/transport-browser.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';
import { ZoneManager, type ZoneDefinition } from '../world/zone-manager.js';
import { EntityKind, EntityActivity, EntityField } from '../net/protocol.js';
import { RESUME_GRACE_TICKS } from '../config.js';
import { BASIC_ATTACK_ID } from '../data/abilities.js';
import { DEFAULT_SPAWN } from '../player/player-manager.js';
import { isHostile } from '../sim/world.js';
import { PLAYER_BODY_RADIUS } from '../sim/world.js';
import type { ServerEntity } from '../sim/types.js';
import type { ReplicatedEntity } from './replica.js';
import { buildWorldFromMap, type BuiltMapWorld } from '../world/build.js';
import { findPath, navGridFor } from '../../sim/pathfinding.js';
import { SERVER_PLAYER_RADIUS } from '../config.js';
import { loadMapFile } from '../../server/world/map-file.js';

/** The real arena, for the one test that needs the map's spawn points. */
const shippedMap = loadMapFile();

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The arena's own zones put spawn inside `hearth`, which is exactly what we want. */
const SAFE_ZONES: readonly ZoneDefinition[] = [
  { id: 'hearth', displayName: 'Hearthstead', bounds: { x: 0, y: 0, w: 2000, h: 2000 }, pvp: false, spawnMultiplier: 0 },
];
/** Nothing declared, so every point falls through to WILDERNESS, which is pvp. */
const HOSTILE_ZONES: readonly ZoneDefinition[] = [];

interface Harness {
  readonly server: GameServer;
  readonly ana: GameClient;
  readonly ben: GameClient;
  readonly tick: (times?: number) => Promise<void>;
  /** Present only with `monsters: true`; what the sim is routing against. */
  readonly built?: BuiltMapWorld;
}

async function harness(
  zones: readonly ZoneDefinition[] = SAFE_ZONES,
  options: { monsters?: boolean } = {},
): Promise<Harness> {
  const transport = new LoopbackTransport();
  // The real map only when monsters are wanted: it is what carries the spawn
  // points, and building it is a second of work no other test here needs.
  const built = options.monsters === true ? buildWorldFromMap(shippedMap.doc, shippedMap.mapId) : undefined;
  const server = new GameServer({
    seed: 5,
    transport,
    zones: new ZoneManager(zones),
    ...(built ? { built } : {}),
  });
  // No wandering monsters unless a test wants them: most of these are about
  // two players and nothing else.
  if (options.monsters !== true) server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));

  const ana = new GameClient(transport.connect(), { playerId: 'ana', displayName: 'Ana' });
  const ben = new GameClient(transport.connect(), { playerId: 'ben', displayName: 'Ben' });
  const welcomes = Promise.all([ana.connect(), ben.connect()]);
  await settle();
  await welcomes;
  await settle();

  const tick = async (times = 1): Promise<void> => {
    for (let i = 0; i < times; i++) {
      server.tick();
      ana.advanceTick();
      ben.advanceTick();
      await settle();
    }
  };
  await tick(6);
  return { server, ana, ben, tick, ...(built ? { built } : {}) };
}

function seen(client: GameClient, id: number): ReplicatedEntity | undefined {
  return client.view().entities.find((entity) => entity.id === id);
}

describe('two players in one world', () => {
  it('see each other, by name', async () => {
    const { ana, ben } = await harness();
    const anaId = ana.view().selfEntityId;
    const benId = ben.view().selfEntityId;
    expect(anaId).not.toBe(benId);

    // Each replica holds the other's body, and it is somebody rather than an
    // anonymous shape -- the whole point of the Identity field.
    expect(seen(ana, benId)?.name).toBe('Ben');
    expect(seen(ben, anaId)?.name).toBe('Ana');
    // And a monster is still nameless on the wire: its name is in a table.
    for (const entity of ana.view().entities) {
      if (entity.kind !== EntityKind.Player) expect(entity.name).toBe('');
    }
  });

  it('replicates a remote player turn rate, so nothing has to guess it', async () => {
    const { ana, ben } = await harness();
    const benId = ben.view().selfEntityId;
    const rate = seen(ana, benId)?.turnRate ?? 0;
    expect(rate).toBeGreaterThan(0);
    // It is Ben's real rate, not a guess: the same number Ben was told about himself.
    expect(rate).toBeCloseTo(ben.view().stats?.turnRate ?? -1, 5);
  });

  it('do not start inside each other', async () => {
    const { server } = await harness();
    const ana = server.playerManager.get('ana')?.record.position;
    const ben = server.playerManager.get('ben')?.record.position;
    if (!ana || !ben) throw new Error('both players should exist');
    const gap = Math.hypot(ana.x - ben.x, ana.y - ben.y);
    expect(gap).toBeGreaterThanOrEqual(PLAYER_BODY_RADIUS * 2.5 - 1e-6);
    // One of them is still on the hub itself, so nobody was moved further than
    // they had to be.
    const onBase = [ana, ben].filter(
      (at) => Math.hypot(at.x - DEFAULT_SPAWN.x, at.y - DEFAULT_SPAWN.y) < 1e-6,
    );
    expect(onBase).toHaveLength(1);
  });

  it('fight the same monster, and both see it take the damage', async () => {
    // Monsters on, so there is something to fight. Wilderness everywhere, so
    // the spawn multiplier is not zeroed by a safe zone.
    const { server, ana, ben, tick, built } = await harness(HOSTILE_ZONES, { monsters: true });
    if (!built) throw new Error('monsters: true should have built the real world');

    // The sim's own router, over the same colliders and the same ground the
    // server is walking bodies through -- `GameServer` takes `built.sampler` as
    // its terrain, so this is the grid the server itself would route on.
    const grid = navGridFor(SERVER_PLAYER_RADIUS, built.colliders, built.sampler);
    const from = (): { x: number; y: number } => {
      const at = server.playerManager.get('ana')?.record.position;
      if (!at) throw new Error('ana should exist');
      return { x: at.x, y: at.y };
    };

    // Find a monster both of them can see, and walk Ana onto it. Walked rather
    // than teleported for the reason trade-wire.test.ts gives: a tick mirrors
    // authoritative positions back, so a hand-written record does not stick.
    //
    // *Nearest reachable*, rather than whichever the replica happens to list
    // first. Entity ids are handed out in the map's authored spawner order, so
    // "first" is a fact about how somebody wrote a JSON file: on the shipped map
    // it is a spider 1,421 units away across a wood, and the test spent its whole
    // budget pressed against a tree. Both filters are load-bearing -- the map's
    // nearest monsters are five sheep in a fenced pasture that is a disconnected
    // nav component, so `findPath` refuses them, which is correct and is exactly
    // what "reachable" is here to skip. This is about two replicas agreeing on
    // one body's health; getting to that body is not the claim.
    let monsterId = -1;
    for (let i = 0; i < 600 && monsterId < 0; i++) {
      await tick();
      const theirs = new Set(ben.view().entities.filter((e) => e.kind === EntityKind.Monster).map((e) => e.id));
      const me = from();
      const shared = ana
        .view()
        .entities.filter((e) => e.kind === EntityKind.Monster && e.health > 0 && theirs.has(e.id))
        .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))
        .find((e) => findPath(grid, me, { x: e.x, y: e.y }).length > 0);
      if (shared) monsterId = shared.id;
    }
    expect(monsterId).toBeGreaterThan(0);

    const before = seen(ana, monsterId)?.health ?? 0;
    expect(before).toBeGreaterThan(0);

    // The point of the test, checked every tick rather than once at the end: it
    // is the same body in both replicas, with the same health. A client told
    // about a different monster, or told late, disagrees here.
    //
    // Every tick, because the end is no longer a reliable place to stand. A
    // basic attack multiplies by `weaponPower` since spec 147, and 14 damage at
    // 1.84x takes a 24-health grazer off the board in one blow -- so a check
    // that runs after the fight compares two clients that both correctly see
    // nothing, and proves nothing. Agreement while it is alive is the claim.
    let agreedWhileAlive = 0;
    const disagreed: string[] = [];
    const compare = (): void => {
      const mine = seen(ana, monsterId);
      const theirs = seen(ben, monsterId);
      if (mine?.health !== theirs?.health) {
        disagreed.push(`${mine?.health ?? 'gone'} vs ${theirs?.health ?? 'gone'}`);
      } else if (mine) {
        agreedWhileAlive++;
      }
    };

    // Walked along a route rather than straight at it, for the reason
    // `bench-walk.ts` states: a raw held direction walks into the first tree it
    // meets and stops there. Re-planned on a cadence because the target moves.
    let path: readonly { readonly x: number; readonly y: number }[] = [];
    let leg = 0;
    let landed = false;
    for (let i = 0; i < 1800 && !landed; i++) {
      const me = server.playerManager.get('ana')?.record.position;
      const it = seen(ana, monsterId);
      if (!me || !it) break;
      const dx = it.x - me.x;
      const dy = it.y - me.y;
      const away = Math.hypot(dx, dy);
      if (away > 40) {
        if (i % 60 === 0) {
          path = findPath(grid, { x: me.x, y: me.y }, { x: it.x, y: it.y });
          leg = 0;
        }
        while (leg < path.length && Math.hypot(path[leg]!.x - me.x, path[leg]!.y - me.y) < 30) leg++;
        // Past the last waypoint, or no route this tick: straight at the body.
        const aim = leg < path.length ? path[leg]! : { x: it.x, y: it.y };
        const ax = aim.x - me.x;
        const ay = aim.y - me.y;
        const reach = Math.hypot(ax, ay) || 1;
        ana.sendInput({ moveX: ax / reach, moveY: ay / reach, facing: Math.atan2(dy, dx), buttons: 0 });
      } else {
        ana.useAbility(BASIC_ATTACK_ID, it.x, it.y, monsterId, 22);
      }
      await tick();
      compare();
      // Gone counts as damage. One blow that empties the bar and one that halves
      // it are the same event from here, and only one of them leaves a number
      // behind to subtract.
      const now = seen(ana, monsterId);
      if (!now || now.health < before) landed = true;
    }
    expect(landed).toBe(true);
    expect(disagreed).toEqual([]);
    expect(agreedWhileAlive).toBeGreaterThan(0);
  }, 30_000);
});

describe('PvP is the ground you are standing on', () => {
  async function strike(zones: readonly ZoneDefinition[]): Promise<number> {
    const { server, ana, ben, tick } = await harness(zones);
    const benId = ben.view().selfEntityId;
    const target = server.playerManager.get('ben')?.record.position;
    if (!target) throw new Error('ben should exist');
    const before = seen(ana, benId)?.health ?? 0;
    for (let i = 0; i < 120; i++) {
      ana.useAbility(BASIC_ATTACK_ID, target.x, target.y, benId, PLAYER_BODY_RADIUS);
      await tick();
    }
    return before - (seen(ana, benId)?.health ?? before);
  }

  it('does nothing in a safe zone', async () => {
    expect(await strike(SAFE_ZONES)).toBe(0);
  });

  it('lands in the wilderness', async () => {
    expect(await strike(HOSTILE_ZONES)).toBeGreaterThan(0);
  });

  it('needs hostile ground at both ends', () => {
    // The table, asserted at the rule rather than through a 600-unit walk.
    const zones = new ZoneManager([
      { id: 'safe', displayName: 'Safe', bounds: { x: 0, y: 0, w: 100, h: 100 }, pvp: false, spawnMultiplier: 0 },
    ]);
    const player = (id: number, x: number, y: number): ServerEntity =>
      ({
        id,
        kind: EntityKind.Player,
        typeId: 'player',
        ownerPlayerId: `p${id}`,
        position: { x, y, z: 0 },
      }) as unknown as ServerEntity;

    const inSafe = player(1, 50, 50);
    const inWilds = player(2, 500, 500);
    const alsoWilds = player(3, 600, 600);
    const alsoSafe = player(4, 10, 10);

    // Both in the wilds: a fight.
    expect(isHostile(inWilds, alsoWilds, zones)).toBe(true);
    // Both safe: nothing.
    expect(isHostile(inSafe, alsoSafe, zones)).toBe(false);
    // Reaching IN from the wilds -- what used to be allowed, and the reason
    // this changed. Standing in a safe zone has to mean something.
    expect(isHostile(inWilds, inSafe, zones)).toBe(false);
    // And reaching OUT of one, which is the same exploit wearing the other hat.
    expect(isHostile(inSafe, inWilds, zones)).toBe(false);
  });
});

describe('a death is readable from outside', () => {
  it('shows the fall and the return, on the same entity id', async () => {
    const { server, ana, ben, tick } = await harness(HOSTILE_ZONES);
    const benId = ben.view().selfEntityId;
    const target = server.playerManager.get('ben')?.record.position;
    if (!target) throw new Error('ben should exist');

    let died = false;
    for (let i = 0; i < 3000 && !died; i++) {
      ana.useAbility(BASIC_ATTACK_ID, target.x, target.y, benId, PLAYER_BODY_RADIUS);
      await tick();
      const body = seen(ana, benId);
      if (body && body.health <= 0) died = true;
    }
    expect(died).toBe(true);
    // Ana can see that Ben is down, not merely that he stopped moving.
    expect(seen(ana, benId)?.activity).toBe(EntityActivity.Dead);

    // And back up again, as the same body -- once he asks. Nothing puts a dead
    // player back on their feet on a timer since spec 164, which is what makes
    // the respawn button a button; what this test is about is that the *other*
    // player watches both halves happen to one entity id.
    ben.respawn();
    let alive = false;
    for (let i = 0; i < 600 && !alive; i++) {
      await tick();
      const body = seen(ana, benId);
      if (body && body.health > 0) alive = true;
    }
    expect(alive).toBe(true);
    expect(ben.view().selfEntityId).toBe(benId);
    expect(seen(ana, benId)?.health).toBeGreaterThan(0);
  }, 30_000);
});

describe('a client that says hello twice', () => {
  it('gets one body, not two, and leaves nothing behind when it goes', async () => {
    const transport = new LoopbackTransport();
    const server = new GameServer({ seed: 5, transport, zones: new ZoneManager(SAFE_ZONES) });
    server.liveConfig.set('spawnRateMultiplier', 0);
    transport.onConnection((channel) => server.accept(channel));

    const channel = transport.connect();
    const client = new GameClient(channel, { playerId: 'ana', displayName: 'Ana' });
    await client.connect();
    await settle();

    const countPlayers = (): number => {
      let n = 0;
      for (const entity of server.world.entities.values()) {
        if (entity.kind === EntityKind.Player) n += 1;
      }
      return n;
    };
    expect(countPlayers()).toBe(1);

    // A second Hello on the same socket. This used to spawn a second body and
    // overwrite the connection's entity id with it, so the first belonged to
    // nobody and was reaped by nothing.
    await client.connect().catch(() => undefined);
    await settle();
    server.tick();
    await settle();
    expect(countPlayers()).toBe(1);

    // And the one body lingers when the socket drops, then goes (spec 150):
    // a dropped player is resumable for a while, which is what stops pulling
    // the plug being an escape.
    channel.close();
    await settle();
    await settle();
    expect(countPlayers()).toBe(1);
    for (let i = 0; i < RESUME_GRACE_TICKS + 2; i++) server.tick();
    await settle();
    expect(countPlayers()).toBe(0);
  });
});

describe('the wire', () => {
  it('has a bit for identity that is distinct from every other field', () => {
    const all = [
      EntityField.Spawn,
      EntityField.Position,
      EntityField.Facing,
      EntityField.Health,
      EntityField.Activity,
      EntityField.Level,
      EntityField.Identity,
    ];
    expect(new Set(all).size).toBe(all.length);
    // It has to survive a u8 fields byte, which is what the codec writes.
    expect(EntityField.Identity).toBeLessThanOrEqual(0x80);
  });
});
