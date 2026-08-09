/**
 * Headless bot clients (specs 056, 057): `npm run server:bots`.
 *
 * Since 057 this is a thin shell around {@link GameClient} -- the same session
 * class the renderer will use in stage 3. That is the point: the bots are not a
 * parallel client implementation to keep in step, they are the real one driven
 * by a script instead of a keyboard.
 *
 * Usage:
 *   npm run server:bots                    # 3 bots against ws://localhost:8787
 *   npm run server:bots -- --count 8 --url ws://localhost:8899
 *
 * A correction count near zero while walking in the open, climbing once
 * something starts hitting back, is the expected reading. The default predictor
 * models a walk and nothing else, so every knockback is a genuine divergence the
 * server has to correct. A count that tracks the delta count one-for-one means
 * the bot is mispredicting systematically, and something is wrong.
 */

import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameClient } from '../src/server/client/game-client.js';
import { SERVER_TICK_RATE } from '../src/server/config.js';
import { channelFromSocket } from '../src/server/net/transport-ws.js';

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const url = flag('url', 'ws://localhost:8787');
const count = Math.max(1, Math.min(50, Number(flag('count', '3'))));

interface Bot {
  readonly name: string;
  client: GameClient | null;
  hits: number;
}

function startBot(index: number): Bot {
  const name = `bot-${index + 1}`;
  const bot: Bot = { name, client: null, hits: 0 };

  const socket = new WebSocket(url);
  socket.binaryType = 'nodebuffer';

  socket.on('open', () => {
    const client = new GameClient(channelFromSocket(socket), {
      playerId: name,
      displayName: name,
      // The bots are the one client here that crosses a real socket to a real
      // server, so they are the one that can actually catch a stale-asset
      // mismatch (spec 113). Empty when the bake has never run, which the
      // server allows.
      assetManifest: assetManifestHash(),
    });
    bot.client = client;

    client.onError((code, message) => console.error(`[${name}] server error ${code}: ${message}`));
    client.onCombatResult(() => {
      bot.hits += 1;
    });

    client
      .connect()
      .then(() => {
        // Each bot walks a circle at its own phase, so the admin panel shows
        // motion rather than a stack of identical dots.
        let angle = (index / count) * Math.PI * 2;
        setInterval(() => {
          angle += 0.02;
          client.sendInput({
            moveX: Math.cos(angle),
            moveY: Math.sin(angle),
            facing: angle,
            buttons: 0,
          });
        }, 1000 / SERVER_TICK_RATE);
      })
      .catch((error: unknown) => {
        console.error(`[${name}] ${error instanceof Error ? error.message : String(error)}`);
      });
  });

  socket.on('error', (error: Error) => console.error(`[${name}] ${error.message}`));
  return bot;
}

console.log(`[bots] connecting ${count} bot(s) to ${url}`);
const bots = Array.from({ length: count }, (_, index) => startBot(index));

setInterval(() => {
  const lines = bots.map((bot) => {
    const view = bot.client?.view();
    if (!view?.connected) return `${bot.name} connecting...`;
    return (
      `${bot.name} ent=${view.selfEntityId} at ${view.self?.x.toFixed(0)},${view.self?.y.toFixed(0)} ` +
      `tick=${view.tick} seen=${view.entities.length} hits=${bot.hits} ` +
      `corrections=${bot.client?.correctionCount ?? 0}`
    );
  });
  console.log(`\n[bots] ${new Date().toLocaleTimeString()}\n  ${lines.join('\n  ')}`);
}, 5000);

process.on('SIGINT', () => {
  console.log('\n[bots] stopping');
  for (const bot of bots) bot.client?.disconnect();
  process.exit(0);
});

/** The manifest this checkout was baked to, or '' when it has not been. */
function assetManifestHash(): string {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const text = readFileSync(join(root, 'assets', 'units', 'manifest.json'), 'utf8');
    return String((JSON.parse(text) as { hash?: unknown }).hash ?? '');
  } catch {
    return '';
  }
}
