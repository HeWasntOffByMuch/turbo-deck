/**
 * The `Channel` a browser can hold (spec 144).
 *
 * `transport-ws.ts` is the socket half that runs in Node: it imports the `ws`
 * package, which is what makes it the one file in `src/server/` that cannot be
 * bundled for a tab. This is its peer on the other side of that line -- the
 * same `Channel` contract over the DOM `WebSocket`, importing nothing from
 * Node, so the renderer can connect out to a real server.
 *
 * The one place this is more than a wrapper is the queue. `GameClient`
 * registers its handlers inside its constructor and `connect()` sends `Hello`
 * immediately, so a channel that only existed once the socket was open would
 * force the whole mount to become async -- and the mount is shared with the
 * loopback path, which spec 144 is required to leave alone. So the channel
 * exists from the first instant and holds outbound frames until `open`.
 *
 * What it does NOT do is lie: `isOpen` reports the socket's actual state
 * throughout, so nothing downstream can mistake a queued frame for a sent one.
 * A socket that dies before it ever opens drops the queue on the floor, which
 * is the honest outcome -- those frames were never on a wire.
 */

import type { Channel } from './transport.js';

/**
 * The subset of `WebSocket` this needs. Narrow on purpose: the DOM class
 * satisfies it, and so does the `ws` package's, which is what lets the test
 * drive this against a real server in Node without a global `WebSocket` (not
 * stable on the Node 20 CI runs on).
 */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: ArrayBufferView): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** Where the socket is, for something that wants to say so on screen. */
export type ConnectionPhase = 'connecting' | 'connected' | 'closed';

export interface BrowserChannelOptions {
  /** Defaults to `globalThis.WebSocket`. Injected so a Node test can pass `ws`. */
  readonly create?: (url: string) => WebSocketLike;
  /** Called on every phase change, starting with `connecting`. */
  readonly onPhase?: (phase: ConnectionPhase) => void;
}

/** `WebSocket.OPEN`. Spelled out rather than read off the class, which may be `ws`'s. */
const OPEN = 1;

class BrowserSocketChannel implements Channel {
  private readonly socket: WebSocketLike;
  private messageHandler: ((bytes: Uint8Array) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  /** Frames written before `open`, in order. Emptied on open, dropped on a pre-open close. */
  private queued: Uint8Array[] = [];
  private opened = false;
  private closed = false;

  constructor(url: string, private readonly options: BrowserChannelOptions = {}) {
    const create = options.create ?? ((target: string) => new WebSocket(target) as WebSocketLike);
    this.socket = create(url);
    // Set before any frame can arrive, so a message event carries an
    // ArrayBuffer rather than a Blob -- a Blob would only be readable
    // asynchronously, and the codec is synchronous.
    this.socket.binaryType = 'arraybuffer';

    this.socket.addEventListener('open', () => {
      this.opened = true;
      const pending = this.queued;
      this.queued = [];
      for (const frame of pending) this.socket.send(frame);
      this.options.onPhase?.('connected');
    });

    this.socket.addEventListener('message', (event: { data: unknown }) => {
      const bytes = toBytes(event.data);
      if (bytes) this.messageHandler?.(bytes);
    });

    // Both routes end the same way, and `error` is often followed by `close`:
    // `fireClosed` is idempotent so the handler runs at most once.
    this.socket.addEventListener('close', () => this.fireClosed());
    this.socket.addEventListener('error', () => this.fireClosed());

    this.options.onPhase?.('connecting');
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === OPEN;
  }

  send(bytes: Uint8Array): void {
    if (this.closed) return;
    // Copied out of the writer's arena either way: the view aliases a buffer
    // the next message would reuse, and a queued frame outlives it by longer.
    const frame = new Uint8Array(bytes);
    if (this.opened) this.socket.send(frame);
    else this.queued.push(frame);
  }

  /** Replaces any previous handler; there is exactly one reader per channel. */
  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.socket.close();
    this.fireClosed();
  }

  private fireClosed(): void {
    if (this.closed) return;
    this.closed = true;
    // Anything still queued was never on a wire; saying otherwise by flushing
    // it into a dead socket would be the lie this class avoids.
    this.queued = [];
    this.options.onPhase?.('closed');
    this.closeHandler?.();
  }
}

/**
 * Bytes out of whatever the socket handed us. `ArrayBuffer` is what
 * `binaryType = 'arraybuffer'` promises; a `Uint8Array` is what `ws` gives when
 * something upstream has already set `nodebuffer`, and honouring it costs one
 * branch. A `Blob` or a string is neither, and is dropped rather than guessed
 * at -- the wire is binary frames and a text frame is somebody else's protocol.
 */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/**
 * Connects to `url` and returns the channel immediately -- before the socket is
 * open. See the note at the top of the file for why that is the contract.
 */
export function connectChannel(url: string, options?: BrowserChannelOptions): Channel {
  return new BrowserSocketChannel(url, options);
}
