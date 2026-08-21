/**
 * What one authoritative tick costs on the shipped map: `npx tsx scripts/bench-tick.ts`
 *
 * Single-player is a whole server on the render thread -- `view.ts` calls
 * `server.tick()` and `client.advanceTick()` from inside the animation frame,
 * once per fixed step -- so a tick that got more expensive is a frame that got
 * more expensive. It does not show up as a stall, either: below 60fps the
 * accumulator drains one tick on some frames and two on others, so the cost
 * arrives as a picket fence in the frame graph rather than as a spike.
 *
 * The number that moves this one is not in `src/server/` at all. `resolveMovement`
 * puts every body through `slideCircle` and `pushOutOfObstacles` every tick, and
 * both walk *every collider in the world* -- so the tick is
 * `bodies x colliders`, and growing the map grows the per-tick cost of standing
 * still. Hence the collider count in the header: it is the independent variable.
 *
 * Node rather than a browser, so the measurement is not the software
 * rasteriser's. Absolute milliseconds are this machine's; what transfers is the
 * split between the two halves and the shape against another commit.
 *
 * `PROFILE=1` writes /tmp/tick.cpuprofile for the sampled loop, which is what
 * says *which* function inside the tick is the bill.
 */

import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';

import { GameServer } from '../src/server/server.js';
import { GameClient } from '../src/server/client/game-client.js';
import { LoopbackTransport } from '../src/server/net/transport-loop.js';
import { buildWorldFromMap } from '../src/server/world/build.js';
import { createWorldPredictor } from '../src/server/client/prediction.js';
import { SERVER_PLAYER_RADIUS } from '../src/server/config.js';
import { loadMapFile } from '../src/server/world/map-file.js';

const TICKS = Number(process.env['TICKS'] ?? 1800);
/** Ticks discarded before measuring, so the number is not the JIT's. */
const WARM = Number(process.env['WARM'] ?? 600);

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

async function main(): Promise<void> {
  const shipped = loadMapFile();
  const world = buildWorldFromMap(shipped.doc, shipped.mapId);
  // No warm: since spec 201 nav is windows built on demand, so the first tick
  // that routes pays for its own window and the rest are free. That is part of
  // what this bench measures rather than something to arrange away.
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: world.seed, built: world, transport });
  transport.onConnection((channel) => server.accept(channel));

  const client = new GameClient(transport.connect(), {
    playerId: 'bench',
    displayName: 'Bench',
    predictor: (stats, tickRate) =>
      createWorldPredictor({
        world: world.colliders,
        terrain: world.sampler,
        radius: SERVER_PLAYER_RADIUS,
        speed: stats.moveSpeed,
        tickRate,
      }),
  });
  void client.connect();

  const session = process.env['PROFILE'] === '1' ? new Session() : null;
  if (session) {
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 100 });
  }

  const serverMs: number[] = [];
  const clientMs: number[] = [];
  for (let i = 0; i < WARM + TICKS; i += 1) {
    if (session && i === WARM) await session.post('Profiler.start');
    const before = performance.now();
    server.tick();
    const stepped = performance.now();
    client.advanceTick();
    const after = performance.now();
    if (i >= WARM) {
      serverMs.push(stepped - before);
      clientMs.push(after - stepped);
    }
    // Let the loopback's queued messages drain, exactly as a frame would.
    if (i % 64 === 0) await new Promise((resolve) => setImmediate(resolve));
  }

  if (session) {
    const { profile } = await session.post('Profiler.stop');
    writeFileSync('/tmp/tick.cpuprofile', JSON.stringify(profile));
    console.log('wrote /tmp/tick.cpuprofile');
  }

  const colliders = world.colliders.rects.length + world.colliders.circles.length;
  const row = (label: string, samples: readonly number[]): void => {
    console.log(
      `${label.padEnd(22)} ${mean(samples).toFixed(3).padStart(8)}` +
        ` ${percentile(samples, 0.99).toFixed(3).padStart(9)}` +
        ` ${percentile(samples, 1).toFixed(3).padStart(9)}`,
    );
  };
  console.log(
    `${TICKS} ticks on maps/arena.json:` +
      ` ${client.view().entities.length} entities replicated, ${colliders} colliders\n`,
  );
  console.log(
    `${'ms per tick'.padEnd(22)} ${'mean'.padStart(8)} ${'p99'.padStart(9)} ${'worst'.padStart(9)}`,
  );
  row('server.tick()', serverMs);
  row('client.advanceTick()', clientMs);
  row('both', serverMs.map((value, index) => value + (clientMs[index] ?? 0)));
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
