/**
 * In-process transport (spec 057): what single-player is made of.
 *
 * Both ends are objects in the same heap, so a frame is handed over rather than
 * serialised, framed, copied into a socket buffer and parsed back out. What is
 * *not* skipped is the encoding: the client and server still exchange the exact
 * bytes they would over a wire.
 *
 * That is a deliberate cost. If the loopback path took a shortcut -- passing
 * decoded message objects, or sharing an entity reference -- then single-player
 * would be exercising different code from multiplayer, and the bugs that matter
 * most (a field missing from the wire format, an entity mutated through a
 * reference the protocol would have copied) would be exactly the bugs it could
 * no longer catch. Spec 057 asserts the two produce identical frame sequences,
 * and that assertion is only worth anything because this class refuses to cheat.
 *
 * Delivery is asynchronous (a microtask), because a synchronous hand-off would
 * let a client's send re-enter the server mid-tick -- something a socket could
 * never do, and therefore something the server is not written to survive.
 */

import type { Channel, ServerTransport } from './transport.js';

type Handler = (bytes: Uint8Array) => void;

/** One end of a loopback pair. Writes to its peer, reads what its peer wrote. */
class LoopbackChannel implements Channel {
  private peer: LoopbackChannel | null = null;
  private messageHandler: Handler | null = null;
  private closeHandler: (() => void) | null = null;
  private open = true;

  get isOpen(): boolean {
    return this.open;
  }

  link(peer: LoopbackChannel): void {
    this.peer = peer;
  }

  send(bytes: Uint8Array): void {
    if (!this.open) return;
    const peer = this.peer;
    if (!peer) return;
    // Copied, because the writer's buffer is reused for the next frame -- the
    // same reason the socket path copies.
    const frame = new Uint8Array(bytes);
    queueMicrotask(() => {
      if (peer.open) peer.messageHandler?.(frame);
    });
  }

  onMessage(handler: Handler): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    const peer = this.peer;
    queueMicrotask(() => {
      this.closeHandler?.();
      if (peer?.open) peer.close();
    });
  }
}

export class LoopbackTransport implements ServerTransport {
  private handler: ((channel: Channel) => void) | null = null;
  private readonly pending: Channel[] = [];

  onConnection(handler: (channel: Channel) => void): void {
    this.handler = handler;
    // A client may connect before the server starts listening; single-player
    // constructs both in one breath and the order is not worth being fragile about.
    while (this.pending.length > 0) {
      const channel = this.pending.shift();
      if (channel) handler(channel);
    }
  }

  /**
   * Opens a connection and returns the *client's* end. The server's end is
   * handed to the connection handler, exactly as a socket accept would.
   */
  connect(): Channel {
    const clientSide = new LoopbackChannel();
    const serverSide = new LoopbackChannel();
    clientSide.link(serverSide);
    serverSide.link(clientSide);

    if (this.handler) this.handler(serverSide);
    else this.pending.push(serverSide);

    return clientSide;
  }

  close(): void {
    this.pending.length = 0;
    this.handler = null;
  }
}
