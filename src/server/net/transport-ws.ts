/**
 * The `ws` transport (spec 057). The only file in `src/server/` that imports a
 * Node-only module for the running game -- keeping it here is what lets the rest
 * of the server be bundled into a browser tab for single-player.
 */

import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Channel, ServerTransport } from './transport.js';

function toBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

class SocketChannel implements Channel {
  constructor(private readonly socket: WebSocket) {}

  get isOpen(): boolean {
    return this.socket.readyState === 1;
  }

  send(bytes: Uint8Array): void {
    if (!this.isOpen) return;
    // Copied out of the writer's arena: the view aliases a buffer the next
    // message would reuse.
    this.socket.send(new Uint8Array(bytes), { binary: true });
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.socket.removeAllListeners('message');
    this.socket.on('message', (data: RawData) => handler(toBytes(data)));
  }

  onClose(handler: () => void): void {
    this.socket.on('close', handler);
    this.socket.on('error', handler);
  }

  close(): void {
    this.socket.close();
  }
}

export interface WebSocketTransportOptions {
  /**
   * Told about a socket-level failure -- a port in use, most often. Without
   * one the error is logged; either way it does not take the process with it.
   */
  readonly onError?: (error: Error) => void;
  readonly port?: number;
  /** Attach to an existing HTTP server so the admin page shares an origin. */
  readonly httpServer?: HttpServer;
}

export class WebSocketTransport implements ServerTransport {
  private readonly wss: WebSocketServer;

  constructor(options: WebSocketTransportOptions) {
    this.wss = options.httpServer
      ? new WebSocketServer({ server: options.httpServer })
      : new WebSocketServer({ port: options.port ?? 8787 });
    // An `error` event with no listener is an *uncaught exception* on an
    // EventEmitter, so a port that is still in TIME_WAIT took the whole process
    // down -- which in CI meant a vitest worker vanishing and the run failing
    // with `ERR_IPC_CHANNEL_CLOSED`, nowhere near the cause. A server that
    // cannot bind has to say so and let its owner decide.
    this.wss.on('error', (error: Error) => {
      if (options.onError) options.onError(error);
      else console.error(`[server] socket error: ${error.message}`);
    });
  }

  onConnection(handler: (channel: Channel) => void): void {
    this.wss.on('connection', (socket: WebSocket) => handler(new SocketChannel(socket)));
  }

  close(): void {
    this.wss.close();
  }
}

/** Wraps an already-connected client socket, for a Node client (the bots). */
export function channelFromSocket(socket: WebSocket): Channel {
  return new SocketChannel(socket);
}
