/**
 * The strip a player actually reads, off a real session (spec 164).
 *
 * The last link in a chain whose two halves are each pinned down elsewhere: the
 * sim awards the experience (`server/client/death-and-experience.test.ts`) and
 * `xpBar` turns two numbers into a fraction (`xp-bar.test.ts`). Neither can make
 * this claim, because the first never draws anything and the second is handed
 * its numbers -- and the bug spec 164 exists to fix lived exactly in the join,
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

/**
 * Yield the event loop, so anything the loopback queued is delivered.
 *
 * `setImmediate` rather than `setTimeout(resolve, 0)` (spec 274). Node clamps a
 * zero timeout to one millisecond, so a settle awaited twice per simulated tick
 * cost 1.12ms of doing nothing against this call's 0.004ms -- 147 of the suite's
 * 330 CPU-seconds, and 39.6s of `rate-match.test.ts` alone. It is also the
 * stronger barrier: the check phase runs after the poll phase, where a timer
 * fires at the top of the next loop iteration.
 */
/**
 * Yield the event loop, so anything the loopback queued is delivered.
 *
 * `setImmediate` rather than `setTimeout(resolve, 0)` (spec 274). Node clamps a
 * zero timeout to one millisecond, so a settle awaited twice per simulated tick
 * cost 1.12ms of doing nothing against this call's 0.004ms -- 147 of the suite's
 * 330 CPU-seconds, and 39.6s of `rate-match.test.ts` alone. It is also the
 * stronger barrier: the check phase runs after the poll phase, where a timer
 * fires at the top of the next loop iteration.
 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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

    // Walk after it while swinging (spec 217): a grazer runs from whatever hit
    // it, and now that it survives the first blow that flee actually happens.
    const preyAt = (): { x: number; y: number } | null => {
      for (const entity of server.world.entities.values()) {
        if (entity.kind === EntityKindValue.Monster) {
          return { x: entity.position.x, y: entity.position.y };
        }
      }
      return null;
    };
    const meAt = (): { x: number; y: number } => {
      const body = server.world.entities.get(client.view().selfEntityId);
      return body ? { x: body.position.x, y: body.position.y } : at;
    };
    for (let swing = 0; swing < 40 && monsters() > 0; swing++) {
      const prey = preyAt();
      client.useAbility('melee.slash', prey?.x ?? at.x + 1000, prey?.y ?? at.y);
      for (let i = 0; i < 60; i++) {
        const here = meAt();
        const there = preyAt();
        const dx = there ? there.x - here.x : 0;
        const dy = there ? there.y - here.y : 0;
        const len = Math.hypot(dx, dy);
        const chase = len > 40 ? { moveX: dx / len, moveY: dy / len } : { moveX: 0, moveY: 0 };
        client.sendInput({ ...chase, facing: Math.atan2(dy, dx), buttons: 0 });
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
