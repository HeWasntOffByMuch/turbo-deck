/**
 * The seam that lets one server run behind a socket or inside a tab (spec 057).
 *
 * `GameServer` used to construct a `WebSocketServer` itself, which quietly made
 * it a Node-only program. Single-player under spec 057 is a server running in
 * the player's own browser, so the transport has to be something handed in
 * rather than something reached for.
 *
 * The interface is deliberately the smallest thing both implementations can
 * honestly provide: frames of bytes, in and out, plus a close. No request
 * /response, no reconnection, no backpressure signalling -- a loopback channel
 * would have to lie about all three.
 */

export interface Channel {
  send(bytes: Uint8Array): void;
  close(): void;
  readonly isOpen: boolean;
  /** Replaces any previous handler; there is exactly one reader per channel. */
  onMessage(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  /**
   * Out-of-band evidence the peer is still there, for a transport that has any
   * (spec 197).
   *
   * Optional, and that is the point rather than a convenience. A socket has a
   * protocol-level ping whose pong the peer's *network stack* answers, with no
   * JavaScript involved -- which is the only heartbeat a background tab whose
   * timers Chrome has throttled to one a minute can still produce. A loopback
   * channel has no wire to prove anything about, so an absent member says "this
   * transport has no such signal" where a required one would make it lie.
   *
   * Replaces any previous handler, like the other two.
   */
  onAlive?(handler: () => void): void;
}

export interface ServerTransport {
  onConnection(handler: (channel: Channel) => void): void;
  close(): void;
}

/**
 * A transport that never connects anybody: the default for a headless server a
 * test drives by calling `tick()` directly. Having one means `GameServer` never
 * needs a null check on its transport.
 */
export class NullTransport implements ServerTransport {
  onConnection(): void {
    // Nothing ever connects, so the handler is never called.
  }

  close(): void {
    // Nothing to close.
  }
}
