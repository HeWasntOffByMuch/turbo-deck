/**
 * A shop answer that has been superseded (spec 249).
 *
 * The shop window is opened by a reply in a conversation and shuts itself when
 * the server says there is no shop -- which it says with an **empty**
 * `VendorState`. The trouble is that closing a shop is itself a request,
 * `openVendor('')`, and its answer is the same empty message. So shutting the
 * list and pressing the merchant's reply again puts two requests in flight, and
 * the answer to the *close* lands on the window the *open* has just put up.
 *
 * That is the whole of "the shop only flashes for a split second", and it is
 * invisible over a loopback: both answers arrive in one batch before the next
 * frame is drawn, the last one wins, and every test in the tree passes. It
 * needs a channel that can hold a message back, which is what this file has --
 * a real server and a real session, with delivery under the test's control.
 *
 * The second case is the control, and the fix does not work without it: an
 * empty answer that is *current* still has to shut the window, or walking out
 * of range would leave a price list nobody can act on.
 */

import { describe, expect, it } from 'vitest';

import { decodeServerMessage } from '../net/messages.js';
import { ServerMessageType } from '../net/protocol.js';
import type { Channel } from '../net/transport.js';
import { LoopbackTransport } from '../net/transport-loop.js';
import { GameServer } from '../server.js';
import { GameClient } from './game-client.js';
import { QUARTERMASTER_HOME } from '../data/vendors.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A real channel with a hand on the wire.
 *
 * Everything the client sends goes straight out. Coming back, **only the shop
 * answers** are held: the rest of the session -- the deltas, the stats, the
 * inventory -- goes through untouched, so the client stays alive while its
 * vendor answers are in flight. Holding everything would be a simpler class and
 * a useless one, because the first thing the queue would fill with is deltas
 * and a test releasing "the next message" would be releasing one of those.
 */
class HeldChannel implements Channel {
  private handler: ((bytes: Uint8Array) => void) | null = null;
  private readonly queue: Uint8Array[] = [];
  private holding = false;

  constructor(private readonly inner: Channel) {
    inner.onMessage((bytes) => {
      if (this.holding && decodeServerMessage(bytes).type === ServerMessageType.VendorState) {
        this.queue.push(bytes);
        return;
      }
      this.handler?.(bytes);
    });
  }

  /** How many shop answers are waiting. */
  get pending(): number {
    return this.queue.length;
  }

  send(bytes: Uint8Array): void {
    this.inner.send(bytes);
  }
  close(): void {
    this.inner.close();
  }
  get isOpen(): boolean {
    return this.inner.isOpen;
  }
  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.handler = handler;
  }
  onClose(handler: () => void): void {
    this.inner.onClose(handler);
  }

  hold(): void {
    this.holding = true;
  }
  /** Let everything that piled up through, oldest first, as a socket would. */
  release(): void {
    this.holding = false;
    while (this.queue.length > 0) {
      const bytes = this.queue.shift();
      if (bytes) this.handler?.(bytes);
    }
  }
  /** Let exactly one message through, so an ordering can be staged. */
  releaseOne(): void {
    const bytes = this.queue.shift();
    if (bytes) this.handler?.(bytes);
  }
}

interface Harness {
  readonly client: GameClient;
  readonly wire: HeldChannel;
  readonly tick: (times?: number) => Promise<void>;
}

async function harness(): Promise<Harness> {
  const transport = new LoopbackTransport();
  const server = new GameServer({ seed: 5, transport });
  transport.onConnection((channel) => server.accept(channel));

  const wire = new HeldChannel(transport.connect());
  const client = new GameClient(wire, { playerId: 'p1', displayName: 'Ana' });
  const welcome = client.connect();
  await settle();
  await welcome;
  await settle();

  const tick = async (times = 1): Promise<void> => {
    for (let i = 0; i < times; i++) {
      server.tick();
      client.advanceTick();
    }
    await settle();
  };
  // Every shop this file opens is the quartermaster's, and a shop is refused
  // out of its own reach. The arrival point used to be inside all three shops'
  // reach and, since the spawn was gated and the town moved off it, is inside
  // none -- so standing at the counter is a precondition to state rather than
  // one the spawn happens to satisfy. Through the sim's own teleport, because a
  // tick mirrors the authoritative position back over a hand-written record.
  server.teleport('p1', QUARTERMASTER_HOME.x, QUARTERMASTER_HOME.y);
  await tick(2);
  return { client, wire, tick };
}

describe('the answers a client keeps', () => {
  it('drops one that a later request has superseded', async () => {
    const { client, wire, tick } = await harness();

    // Two requests in flight: the close, then the re-open. This is one press of
    // a window's X followed by one press of a merchant's reply.
    wire.hold();
    client.openVendor('');
    client.openVendor('vendor.quartermaster');
    await tick(2);
    // Both answers really are in flight. Without this the test passes just as
    // happily over a wire that held nothing.
    expect(wire.pending, 'two shop answers should be in flight').toBe(2);

    // The answer to the close arrives first, and it is empty.
    wire.releaseOne();
    const afterStale = client.view().vendorRevision;
    expect(
      afterStale,
      'an empty answer to a request nobody is waiting for moved the revision, ' +
        'which is what shuts a shop that has only just opened',
    ).toBe(0);

    // ...and then the one that was actually asked for.
    wire.release();
    expect(client.view().vendor?.id).toBe('vendor.quartermaster');
    expect(client.view().vendorRevision).toBeGreaterThan(afterStale);
  });

  it('still keeps an empty answer that is the newest one', async () => {
    // The control. Without it the fix is "ignore empty answers", and a shop
    // the server refuses would stay on screen with a list nobody can buy from.
    const { client, wire, tick } = await harness();
    const before = client.view().vendorRevision;

    wire.hold();
    // A shop that does not exist, which the server refuses exactly as it
    // refuses one out of reach: an empty `VendorState`.
    client.openVendor('vendor.nowhere');
    await tick(2);
    wire.release();

    expect(client.view().vendor).toBeNull();
    expect(
      client.view().vendorRevision,
      'a refusal has to move the revision, or the window never shuts',
    ).toBeGreaterThan(before);
  });

  it('counts a purchase as a request, since the server answers one with a shop', async () => {
    // `BuyItem`, `SellItem` and `BuyBack` are each answered with a
    // `VendorState` as well as an `Inventory`. Left uncounted, the answers run
    // permanently ahead of the requests -- so the rule above stops firing after
    // the first thing anybody buys, which is the worst way for it to fail: it
    // works when you try it and not in the session you play.
    //
    // Asserted by doing the race *after* a purchase rather than by counting,
    // because the count is the mechanism and this is the behaviour.
    const { client, wire, tick } = await harness();

    client.openVendor('vendor.quartermaster');
    await tick(2);
    client.buyItem('vendor.quartermaster', 'potion.minor', 1);
    await tick(2);
    const settled = client.view().vendorRevision;

    // Now the same close-then-reopen as the first case.
    wire.hold();
    client.openVendor('');
    client.openVendor('vendor.quartermaster');
    await tick(2);
    expect(wire.pending, 'two shop answers should be in flight').toBe(2);

    wire.releaseOne();
    expect(
      client.view().vendorRevision,
      'after a purchase the counting has drifted, so the superseded answer got through',
    ).toBe(settled);

    wire.release();
    expect(client.view().vendor?.id).toBe('vendor.quartermaster');
  });
});
