/**
 * One player, one connection (spec 157).
 *
 * Three doors led to a live client being told "not logged in" while its body
 * stood in the world and its socket was up, and all three are the same rule
 * missing: a `playerId` may have at most one live connection, and nothing may
 * end a session that somebody is still holding. Each test below is one door.
 */

import { describe, expect, it } from 'vitest';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';
import { CONNECTION_TIMEOUT_TICKS, RESUME_GRACE_TICKS } from '../config.js';
import { DEFAULT_BACKOFF_TICKS } from '../net/reconnecting.js';
import { EntityKind } from '../net/protocol.js';
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

interface Joined {
  readonly client: GameClient;
  readonly channel: Channel;
  readonly entityId: number;
}

async function join(r: Rig, playerId: string, resumeToken = ''): Promise<Joined> {
  const channel = r.transport.connect();
  const client = new GameClient(channel, { playerId, displayName: playerId, resumeToken });
  const welcome = client.connect();
  await settle();
  const info = await welcome;
  await settle();
  return { client, channel, entityId: info.entityId };
}

/** Ticks the server while `who` stays genuinely alive -- it pings, so it is not timed out. */
async function tickAlive(r: Rig, who: Joined, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    r.server.tick();
    who.client.advanceTick();
    await settle();
  }
}

describe('a second login for a player who is already playing', () => {
  it('takes the body over rather than spawning beside it', async () => {
    const r = rig();
    const first = await join(r, 'ana');
    await r.tick(4);
    const before = r.server.world.entities.get(first.entityId)?.position;

    const second = await join(r, 'ana');
    await r.tick(4);

    expect(second.entityId).toBe(first.entityId);
    expect(r.bodies()).toBe(1);
    expect(r.server.world.entities.get(second.entityId)?.position).toEqual(before);
  });

  it('leaves the displaced connection holding nothing', async () => {
    const r = rig();
    const first = await join(r, 'ana');
    await r.tick(4);
    const second = await join(r, 'ana');
    await r.tick(4);

    // The displaced socket closes. That must not reap what the new one holds --
    // not now, and not when the grace it never got would have run out.
    first.channel.close();
    await settle();
    await tickAlive(r, second, CONNECTION_TIMEOUT_TICKS + RESUME_GRACE_TICKS + 60);

    expect(r.server.players.get('ana')).not.toBeNull();
    expect(r.bodies()).toBe(1);
  });

  // Door 1, and the common one: the client recovers from a blip the server has
  // not noticed, so its perfectly good token matches no lingering entry.
  it('door 1: a reconnect the server has not noticed keeps the session', async () => {
    const r = rig();
    const old = await join(r, 'cat');
    await r.tick(4);

    const revived = await join(r, 'cat', old.client.sessionToken);
    await r.tick(4);
    expect(revived.entityId).toBe(old.entityId);

    await tickAlive(r, revived, CONNECTION_TIMEOUT_TICKS + RESUME_GRACE_TICKS + 60);
    expect(r.server.players.get('cat')).not.toBeNull();
    expect(r.bodies()).toBe(1);
  });

  // Door 2: two tabs on one id -- a duplicated tab, a shared `?id=` link, two
  // bots with the same name. The one that leaves used to log the other out.
  it('door 2: a clean goodbye from the displaced tab does not log the other out', async () => {
    const r = rig();
    const tabA = await join(r, 'bob');
    await r.tick(4);
    const tabB = await join(r, 'bob');
    await r.tick(4);

    tabA.client.disconnect();
    await settle();
    await tickAlive(r, tabB, 8);

    expect(r.server.players.get('bob')).not.toBeNull();
    expect(r.bodies()).toBe(1);
  });

  // Door 3: the stored token went stale, so the reload is a fresh login beside
  // a lingering body -- whose reap used to take the live session with it.
  it('door 3: a stale token relogin survives the old body being reaped', async () => {
    const r = rig();
    const first = await join(r, 'dee');
    await r.tick(4);
    first.channel.close();
    await settle();
    await r.tick(4);
    expect(r.bodies()).toBe(1);

    const second = await join(r, 'dee', 'not-the-token');
    await r.tick(4);
    // The body left behind is cleared now rather than reaped into this session
    // half a minute from now.
    expect(r.bodies()).toBe(1);

    await tickAlive(r, second, RESUME_GRACE_TICKS + 60);
    expect(r.server.players.get('dee')).not.toBeNull();
    expect(r.bodies()).toBe(1);
  });

  it('orphans nothing: two drops on one id leave no body behind', async () => {
    const r = rig();
    const a = await join(r, 'eve');
    await r.tick(4);
    a.channel.close();
    await settle();

    const b = await join(r, 'eve', '');
    await r.tick(4);
    b.channel.close();
    await settle();

    await r.tick(RESUME_GRACE_TICKS * 2 + 120);
    expect(r.bodies()).toBe(0);
    expect(r.server.players.get('eve')).toBeNull();
  });

  // The invariant this change could plausibly break: the ownership check must
  // not make a session immortal.
  it('still reaps a client that simply goes silent', async () => {
    const r = rig();
    const ana = await join(r, 'fay');
    await r.tick(4);
    expect(r.bodies()).toBe(1);

    // No close, no pings -- a dead router. Timed out, then reaped.
    await r.tick(CONNECTION_TIMEOUT_TICKS + RESUME_GRACE_TICKS + 60);
    expect(r.bodies()).toBe(0);
    expect(r.server.players.get('fay')).toBeNull();
    expect(ana.entityId).toBeGreaterThanOrEqual(0);
  });
});

describe('the reconnect ladder', () => {
  it('outlasts the grace the server holds a body for', () => {
    const total = DEFAULT_BACKOFF_TICKS.reduce((sum, ticks) => sum + ticks, 0);
    expect(total).toBeGreaterThan(RESUME_GRACE_TICKS);
  });
});
