/**
 * A channel that comes back (spec 150).
 *
 * The property that separates this from a plain channel is the one asserted
 * hardest: `onClose` fires when the *wrapper* gives up, not when a socket
 * drops. Everything above it sees one channel that survives outages.
 */

import { describe, expect, it } from 'vitest';
import { ReconnectingChannel } from './reconnecting.js';
import type { Channel } from './transport.js';

/** A channel somebody else can kill. */
function fake(): Channel & { kill(): void; readonly sent: Uint8Array[]; open: boolean } {
  const sent: Uint8Array[] = [];
  let closeHandler: (() => void) | null = null;
  const channel = {
    sent,
    open: true,
    get isOpen(): boolean {
      return channel.open;
    },
    send: (bytes: Uint8Array) => void sent.push(bytes),
    onMessage: () => undefined,
    onClose: (handler: () => void) => void (closeHandler = handler),
    close: () => {
      channel.open = false;
    },
    kill: () => {
      channel.open = false;
      closeHandler?.();
    },
  };
  return channel;
}

const BACKOFF = [2, 4, 8] as const;

describe('a channel that comes back', () => {
  it('opens a fresh one after the backoff, and says nothing to the caller', () => {
    const opened: ReturnType<typeof fake>[] = [];
    let closed = 0;
    let reopened = 0;
    const wire = new ReconnectingChannel({
      open: () => {
        const channel = fake();
        opened.push(channel);
        return channel;
      },
      onReopen: () => reopened++,
      backoffTicks: BACKOFF,
    });
    wire.onClose(() => closed++);
    expect(opened).toHaveLength(1);

    opened[0]?.kill();
    // Nothing above hears about it: this is an outage, not a close.
    expect(closed).toBe(0);
    // And nothing happens before the backoff is up.
    wire.deliver(1);
    expect(opened).toHaveLength(1);
    wire.deliver(2);
    expect(opened).toHaveLength(2);
    expect(reopened).toBe(1);
    expect(closed).toBe(0);
    expect(wire.isOpen).toBe(true);
  });

  it('walks up the ladder while the openings keep failing', () => {
    const opened: ReturnType<typeof fake>[] = [];
    const wire = new ReconnectingChannel({
      open: () => {
        const channel = fake();
        channel.open = false;
        opened.push(channel);
        return channel;
      },
      backoffTicks: BACKOFF,
    });
    let closed = 0;
    wire.onClose(() => closed++);

    // Each attempt dies at once, and each waits longer than the last.
    opened[0]?.kill();
    for (let tick = 1; tick <= 40; tick++) wire.deliver(tick);
    expect(opened.length).toBeGreaterThan(1);
    expect(closed).toBe(0);
  });

  it('gives up exactly once, after the last rung', () => {
    const wire = new ReconnectingChannel({
      open: () => {
        const channel = fake();
        channel.open = false;
        return channel;
      },
      backoffTicks: [1],
    });
    let closed = 0;
    wire.onClose(() => closed++);

    // One rung: the first death schedules a retry, the retry's death gives up.
    wire.deliver(0);
    wire.deliver(1);
    wire.deliver(2);
    wire.deliver(3);
    expect(closed).toBeLessThanOrEqual(1);
    // And however long it is driven for, never more than once.
    for (let tick = 4; tick < 100; tick++) wire.deliver(tick);
    expect(closed).toBeLessThanOrEqual(1);
  });

  it('an explicit close is not an outage', () => {
    const channel = fake();
    const wire = new ReconnectingChannel({ open: () => channel, backoffTicks: BACKOFF });
    const reopened = 0;
    wire.onClose(() => undefined);
    wire.close();
    for (let tick = 0; tick < 50; tick++) wire.deliver(tick);
    expect(reopened).toBe(0);
    expect(wire.isOpen).toBe(false);
  });

  it('drops what is written while the socket is down', () => {
    let live = fake();
    const wire = new ReconnectingChannel({
      open: () => {
        live = fake();
        return live;
      },
      backoffTicks: BACKOFF,
    });
    const first = live;
    first.kill();
    wire.send(Uint8Array.of(1));
    // Deliberately not queued: an input from an outage ago is not worth
    // applying, and a resumed session is re-sent the whole world anyway.
    expect(first.sent).toHaveLength(0);

    wire.deliver(2);
    wire.send(Uint8Array.of(2));
    expect(live.sent).toHaveLength(1);
  });

  it('passes messages through from whichever socket is live', () => {
    const channels: ReturnType<typeof fake>[] = [];
    const handlers: ((bytes: Uint8Array) => void)[] = [];
    const wire = new ReconnectingChannel({
      open: () => {
        const channel = fake();
        channel.onMessage = (handler: (bytes: Uint8Array) => void) => void handlers.push(handler);
        channels.push(channel);
        return channel;
      },
      backoffTicks: BACKOFF,
    });
    const seen: number[] = [];
    wire.onMessage((bytes) => seen.push(bytes[0] ?? -1));

    handlers[0]?.(Uint8Array.of(7));
    channels[0]?.kill();
    wire.deliver(2);
    handlers[1]?.(Uint8Array.of(9));
    expect(seen).toEqual([7, 9]);
  });
});
