/**
 * A status over the real wire (spec 186).
 *
 * The halves either side of this are pinned down on their own:
 * `net/delta.test.ts` says exactly what the server packs, one status at a time,
 * and `render/iso3d/world/status-marks.test.ts` says what a mark does with it.
 * What is only true once there is a socket is the join between them -- that a
 * status on a body reaches a *second* player's replica, that it is taken away
 * again when it runs out, and that the four ids the table withholds never leave
 * the server however live they are on it.
 *
 * Both ways in are real. The visible statuses arrive through
 * `admin:triggerEvent 'status'`, which is the path a person uses to look at this
 * and therefore the one worth having a test on; the withheld ones arrive by
 * landing an actual blow, because `RecentlyHit` and `InCombat` are written by
 * every blow that connects and a test that stuffed them in by hand would not be
 * making a claim about the server.
 */

import { describe, expect, it } from 'vitest';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';
import { StatusId } from '../sim/statuses.js';
import { ADAPTED_ID, STATUS_VISUALS, visualByWire, visualFor } from '../data/status-visuals.js';
import { statusMarks } from '../../render/iso3d/world/status-marks.js';
import { EntityKindValue } from '../sim/types.js';
import type { WireStatus } from '../net/messages.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Rig {
  readonly server: GameServer;
  readonly transport: LoopbackTransport;
  readonly clients: GameClient[];
  readonly tick: (times?: number) => Promise<void>;
}

function rig(): Rig {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 12, transport });
  // No ambient spawning: this test wants the bodies it puts there and no others.
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  const clients: GameClient[] = [];
  const tick = async (times = 1): Promise<void> => {
    for (let i = 0; i < times; i++) {
      server.tick();
      for (const client of clients) client.advanceTick();
      await settle();
    }
  };
  return { server, transport, clients, tick };
}

async function join(r: Rig, playerId: string): Promise<GameClient> {
  const client = new GameClient(r.transport.connect(), { playerId, displayName: playerId });
  const welcome = client.connect();
  await settle();
  await welcome;
  await settle();
  r.clients.push(client);
  return client;
}

function positionOf(r: Rig, entityId: number): { x: number; y: number } {
  const entity = r.server.world.entities.get(entityId);
  if (!entity) throw new Error(`no entity ${entityId}`);
  return { x: entity.position.x, y: entity.position.y };
}

/** What one client believes is on one body. */
function seenBy(client: GameClient, entityId: number): readonly WireStatus[] {
  const entity = client.view().entities.find((candidate) => candidate.id === entityId);
  return entity?.statuses ?? [];
}

/** Every status id the server itself has on a body, visible or not. */
function heldOn(r: Rig, entityId: number): readonly string[] {
  return Object.keys(r.server.world.entities.get(entityId)?.statuses ?? {});
}

/** Put every visible status on everything near a point, the way a developer would. */
function demo(r: Rig, at: { x: number; y: number }): string {
  return r.server.triggerEvent('status', at.x, at.y, 200);
}

