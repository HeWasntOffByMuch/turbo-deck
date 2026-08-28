/**
 * A socket that comes back (spec 150).
 *
 * The claim under test is not "the client reconnects" -- it is that the *same
 * body* comes back, and that nothing was orphaned while it was away. Both need
 * a real server, so this drives one.
 */

import { describe, expect, it } from 'vitest';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';
import { CONNECTION_TIMEOUT_TICKS, RESUME_GRACE_TICKS } from '../config.js';
import { EntityKind, TradeStageValue } from '../net/protocol.js';
import type { Channel } from '../net/transport.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Rig {
  readonly server: GameServer;
  readonly transport: LoopbackTransport;
  readonly tick: (times?: number) => Promise<void>;
  bodies(): number;
}

function rig(): Rig {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 4, transport });
  server.liveConfig.set('spawnRateMultiplier', 0);
  transport.onConnection((channel) => server.accept(channel));
  const tick = async (times = 1): Promise<void> => {
    for (let i = 0; i < times; i++) {
      server.tick();
      await settle();
    }
  };
  const bodies = (): number => {
    let n = 0;
    for (const entity of server.world.entities.values()) {
      if (entity.kind === EntityKind.Player) n += 1;
    }
    return n;
  };
  return { server, transport, tick, bodies };
}

/**
 * Join, optionally presenting a token from an earlier session.
 *
 * A fresh `GameClient` per join rather than reusing one, because that is what a
 * *reloaded tab* is -- and it is the harder case: the in-process reconnect path
 * keeps its token in a field, while this one has to carry it across the
 * constructor, which is the API a page reload needs.
 */
async function join(
  r: Rig,
  playerId: string,
  resumeToken = '',
): Promise<{ client: GameClient; channel: Channel; entityId: number; token: string }> {
  const channel = r.transport.connect();
  const client = new GameClient(channel, { playerId, displayName: playerId, resumeToken });
  const welcome = client.connect();
  await settle();
  const info = await welcome;
  await settle();
  return { client, channel, entityId: info.entityId, token: client.sessionToken };
}

describe('a dropped socket', () => {
  it('leaves the body standing, then reaps it', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(4);
    expect(r.bodies()).toBe(1);

    ana.channel.close();
    await settle();
    await r.tick(4);
    // Still there: resumable, and not an escape from whatever was happening.
    expect(r.bodies()).toBe(1);
    expect(r.server.world.entities.has(ana.entityId)).toBe(true);

    await r.tick(RESUME_GRACE_TICKS + 2);
    expect(r.bodies()).toBe(0);
    expect(r.server.playerManager.get('ana')).toBeNull();
  });

  it('comes back to the same body, with the token', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    // Walk, so the resumed position is distinguishable from a fresh spawn.
    for (let i = 0; i < 60; i++) {
      ana.client.sendInput({ moveX: 1, moveY: 0, facing: 0, buttons: 0 });
      await r.tick();
    }
    const movedTo = r.server.world.entities.get(ana.entityId)?.position.x ?? 0;
    expect(movedTo).toBeGreaterThan(600);

    ana.channel.close();
    await settle();
    await r.tick(30);

    const back = await join(r, 'ana', ana.token);
    expect(back.entityId).toBe(ana.entityId);
    expect(r.bodies()).toBe(1);
    expect(r.server.world.entities.get(back.entityId)?.position.x).toBeCloseTo(movedTo, 5);
  });

  it('is a new login without a token, or with somebody else’s', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    const ben = await join(r, 'ben');
    await r.tick(4);

    ana.channel.close();
    await settle();
    await r.tick(10);

    // No token: a fresh body, and the lingering one still lingering.
    const plain = await join(r, 'ana');
    expect(plain.entityId).not.toBe(ana.entityId);

    // Ben's token must not claim Ana's session.
    const r2 = rig();
    const ana2 = await join(r2, 'ana');
    const ben2 = await join(r2, 'ben');
    await r2.tick(4);
    ana2.channel.close();
    await settle();
    await r2.tick(10);
    const thief = await join(r2, 'ana', ben2.token);
    expect(thief.entityId).not.toBe(ana2.entityId);
    expect(ben.entityId).toBeGreaterThan(0);
  });

  it('says goodbye and is gone at once', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(4);
    ana.client.disconnect();
    await settle();
    await r.tick(4);
    // No grace: leaving on purpose and being dropped are different things.
    expect(r.bodies()).toBe(0);
  });

  it('is disconnected by silence, without any close arriving', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    await r.tick(4);
    expect(r.bodies()).toBe(1);

    // The socket is fine; the client has simply stopped talking. Nothing fires
    // a close -- which is exactly the case a dead router produces.
    await r.tick(CONNECTION_TIMEOUT_TICKS + 4);
    expect(r.server.world.entities.has(ana.entityId)).toBe(true);
    await r.tick(RESUME_GRACE_TICKS + 4);
    expect(r.bodies()).toBe(0);
  });
});

describe('nothing is orphaned by a drop', () => {
  it('cancels the trade for both sides, keeping every item', async () => {
    const r = rig();
    const ana = await join(r, 'ana');
    const ben = await join(r, 'ben');
    await r.tick(6);

    const countAll = (): number => {
      let n = 0;
      for (const id of ['ana', 'ben']) {
        for (const stack of r.server.playerManager.get(id)?.record.inventory ?? []) {
          if (stack) n += stack.count;
        }
      }
      return n;
    };
    const before = countAll();

    ana.client.inviteToTrade(ben.entityId);
    await r.tick(4);
    ben.client.respondToTrade(true);
    await r.tick(4);
    expect(ana.client.view().trade?.stage).toBe(TradeStageValue.Open);

    ana.channel.close();
    await settle();
    await r.tick(4);

    // Ben is told at once -- his body may be resumable, but a live trade with
    // somebody who may never return is not.
    expect(ben.client.view().trade).toBeNull();
    // And the total across both bags is what it was.
    expect(countAll()).toBe(before);
  });
});
