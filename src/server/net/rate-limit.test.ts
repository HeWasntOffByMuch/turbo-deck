/**
 * How often a client may say a thing (spec 151), and what arbitrary bytes do
 * to the codec.
 *
 * The fuzzing is the half worth having. Everything else here is a table; a
 * decoder is the one place where the interesting inputs are the ones nobody
 * would think to write down.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CHAT_BURST,
  FLOOD_STRIKES,
  HEARTBEAT_BURST,
  MAX_FRAME_BYTES,
  RateLimiter,
  VERB_BURST,
  bucketFor,
} from './rate-limit.js';
import { ClientMessageType } from './protocol.js';
import { CodecError } from './codec.js';
import { decodeClientMessage, decodeServerMessage } from './messages.js';
import { SERVER_TICK_RATE } from '../config.js';

describe('the buckets', () => {
  it('never throttles one verb a tick, however long it goes on', () => {
    const limiter = new RateLimiter(0);
    for (let tick = 0; tick < 10_000; tick++) {
      expect(limiter.allow(ClientMessageType.UseAbility, tick)).toBe(true);
    }
    expect(limiter.strikeCount).toBe(0);
  });

  it('throttles a hundred a tick, and gives up on it', () => {
    const limiter = new RateLimiter(0);
    let allowed = 0;
    for (let tick = 0; tick < 20; tick++) {
      for (let i = 0; i < 100; i++) {
        if (limiter.allow(ClientMessageType.UseAbility, tick)) allowed += 1;
      }
    }
    expect(allowed).toBeLessThan(2000);
    expect(limiter.flooding).toBe(true);
    expect(limiter.strikeCount).toBeGreaterThanOrEqual(FLOOD_STRIKES);
  });

  it('keeps the buckets independent', () => {
    const limiter = new RateLimiter(0);
    // Empty the chat bucket.
    for (let i = 0; i < CHAT_BURST + 20; i++) limiter.allow(ClientMessageType.Chat, 0);
    expect(limiter.allow(ClientMessageType.Chat, 0)).toBe(false);
    // The flooder can still cast, and still ping. Taking the clock sync away
    // would turn a noisy client into a drifting one, which is a problem the
    // server would then have to absorb (spec 148).
    expect(limiter.allow(ClientMessageType.UseAbility, 0)).toBe(true);
    expect(limiter.allow(ClientMessageType.Ping, 0)).toBe(true);
  });

  it('is tightest on the one verb everybody else pays for', () => {
    expect(CHAT_BURST).toBeLessThan(HEARTBEAT_BURST);
    expect(HEARTBEAT_BURST).toBeLessThan(VERB_BURST);
  });

  it('exempts what is already limited elsewhere, and limits what it has not met', () => {
    expect(bucketFor(ClientMessageType.Input)).toBe('exempt');
    expect(bucketFor(ClientMessageType.RequestChunk)).toBe('exempt');
    expect(bucketFor(ClientMessageType.Chat)).toBe('chat');
    expect(bucketFor(ClientMessageType.Ping)).toBe('heartbeat');
    // Anything this table has never heard of is limited by default rather than
    // by somebody remembering to add it.
    expect(bucketFor(0xfe)).toBe('verbs');
  });

  it('refills, so a burst is a burst rather than a budget for the session', () => {
    const limiter = new RateLimiter(0);
    for (let i = 0; i < VERB_BURST + 10; i++) limiter.allow(ClientMessageType.Equip, 0);
    expect(limiter.allow(ClientMessageType.Equip, 0)).toBe(false);
    expect(limiter.allow(ClientMessageType.Equip, SERVER_TICK_RATE * 5)).toBe(true);
  });
});

describe('arbitrary bytes into the codec', () => {
  const bytes = fc.uint8Array({ minLength: 0, maxLength: 512 });

  /** Either it decoded into a message, or it refused with the one error type. */
  function decodesOrRefuses(frame: Uint8Array): void {
    for (const decode of [decodeClientMessage, decodeServerMessage]) {
      try {
        const message = decode(frame);
        // A decode that "succeeded" still has to have produced a message.
        expect(typeof message).toBe('object');
        expect(typeof (message as { type: number }).type).toBe('number');
      } catch (error) {
        if (!(error instanceof CodecError)) throw error;
      }
    }
  }

  /**
   * Frames that have actually broken this, kept by hand (spec 152).
   *
   * The generated cases below found the first of these and then found it again
   * only about one run in three, because the property was unseeded -- so it
   * shipped green and made CI flaky for everybody instead of failing once,
   * loudly, on the commit that introduced it. A regression this specific should
   * not depend on a dice roll, so it is spelled out.
   */
  const KNOWN_BAD: readonly (readonly number[])[] = [
    // An inventory whose declared count is past 2^32: `new Array(count)` threw
    // a RangeError, which is not a CodecError, so nothing caught it.
    [82, 0, 128, 128, 128, 64],
    // The same shape below 2^32, where it allocated gigabytes instead of
    // throwing -- the ArrayPrototypeFill frame in the CI heap-exhaustion stack.
    [82, 0, 255, 255, 255, 255, 15],
    // A delta claiming four billion removals.
    [65, 1, 1, 255, 255, 255, 255, 15],
  ];

  it('refuses a frame that declares more than it could possibly hold', () => {
    for (const bad of KNOWN_BAD) {
      const frame = Uint8Array.from(bad);
      // Timed, because the failure this replaces was an *allocation*: a decoder
      // that tried to honour the count could not return in a millisecond.
      const started = Date.now();
      expect(() => decodeServerMessage(frame)).toThrow(CodecError);
      expect(Date.now() - started).toBeLessThan(250);
      decodesOrRefuses(frame);
    }
  });

  it('either decodes or throws CodecError, and never anything else', () => {
    fc.assert(fc.property(bytes, decodesOrRefuses), {
      numRuns: 3000,
      // Seeded, because this repo's whole premise is that the same seed gives
      // the same answer, and a property that fails one run in three is the
      // opposite of a regression guard. Bump it deliberately to go looking for
      // more; what it must not do is vary by accident.
      seed: 20260812,
    });
  });

  it('survives a frame that claims to be enormous', () => {
    // A `str` whose declared length is four billion: the reader calls `need`
    // before it reads, so this is a thrown CodecError and not an allocation.
    const frame = Uint8Array.of(ClientMessageType.Chat, 0xff, 0xff, 0xff, 0xff, 0x0f);
    expect(() => decodeClientMessage(frame)).toThrow(CodecError);
  });

  it('refuses a varuint that never ends', () => {
    const frame = new Uint8Array(32).fill(0xff);
    frame[0] = ClientMessageType.Input;
    expect(() => decodeClientMessage(frame)).toThrow(CodecError);
  });

  it('bounds a frame before it is parsed', () => {
    // Not a codec property -- a server one -- but the number lives here.
    expect(MAX_FRAME_BYTES).toBeGreaterThan(1024);
    expect(MAX_FRAME_BYTES).toBeLessThan(1 << 20);
  });
});
