/**
 * A body at the top of the speed table, over the shipped map (spec 214).
 *
 * The report this exists for was a player who put `{ moveSpeed: 200 }` on a
 * pair of boots and ran: ground with no trees on it, navigation broken from
 * there on, and the body pulled backwards out of regions that had by then
 * finished loading. Every part of that has a test of its own now -- the
 * predictor that follows the stats, the serve window, the request order, the
 * ledger that ages out -- and none of them can say whether the stream as a whole
 * keeps up with a body moving as fast as the table allows.
 *
 * So: a real `GameServer` over the shipped map, a real `GameClient` asking for
 * chunks the way the tab does, a real `StreamedMap`, and a walk at
 * `MOVE_SPEED_HARD_MAX`. It lives under `src/render/` for `map-radius.test.ts`'s
 * reason -- this is the only side of the fence where the renderer's own
 * `RoutePlanner` and the server's wire are both importable -- and it is driven
 * through that planner rather than by a held direction for `bench-walk.ts`'s:
 * a raw `moveX` walks into the first of 6942 trees and measures a wedged body.
 *
 * The speed is set on the entity rather than by equipping something, because no
 * shipped item reaches the cap and the point is the ceiling rather than the
 * boots: what has to hold is that the stream survives anything the stat table
 * can produce.
 */

import { describe, expect, it } from 'vitest';
import { MOVE_SPEED_HARD_MAX } from '../../../sim/constants.js';
import {
  MAP_CHUNK_REQUEST_RADIUS,
  SERVER_PLAYER_RADIUS,
  SERVER_TICK_RATE,
} from '../../../server/config.js';
import { decodeServerMessage } from '../../../server/net/messages.js';
import { ChunkDeniedReason, ServerMessageType } from '../../../server/net/protocol.js';
import { LoopbackTransport } from '../../../server/net/transport-loop.js';
import { GameServer } from '../../../server/server.js';
import { buildWorldFromMap } from '../../../server/world/build.js';
import { loadMapFile } from '../../../server/world/map-file.js';
import { GameClient } from '../../../server/client/game-client.js';
import { createWorldPredictor } from '../../../server/client/prediction.js';
import { StreamedMap } from '../../../server/client/streamed-map.js';
import { moveIntent, RoutePlanner } from './intent.js';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Long enough to cross several chunk columns at the cap; short enough to run. */
const SECONDS = 14;
/** Nothing moves until the request window is covered, as the load gate insists. */
const SETTLE_TICKS = 300;

describe('a body at the top of the speed table', () => {
  it('never outruns the ground it is standing on', async () => {
    const shipped = loadMapFile();
    const built = buildWorldFromMap(shipped.doc, shipped.mapId);
    const transport = new LoopbackTransport();
    const server = new GameServer({ transport, built });
    // Nothing should wander into the run and change what gets requested.
    server.liveConfig.set('spawnRateMultiplier', 0);
    transport.onConnection((channel) => server.accept(channel));

    const channel = transport.connect();
    const denials = new Map<number, number>();
    const onMessage = channel.onMessage.bind(channel);
    channel.onMessage = (handler) => {
      onMessage((bytes) => {
        const message = decodeServerMessage(bytes);
        if (message.type === ServerMessageType.ChunkDenied) {
          denials.set(message.reason, (denials.get(message.reason) ?? 0) + 1);
        }
        handler(bytes);
      });
    };

    const client = new GameClient(channel, {
      playerId: 'sprinter',
      displayName: 'sprinter',
      predictor: (_stats, tickRate) =>
        createWorldPredictor({
          world: built.colliders,
          terrain: built.sampler,
          radius: SERVER_PLAYER_RADIUS,
          speed: MOVE_SPEED_HARD_MAX,
          tickRate,
        }),
    });
    void client.connect();

    // The server's own view of how fast this body is, held at the cap for every
    // tick of the run -- an item would be re-derived away by the next action.
    const inner = server as unknown as {
      state: { entities: Map<number, { stats: { moveSpeed: number } }> };
    };
    const boost = (): void => {
      // Read through `state` every tick rather than holding the map: the sim
      // replaces its whole world object per tick, so a captured reference goes
      // stale on the first one and this would quietly measure a body at the
      // base speed.
      const self = inner.state.entities.get(client.view().selfEntityId);
      if (self) self.stats = { ...self.stats, moveSpeed: MOVE_SPEED_HARD_MAX };
    };

    const planner = new RoutePlanner();
    const pathWorld = { colliders: built.colliders, radius: SERVER_PLAYER_RADIUS, ground: built.sampler };
    let streamed: StreamedMap | null = null;
    let destination: { x: number; y: number } | null = null;
    let facing = 0;
    let travelled = 0;
    let ticksOnUnsentGround = 0;
    let last: { x: number; y: number } | null = null;

    for (let tick = 1; tick <= SECONDS * SERVER_TICK_RATE; tick++) {
      boost();
      server.tick();
      client.advanceTick();
      await settle();

      const view = client.view();
      const map = view.map;
      if (map && !streamed) streamed = new StreamedMap(map.info);
      if (map && streamed) {
        for (const held of map.chunks) {
          if (!streamed.has(held.layer, held.cx, held.cz)) streamed.add(held);
        }
      }
      const me = view.self;
      if (!me || !streamed || tick < SETTLE_TICKS) continue;

      if (!destination) destination = { x: me.x + 6000, y: me.y };
      if (last) travelled += Math.hypot(me.x - last.x, me.y - last.y);
      last = { x: me.x, y: me.y };
      // The symptom, stated directly: a body standing on ground the map declares
      // and the client has not been sent. Spec 146 makes that survivable rather
      // than fatal -- the client predicts optimistically across it -- but every
      // tick of it is a tick the two ends can disagree about.
      if (!streamed.knows(me.x, me.y)) ticksOnUnsentGround++;

      const intent = moveIntent({
        held: new Set<string>(),
        self: me,
        destination,
        route: planner.next(me, destination, pathWorld, view.estimatedTick),
        facing,
        castAim: view.selfRoot,
      });
      facing = intent.facing;
      client.sendInput({ moveX: intent.moveX, moveY: intent.moveY, facing, buttons: 0 });
    }

    // The run has to have been a run, or everything below is a fact about a body
    // that never left its own chunk. One request window's worth of ground is the
    // bar: past that, every chunk the body is standing on was streamed *during*
    // the walk rather than during the load.
    const chunkExtent = shipped.doc.grid.cellSize * shipped.doc.grid.chunkCells;
    expect(travelled).toBeGreaterThan(MAP_CHUNK_REQUEST_RADIUS * chunkExtent);
    expect(ticksOnUnsentGround).toBe(0);
    // Nothing refused on the edge the body is running toward (spec 214): the
    // serve window covers the ask window, so a correct client is never told no.
    expect(denials.get(ChunkDeniedReason.OutOfRange) ?? 0).toBe(0);
    // ...and the prediction never disagreed with the server over any of it.
    expect(client.correctionCount).toBe(0);
  }, 120_000);
});
