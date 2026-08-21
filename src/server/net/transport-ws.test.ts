/**
 * The socket transport's heartbeat (spec 197).
 *
 * The half that matters here cannot be faked, because the whole claim is about
 * what a peer does *without being asked*: RFC 6455 makes answering a ping the
 * endpoint's job, so a real `ws` client pongs with nothing in its application
 * code running. A stub that called the handler would be asserting the stub.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketTransport } from './transport-ws.js';
import { LoopbackTransport } from './transport-loop.js';
import type { Channel } from './transport.js';
import { GameServer } from '../server.js';
import { buildWorldFromMap } from '../world/build.js';
import { loadMapFile } from '../world/map-file.js';
import { CONNECTION_TIMEOUT_TICKS, SERVER_PING_MS, SERVER_TICK_RATE } from '../config.js';

// Read through `loadMapFile` rather than as one file: the shipped map is a
// directory of regions since spec 203, and this test landed while it still
// was not.
const shippedMap = loadMapFile();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('the ping period', () => {
  it('gets at least three chances inside the timeout', () => {
    // The relationship, not the numbers: a single lost pong must not be a
    // disconnection, and the two constants live in different files.
    const timeoutMs = (CONNECTION_TIMEOUT_TICKS / SERVER_TICK_RATE) * 1000;
    expect(SERVER_PING_MS * 3).toBeLessThanOrEqual(timeoutMs);
  });
});

describe('a real socket, with a silent client', () => {
  const open: { transport: WebSocketTransport; sockets: WebSocket[] }[] = [];

  afterEach(() => {
    for (const { transport, sockets } of open.splice(0)) {
      for (const socket of sockets) socket.close();
      transport.close();
    }
  });

  // Never reused, for the reason transport-browser.test.ts spells out: a
  // `wss.close()` is asynchronous and the next bind races it into EADDRINUSE.
  let nextPort = 19787;

  it('reports the peer alive over and over, with no application frame sent', async () => {
    const port = nextPort++;
    const failures: Error[] = [];
    const transport = new WebSocketTransport({
      port,
      pingMs: 20,
      onError: (error) => void failures.push(error),
    });
    const sockets: WebSocket[] = [];
    open.push({ transport, sockets });

    let alive = 0;
    let frames = 0;
    transport.onConnection((channel) => {
      channel.onMessage(() => frames++);
      channel.onAlive?.(() => alive++);
    });

    await sleep(50);
    if (failures.length > 0) throw failures[0];

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(client);
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve());
      client.on('error', reject);
    });

    // The client's application code does nothing at all for the whole window --
    // which is exactly the tab whose timers have been throttled to one a minute.
    await sleep(300);

    expect(alive).toBeGreaterThanOrEqual(3);
    expect(frames).toBe(0);
  });

  it('stops pinging a socket that has gone', async () => {
    const port = nextPort++;
    const transport = new WebSocketTransport({ port, pingMs: 20 });
    const sockets: WebSocket[] = [];
    open.push({ transport, sockets });

    let alive = 0;
    transport.onConnection((channel) => channel.onAlive?.(() => alive++));
    await sleep(50);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve());
      client.on('error', reject);
    });
    await sleep(120);
    const before = alive;
    expect(before).toBeGreaterThan(0);

    client.close();
    await sleep(150);
    // The sweep dropped it rather than going on writing to a dead socket.
    expect(alive).toBe(before);
  });
});

describe('a channel with no wire', () => {
  it('has no onAlive at all, rather than one that answers for nothing', () => {
    const transport = new LoopbackTransport();
    let served: Channel | null = null;
    transport.onConnection((channel) => {
      served = channel;
    });
    const client = transport.connect();
    // The optional member IS the answer: absent means "this transport has no
    // such signal", where a required one would make the loopback invent one.
    expect(client.onAlive).toBeUndefined();
    expect((served as Channel | null)?.onAlive).toBeUndefined();
  });
});

describe('what the server does with it', () => {
  /** A channel that never delivers a frame: the tab whose timers have stopped. */
  function silentChannel(): Channel {
    return {
      send: () => {
        // Nothing reads what this server writes.
      },
      close: () => {
        // Never closed: the point is a socket that stays up and says nothing.
      },
      isOpen: true,
      onMessage: () => {
        // No frame ever arrives.
      },
      onClose: () => {
        // ...so nothing ever fires it.
      },
    };
  }

  function built(): ReturnType<typeof buildWorldFromMap> {
    return buildWorldFromMap(shippedMap.doc, shippedMap.mapId);
  }

  it('counts a pong as a heartbeat, so a silent tab is not swept', () => {
    const server = new GameServer({ seed: 7, built: built() });
    let alive: (() => void) | null = null;
    const connection = server.accept({
      ...silentChannel(),
      onAlive: (handler) => {
        alive = handler;
      },
    });
    const seenAtAccept = connection.lastSeenTick;

    // Well past the timeout, with not one frame received.
    const quiet = CONNECTION_TIMEOUT_TICKS + 60;
    for (let i = 0; i < quiet; i++) server.tick();
    expect(connection.lastSeenTick).toBe(seenAtAccept);

    (alive as (() => void) | null)?.();
    expect(connection.lastSeenTick).toBe(seenAtAccept + quiet);
  });

  it('leaves a channel that cannot say anything alone', () => {
    const server = new GameServer({ seed: 7, built: built() });
    // No `onAlive`, so nothing is called and nothing throws: the optional call
    // is the whole compatibility story for the loopback path.
    expect(() => server.accept(silentChannel())).not.toThrow();
  });
});
