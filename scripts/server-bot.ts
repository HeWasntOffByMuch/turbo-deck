/**
 * Headless bot clients (spec 056): `npm run server:bots`.
 *
 * The browser game does not speak to the server yet, so this is what puts
 * players in the admin console -- and, more usefully, it is a working reference
 * client for the prediction contract in `src/server/net/PROTOCOL.md`. It sends
 * inputs, predicts locally through {@link PredictionBuffer}, reconciles on a
 * correction, and reports how often it was wrong.
 *
 * Usage:
 *   npm run server:bots                    # 3 bots against ws://localhost:8787
 *   npm run server:bots -- --count 8 --url ws://localhost:8899
 *
 * A correction count near zero while walking in the open, climbing once
 * something starts hitting back, is the expected reading. The predictor here is
 * deliberately the naive one -- it models a walk and nothing else -- so every
 * knockback is a genuine divergence the server has to correct. A real client
 * would predict knockback too and see fewer. A count that tracks the delta
 * count one-for-one means the bot is mispredicting systematically, not
 * occasionally, and something is wrong.
 */

import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, SERVER_TICK_RATE } from '../src/server/config.js';
import {
  createFlatPredictor,
  PredictionBuffer,
  type PredictedInput,
} from '../src/server/client/prediction.js';
import { decodeServerMessage, encodeClientMessage } from '../src/server/net/messages.js';
import { ClientMessageType, ServerMessageType } from '../src/server/net/protocol.js';

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const url = flag('url', 'ws://localhost:8787');
const count = Math.max(1, Math.min(50, Number(flag('count', '3'))));

interface BotStats {
  name: string;
  deltas: number;
  corrections: number;
  entityId: number;
  x: number;
  y: number;
}

function startBot(index: number): BotStats {
  const name = `bot-${index + 1}`;
  const report: BotStats = { name, deltas: 0, corrections: 0, entityId: -1, x: 0, y: 0 };

  const socket = new WebSocket(url);
  socket.binaryType = 'nodebuffer';

  let prediction: PredictionBuffer | null = null;
  let moveSpeed = 0;
  let seq = 0;
  // Each bot walks a circle at its own phase, so the admin panel shows motion
  // rather than a stack of identical dots.
  let angle = (index / count) * Math.PI * 2;
  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Starts predicting from an authoritative position, never from a guess.
   * Seeding from (0,0) while the server has you in the hub makes every input
   * claim an impossible distance travelled, and the server rightly corrects
   * every one of them -- the bot has to be told where it is before it can
   * usefully predict where it is going.
   */
  const beginPredicting = (from: { x: number; y: number }): void => {
    if (prediction !== null || moveSpeed <= 0) return;
    prediction = new PredictionBuffer(from, createFlatPredictor(moveSpeed, SERVER_TICK_RATE));
    timer = setInterval(() => {
      if (!prediction || socket.readyState !== WebSocket.OPEN) return;
      angle += 0.06;
      seq += 1;
      const input: PredictedInput = {
        seq,
        moveX: Math.cos(angle),
        moveY: Math.sin(angle),
        facing: angle,
        buttons: 0,
      };
      const predicted = prediction.apply(input);
      socket.send(
        encodeClientMessage({
          type: ClientMessageType.Input,
          ...input,
          predictedX: predicted.x,
          predictedY: predicted.y,
        }),
      );
    }, 1000 / SERVER_TICK_RATE);
  };

  socket.on('open', () => {
    socket.send(
      encodeClientMessage({
        type: ClientMessageType.Hello,
        protocolVersion: PROTOCOL_VERSION,
        playerId: name,
        displayName: name,
        token: '',
      }),
    );
  });

  socket.on('message', (data: Buffer) => {
    const message = decodeServerMessage(new Uint8Array(data));

    switch (message.type) {
      case ServerMessageType.Welcome:
        report.entityId = message.entityId;
        break;

      case ServerMessageType.Stats:
        // Speed is derived server-side; the bot predicts with whatever it is
        // told, which is the only number a client should ever use.
        moveSpeed = message.stats.moveSpeed;
        break;

      case ServerMessageType.Delta: {
        report.deltas += 1;
        prediction?.acknowledge(message.ackInputSeq);
        for (const record of message.upserts) {
          if (record.id !== report.entityId || !record.position) continue;
          report.x = record.position.x;
          report.y = record.position.y;
          // The first sighting of ourselves is what starts the whole loop.
          beginPredicting(record.position);
        }
        break;
      }

      case ServerMessageType.Correction:
        if (prediction) {
          prediction.reconcile(message.inputSeq, message.position);
          report.corrections = prediction.correctionCount;
        }
        break;

      case ServerMessageType.Error:
        console.error(`[${name}] server error ${message.code}: ${message.message}`);
        break;

      case ServerMessageType.Disconnect:
        console.log(`[${name}] disconnected: ${message.reason}`);
        break;

      default:
        break;
    }
  });

  socket.on('close', () => {
    if (timer !== null) clearInterval(timer);
  });
  socket.on('error', (error: Error) => {
    console.error(`[${name}] ${error.message}`);
  });

  return report;
}

console.log(`[bots] connecting ${count} bot(s) to ${url}`);
const bots = Array.from({ length: count }, (_, index) => startBot(index));

setInterval(() => {
  const lines = bots.map(
    (bot) =>
      `${bot.name} ent=${bot.entityId} at ${bot.x.toFixed(0)},${bot.y.toFixed(0)} ` +
      `deltas=${bot.deltas} corrections=${bot.corrections}`,
  );
  console.log(`\n[bots] ${new Date().toLocaleTimeString()}\n  ${lines.join('\n  ')}`);
}, 5000);

process.on('SIGINT', () => {
  console.log('\n[bots] stopping');
  process.exit(0);
});
