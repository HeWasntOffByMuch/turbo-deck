/**
 * The strip a player actually reads, off a real session (spec 163).
 *
 * The last link in a chain whose two halves are each pinned down elsewhere: the
 * sim awards the experience (`server/client/death-and-experience.test.ts`) and
 * `xpBar` turns two numbers into a fraction (`xp-bar.test.ts`). Neither can make
 * this claim, because the first never draws anything and the second is handed
 * its numbers -- and the bug spec 163 exists to fix lived exactly in the join,
 * where an award nobody could reach fed a bar nobody had built.
 *
 * On this side of the tree rather than beside the server test, so the dependency
 * points the way it always does: the renderer reads the server, never the other
 * way round.
 */

import { describe, expect, it } from 'vitest';
import { GameClient } from '../../../server/client/game-client.js';
import { monsterById } from '../../../server/data/monsters.js';
import { LoopbackTransport } from '../../../server/net/transport-loop.js';
import { GameServer } from '../../../server/server.js';
import { EntityKindValue } from '../../../server/sim/types.js';
import { xpBar } from './xp-bar.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the experience strip, off a real kill', () => {
  it('moves off zero when something dies', async () => {
    const transport = new LoopbackTransport();
    const server = new GameServer({ seed: 8, transport });
    // Nothing ambient: an unrelated kill would be experience arriving from
    // somewhere this test is not looking.
    server.liveConfig.set('spawnRateMultiplier', 0);
    transport.onConnection((channel) => server.accept(channel));

    const client = new GameClient(transport.connect(), { playerId: 'alice', displayName: 'alice' });
    const welcome = client.connect();
    await settle();
    await welcome;
    await settle();

    const tick = async (times = 1): Promise<void> => {
      for (let i = 0; i < times; i++) {
        server.tick();
        client.advanceTick();
        await settle();
      }
    };
    await tick(2);

    expect(xpBar(client.view().level, client.view().experience).fraction).toBe(0);

    const self = server.world.entities.get(client.view().selfEntityId);
    if (!self) throw new Error('no body');
    const at = { x: self.position.x, y: self.position.y };
    server.spawnEntities('grazer', at.x + 40, at.y, 1);
    await tick(2);

    const monsters = (): number => {
      let n = 0;
      for (const entity of server.world.entities.values()) {
        if (entity.kind === EntityKindValue.Monster) n += 1;
      }
      return n;
    };

    for (let swing = 0; swing < 40 && monsters() > 0; swing++) {
      client.useAbility('melee.slash', at.x + 1000, at.y);
      for (let i = 0; i < 60; i++) {
        client.sendInput({ moveX: 0, moveY: 0, facing: 0, buttons: 0 });
        await tick();
      }
    }
    expect(monsters(), 'the grazer should be dead').toBe(0);
    await tick(10);

    const bar = xpBar(client.view().level, client.view().experience);
    expect(bar.current).toBe(monsterById('grazer')?.experience ?? -1);
    expect(bar.fraction).toBeGreaterThan(0);
    expect(bar.percentText).not.toBe('0.0%');
    expect(bar.detail).toContain(`${bar.current} / ${bar.toNext}`);
  }, 30000);
});
