/**
 * The order a respawn arrives in (spec 281).
 *
 * The respawn cover lifts when the body is alive and the ground around it has
 * arrived, and it reads "alive" off `ClientView.selfDead` and "around it" off
 * `ClientView.self`. Those are two different messages: `respawn()` sends the
 * `Correction` carrying the teleport synchronously inside its own handler, and
 * the health rides the next 20Hz delta.
 *
 * If they could ever land the other way round there would be one settled frame
 * where the body reads alive and is still standing at the death site -- whose
 * ground is fully held, because that is where it has been playing -- and the
 * cover would lift on it, one frame before the world went away underneath the
 * player. That is the whole failure the feature exists to prevent, and it would
 * show up as a single frame of void nobody could reproduce on purpose.
 *
 * So it is asserted here, in the terms the gate reads it in, rather than left as
 * a fact about two `send` calls in the server that somebody could reorder.
 *
 * A real loopback and real messages, `death-and-experience.test.ts`'s rig: what
 * is being claimed is about the wire, and a test that called `respawn()` on the
 * server directly would be claiming it about nothing.
 */

import { describe, expect, it } from 'vitest';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { DEFAULT_SPAWN } from '../player/player-manager.js';
import { GameClient } from './game-client.js';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** How far from the spawn the body is walked before it is killed. */
const AWAY_TICKS = 90;

describe('a respawn as the client sees it', () => {
  it('is never alive at the place it died', async () => {
    const transport = new LoopbackTransport();
    const server = new GameServer({ seed: 8, transport });
    // No ambient spawning: this test wants a walk and a death and nothing else.
    server.liveConfig.set('spawnRateMultiplier', 0);
    transport.onConnection((channel) => server.accept(channel));
    const client = new GameClient(transport.connect(), {
      playerId: 'alice',
      displayName: 'alice',
    });
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

    // Walk away first, or "at the place it died" and "at the spawn" are the same
    // point and the assertion below is true of every possible implementation.
    for (let i = 0; i < AWAY_TICKS; i++) {
      client.sendInput({ moveX: 1, moveY: 0, facing: 0, buttons: 0 });
      await tick();
    }
    const away = client.view().self;
    expect(away).not.toBeNull();
    const fromSpawn = (at: { x: number; y: number }): number =>
      Math.hypot(at.x - DEFAULT_SPAWN.x, at.y - DEFAULT_SPAWN.y);
    const diedAt = fromSpawn(away as { x: number; y: number });
    expect(diedAt).toBeGreaterThan(100);

    expect(server.kill('alice').ok).toBe(true);
    await tick(4);
    expect(client.view().selfDead).toBe(true);

    client.respawn();

    // Sampled once per tick, which is where a one-frame disagreement would be:
    // the renderer reads the view once a frame and the wire delivers between
    // them, so a delta landing before its correction would show up here as a
    // sample that is alive and has not moved.
    let sawAlive = false;
    for (let i = 0; i < 20; i++) {
      await tick();
      const view = client.view();
      const at = view.self;
      if (!at || view.selfDead) continue;
      sawAlive = true;
      // The one claim. `clearSpawnNear` may step the body off the point itself,
      // so this is "back home" rather than "exactly on the pad" -- what it rules
      // out is being alive at the far end of the walk above.
      expect(fromSpawn(at)).toBeLessThan(diedAt / 2);
    }
    // A control, because every assertion in the loop is inside a `continue`: a
    // client that simply never came back would pass all of them.
    expect(sawAlive).toBe(true);
  }, 30000);
});
