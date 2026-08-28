/**
 * The browser channel (spec 144).
 *
 * Two halves. The first drives a fake socket, because the interesting behaviour
 * is all in the seam between "the channel exists" and "the socket is open" and a
 * real socket opens too fast to aim at. The second runs a *real* `GameClient`
 * against a *real* `GameServer` over a real WebSocket, with the `ws` package's
 * class injected as `create` -- the same surface the DOM one presents, which is
 * the whole reason `WebSocketLike` is narrow. Injected rather than using a
 * global `WebSocket` because CI is on Node 20, where that global is not stable.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { connectChannel, type ConnectionPhase, type WebSocketLike } from './transport-browser.js';
import { WebSocketTransport } from './transport-ws.js';
import { GameServer } from '../server.js';
import { GameClient } from '../client/game-client.js';
import { buildWorldFromMap } from '../world/build.js';
import { loadMapFile } from '../../server/world/map-file.js';

// --- half one: the seam, over a fake socket ------------------------------

type Listener = (event: { data: unknown }) => void;

class FakeSocket implements WebSocketLike {
  binaryType = '';
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  send(data: ArrayBufferView): void {
    this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  close(): void {
    this.readyState = 3;
  }

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: { data: unknown } = { data: null }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
}

function fake(): { socket: FakeSocket; phases: ConnectionPhase[]; channel: ReturnType<typeof connectChannel> } {
  const socket = new FakeSocket();
  const phases: ConnectionPhase[] = [];
  const channel = connectChannel('ws://test/ws', {
    create: () => socket,
    onPhase: (phase) => phases.push(phase),
  });
  return { socket, phases, channel };
}

describe('the browser channel, before the socket opens', () => {
  it('asks for arraybuffer frames before anything can arrive', () => {
    const { socket } = fake();
    expect(socket.binaryType).toBe('arraybuffer');
  });

  it('queues what is written before open, and flushes it in order', () => {
    const { socket, channel } = fake();
    channel.send(Uint8Array.of(1, 2));
    channel.send(Uint8Array.of(3));
    // This is the case the whole design exists for: GameClient sends Hello from
    // its constructor, long before a socket could be open.
    expect(socket.sent).toHaveLength(0);
    expect(channel.isOpen).toBe(false);

    socket.open();
    expect(socket.sent.map((f) => [...f])).toEqual([[1, 2], [3]]);
    expect(channel.isOpen).toBe(true);
  });

  it('never claims to be open while it is queueing', () => {
    const { channel } = fake();
    channel.send(Uint8Array.of(9));
    expect(channel.isOpen).toBe(false);
  });

  it('drops the queue when the socket dies before opening', () => {
    const { socket, channel } = fake();
    let closed = 0;
    channel.onClose(() => closed++);
    channel.send(Uint8Array.of(1));
    socket.emit('error');
    expect(socket.sent).toHaveLength(0);
    expect(closed).toBe(1);
    // And an open that somehow arrives afterwards flushes nothing.
    socket.open();
    expect(socket.sent).toHaveLength(0);
  });
});

describe('the browser channel, once it is open', () => {
  it('hands an ArrayBuffer message out as the same bytes', () => {
    const { socket, channel } = fake();
    const seen: Uint8Array[] = [];
    channel.onMessage((bytes) => seen.push(bytes));
    socket.open();
    socket.emit('message', { data: Uint8Array.of(7, 8, 9).buffer });
    expect(seen).toHaveLength(1);
    expect([...(seen[0] ?? [])]).toEqual([7, 8, 9]);
  });

  it('keeps exactly one reader', () => {
    const { socket, channel } = fake();
    const first: number[] = [];
    const second: number[] = [];
    channel.onMessage((b) => first.push(b.length));
    channel.onMessage((b) => second.push(b.length));
    socket.open();
    socket.emit('message', { data: Uint8Array.of(1, 2).buffer });
    expect(first).toEqual([]);
    expect(second).toEqual([2]);
  });

  it('ignores a frame that is not binary rather than guessing at it', () => {
    const { socket, channel } = fake();
    const seen: Uint8Array[] = [];
    channel.onMessage((bytes) => seen.push(bytes));
    socket.open();
    socket.emit('message', { data: 'hello' });
    expect(seen).toHaveLength(0);
  });

  it('fires onClose once, however many ways it is told', () => {
    const { socket, channel } = fake();
    let closed = 0;
    channel.onClose(() => closed++);
    socket.open();
    socket.emit('error');
    socket.emit('close');
    channel.close();
    expect(closed).toBe(1);
  });

  it('reports the phases in order', () => {
    const { socket, phases } = fake();
    socket.open();
    socket.emit('close');
    expect(phases).toEqual(['connecting', 'connected', 'closed']);
  });

  it('sends nothing after close', () => {
    const { socket, channel } = fake();
    socket.open();
    channel.close();
    channel.send(Uint8Array.of(4));
    expect(socket.sent).toHaveLength(0);
  });
});

// --- half two: a real client, over a real socket -------------------------

const shippedMap = loadMapFile();

describe('a real client over a real socket', () => {
  const running: { server: GameServer; transport: WebSocketTransport }[] = [];

  afterEach(() => {
    for (const { server, transport } of running.splice(0)) {
      server.stop();
      transport.close();
    }
  });

  /**
   * Never reused, even across tests.
   *
   * This was `18787 + running.length`, and `running` is emptied by `afterEach`
   * -- so every test bound the same port. `wss.close()` is asynchronous, so the
   * next test raced the last one's socket into `EADDRINUSE`, which used to take
   * the whole worker process down. It cost a red CI whose only symptom was
   * `ERR_IPC_CHANNEL_CLOSED` from vitest's pool, nowhere near the cause.
   */
  let nextPort = 18787;

  async function standUpServer(): Promise<number> {
    const port = nextPort++;
    const built = buildWorldFromMap(shippedMap.doc, shippedMap.mapId);
    const failures: Error[] = [];
    const transport = new WebSocketTransport({
      port,
      onError: (error) => void failures.push(error),
    });
    const server = new GameServer({ seed: 7, built, transport });
    transport.onConnection((channel) => server.accept(channel));
    running.push({ server, transport });
    // The server's own clock, since no view is driving it here.
    server.start();
    // Let a bind failure surface here, where it names itself, rather than as a
    // connect timeout thirty seconds later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (failures.length > 0) throw failures[0];
    return port;
  }

  function connect(port: number, playerId: string, displayName: string): GameClient {
    return new GameClient(
      connectChannel(`ws://127.0.0.1:${port}/ws`, {
        create: (url) => new WebSocket(url) as unknown as WebSocketLike,
      }),
      { playerId, displayName },
    );
  }

  it('connects, is welcomed, and moves when told to', async () => {
    const port = await standUpServer();
    const client = connect(port, 'ana', 'Ana');
    const welcome = await client.connect();
    expect(welcome.playerId).toBe('ana');
    expect(welcome.entityId).toBeGreaterThan(0);

    const selfEntity = (c: GameClient): { x: number } | undefined =>
      c.view().entities.find((e) => e.id === welcome.entityId);

    // Deltas land at 20Hz, so the body is not in the replica the instant the
    // Welcome resolves. Stand still until it is.
    for (let i = 0; i < 60 && selfEntity(client) === undefined; i++) {
      client.sendInput({ moveX: 0, moveY: 0, facing: 0, buttons: 0 });
      client.advanceTick();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const start = selfEntity(client)?.x ?? null;
    expect(start).not.toBeNull();

    for (let i = 0; i < 180; i++) {
      client.sendInput({ moveX: 1, moveY: 0, facing: 0, buttons: 0 });
      client.advanceTick();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    // Both halves: the authoritative body moved, and the local prediction is
    // following it rather than sitting where it started.
    expect(selfEntity(client)?.x ?? 0).toBeGreaterThan(start ?? 0);
    expect(client.view().self?.x ?? 0).toBeGreaterThan(start ?? 0);
    client.disconnect();
  }, 20_000);

  it('gives two tabs two entities in one world', async () => {
    const port = await standUpServer();
    const ana = connect(port, 'ana', 'Ana');
    const ben = connect(port, 'ben', 'Ben');
    const [aw, bw] = await Promise.all([ana.connect(), ben.connect()]);

    expect(aw.entityId).not.toBe(bw.entityId);

    // Let deltas land. They spawn on the same point, so each should see the
    // other's entity in its replica -- separating them is spec 145's job.
    for (let i = 0; i < 90; i++) {
      ana.advanceTick();
      ben.advanceTick();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const anaSees = ana.view().entities.some((e) => e.id === bw.entityId);
    const benSees = ben.view().entities.some((e) => e.id === aw.entityId);
    expect(anaSees).toBe(true);
    expect(benSees).toBe(true);

    ana.disconnect();
    ben.disconnect();
  }, 20_000);
});