describe('a status over the real wire (spec 186)', () => {
  it('reaches the body’s own client, and draws through to a mark', async () => {
    const r = rig();
    const eve = await join(r, 'eve');
    await r.tick(2);
    const self = eve.view().selfEntityId;

    demo(r, positionOf(r, self));
    await r.tick(4);

    const marks = statusMarks(seenBy(eve, self), eve.view().estimatedTick);
    expect(marks).toHaveLength(STATUS_VISUALS.length);
    // Including the collapsed family, which the trigger reaches through a real
    // `adapt:` key rather than by inventing one nothing else would read.
    expect(marks.map((one) => one.id)).toContain(ADAPTED_ID);
    // Ordered, coloured and drawable -- everything `hud.ts` needs off one call.
    expect(new Set(marks.map((one) => one.kind))).toEqual(new Set(['boon', 'affliction']));
    for (const one of marks) {
      expect(one.opacity, one.id).toBeGreaterThan(0);
      expect(one.icon, one.id).toBeTruthy();
    }
  });

  it('reaches somebody else watching, which is the whole point of Exposed', async () => {
    // The Weak-Point Study milestone says "everything takes 15% more damage
    // against it" -- worth something to every attacker, and until this spec no
    // attacker could see it.
    const r = rig();
    const eve = await join(r, 'eve');
    const bob = await join(r, 'bob');
    await r.tick(3);

    const target = eve.view().selfEntityId;
    demo(r, positionOf(r, target));
    await r.tick(4);

    const throughBob = seenBy(bob, target);
    expect(throughBob.length).toBe(STATUS_VISUALS.length);
    // Bob's picture of Eve is Eve's picture of Eve. A status is a fact about a
    // body, not a private note to whoever caused it.
    expect(throughBob).toEqual(seenBy(eve, target));
  });

  it('never sends the ids the table withholds, however live they are', async () => {
    const r = rig();
    const eve = await join(r, 'eve');
    await r.tick(2);
    const self = eve.view().selfEntityId;
    const at = positionOf(r, self);

    // A real blow, because `RecentlyHit` and `InCombat` are what every blow that
    // connects writes -- there is no need to invent them. The target is the
    // dummy rather than a grazer: a grazer has 24 health and dies to the first
    // swing, taking the reaction window to the grave with it, which is exactly
    // what this test is *not* about.
    r.server.spawnEntities('dummy', at.x + 40, at.y, 1);
    await r.tick(2);
    const monster = [...r.server.world.entities.values()].find(
      (entity) => entity.kind === EntityKindValue.Monster,
    );
    if (!monster) throw new Error('the grazer did not spawn');

    // Polled a tick at a time and stopped the instant the status is on, rather
    // than swung a fixed number of times and looked afterwards. Two reasons, and
    // both of them bit: `RecentlyHit` is a *reaction window* half a second wide,
    // so a coarse wait steps straight over it, and a grazer that dies takes the
    // status to the grave with it.
    let caught = false;
    for (let swing = 0; swing < 12 && !caught; swing += 1) {
      eve.useAbility('melee.slash', at.x + 40, at.y);
      for (let step = 0; step < 30 && !caught; step += 1) {
        await r.tick(1);
        caught = heldOn(r, monster.id).includes(StatusId.RecentlyHit);
      }
    }

    // The server has them, on both bodies: the attacker is in combat, and the
    // body that took the blow carries the reaction window too.
    expect(caught, 'no blow ever landed on the dummy').toBe(true);
    expect(heldOn(r, self)).toContain(StatusId.InCombat);
    expect(heldOn(r, monster.id)).toContain(StatusId.RecentlyHit);
    expect(heldOn(r, monster.id)).toContain(StatusId.InCombat);

    // And what crossed is exactly the subset the table names -- not "nothing",
    // because a real exchange does produce a visible status even for a character
    // who has built nothing: committing an attack leaves you Vulnerable, which
    // is the one row here that needs no milestone behind it.
    for (const body of [self, monster.id]) {
      const shipped = seenBy(eve, body).map((status) => visualByWire(status.wire)?.id);
      const withheld = heldOn(r, body).filter((id) => visualFor(id) === null);
      expect(withheld.length, `${body} should be carrying withheld ids`).toBeGreaterThan(0);
      for (const id of withheld) expect(shipped, id).not.toContain(id);
      // And nothing crossed that the table does not name.
      for (const id of shipped) expect(id, 'an unnamed id crossed the wire').toBeTruthy();
    }
  });

  it('shows something to a character who has built nothing', async () => {
    // The observability claim, and the reason this feature is not shipped dark.
    // Almost every row needs a milestone behind it -- Exposed needs Weak-Point
    // Study, Flow needs Quick Recovery -- so a fresh character could have gone on
    // seeing an empty row forever and nobody would have noticed the wire was
    // wrong. `Vulnerable` is the exception: it is written on *commit*, by
    // `startCast`, for anybody who swings at anything.
    const r = rig();
    const eve = await join(r, 'eve');
    await r.tick(2);
    const self = eve.view().selfEntityId;
    const at = positionOf(r, self);

    let marked = false;
    eve.useAbility('melee.slash', at.x + 40, at.y);
    for (let step = 0; step < 40 && !marked; step += 1) {
      await r.tick(1);
      marked = statusMarks(seenBy(eve, self), eve.view().estimatedTick).some(
        (mark) => mark.id === StatusId.Vulnerable,
      );
    }
    expect(marked, 'swinging should mark you Vulnerable, with no build at all').toBe(true);
  });

  it('takes the marks away when the window runs out', async () => {
    const r = rig();
    const eve = await join(r, 'eve');
    await r.tick(2);
    const self = eve.view().selfEntityId;

    demo(r, positionOf(r, self));
    await r.tick(4);
    expect(seenBy(eve, self).length).toBe(STATUS_VISUALS.length);

    // Past the demo window. The empty list has to be *sent*, or a status could
    // only ever be added.
    await r.tick(640);
    expect(seenBy(eve, self)).toEqual([]);
    expect(statusMarks(seenBy(eve, self), eve.view().estimatedTick)).toHaveLength(0);
  });

  it('does not resend a set that has not changed', async () => {
    const r = rig();
    const eve = await join(r, 'eve');
    await r.tick(2);
    const self = eve.view().selfEntityId;

    demo(r, positionOf(r, self));
    await r.tick(6);
    const before = seenBy(eve, self);
    expect(before.length).toBeGreaterThan(0);

    // Several broadcast intervals later, still the same answer -- the field is a
    // delta like every other one, not a per-tick snapshot.
    await r.tick(30);
    expect(seenBy(eve, self)).toEqual(before);
  });

  it('tells a client that arrives mid-status, with no start to have watched', async () => {
    const r = rig();
    const eve = await join(r, 'eve');
    await r.tick(2);
    const target = eve.view().selfEntityId;
    demo(r, positionOf(r, target));
    await r.tick(10);

    // Bob was not connected when any of it was applied.
    const bob = await join(r, 'bob');
    await r.tick(6);

    const marks = statusMarks(seenBy(bob, target), bob.view().estimatedTick);
    expect(marks.length).toBe(STATUS_VISUALS.length);
  });
});
