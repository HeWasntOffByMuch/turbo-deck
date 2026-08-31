/**
 * The guard itself (spec 258): the incident this spec responds to was a wire
 * that moved for ten commits while `PROTOCOL_VERSION` held still, so every
 * assertion here is either "the number and the bytes still agree" or "the one
 * time they were made to disagree on purpose, the disagreement was loud."
 */

import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../config.js';
import { CodecError } from './codec.js';
import { decodeClientMessage, decodeServerMessage, encodeClientMessage, encodeServerMessage } from './messages.js';
import { ClientMessageType, ServerMessageType } from './protocol.js';
import { TRAIT_WIRE_ORDER } from '../state/types.js';
import { CLIENT_CORPUS, SERVER_CORPUS } from './wire-corpus.js';
import { WIRE_FINGERPRINTS, wireFingerprint } from './wire-fingerprint.js';

describe('wireFingerprint', () => {
  it('matches the ledger entry for the running protocol version', () => {
    expect(
      wireFingerprint(),
      `the wire has moved since PROTOCOL_VERSION ${PROTOCOL_VERSION} was pinned -- bump ` +
        'PROTOCOL_VERSION in src/server/config.ts and add a row to WIRE_FINGERPRINTS ' +
        'naming what changed',
    ).toBe(WIRE_FINGERPRINTS[PROTOCOL_VERSION]);
  });

  it('is stable across calls', () => {
    expect(wireFingerprint()).toBe(wireFingerprint());
  });

  /**
   * The regression test for the incident itself: spec 254 added one entry to
   * `TRAIT_WIRE_ORDER` and nothing noticed. `writeTraits`/`readTraits` walk
   * the exported array directly on every call, so growing it by one entry
   * here is the same edit, made and undone rather than committed.
   *
   * The array is `readonly` only at the type level -- nothing freezes it at
   * runtime -- so the cast is what spec 254's own commit was, and the
   * `finally` (plus the equality check after it) is what proves this test
   * left no trace: TRAIT_WIRE_ORDER is shared by every other test in the
   * suite, and a mutation that leaked would grow it by one entry for good.
   */
  it('changes when a trait is added to TRAIT_WIRE_ORDER', () => {
    const before = wireFingerprint();
    const mutable = TRAIT_WIRE_ORDER as unknown as string[];
    const startingLength = mutable.length;
    const first = mutable[0];
    if (first === undefined) throw new Error('TRAIT_WIRE_ORDER is unexpectedly empty');
    mutable.push(first);
    try {
      expect(wireFingerprint()).not.toBe(before);
    } finally {
      mutable.length = startingLength;
    }
    expect(wireFingerprint()).toBe(before);
  });
});

describe('corpus completeness', () => {
  // Derived from the enums rather than hand-listed, which is the whole point:
  // a message type added to protocol.ts and forgotten here is a shape the
  // fingerprint cannot see, and a hand-written list would not notice either.
  it('names every ClientMessageType', () => {
    const expected = new Set(Object.values(ClientMessageType));
    const covered = new Set(CLIENT_CORPUS.map((message) => message.type));
    expect(covered).toEqual(expected);
  });

  it('names every ServerMessageType', () => {
    const expected = new Set(Object.values(ServerMessageType));
    const covered = new Set(SERVER_CORPUS.map((message) => message.type));
    expect(covered).toEqual(expected);
  });

  it('survives encode/decode for every client corpus entry', () => {
    for (const message of CLIENT_CORPUS) {
      expect(decodeClientMessage(encodeClientMessage(message))).toEqual(message);
    }
  });

  it('survives encode/decode for every server corpus entry', () => {
    for (const message of SERVER_CORPUS) {
      expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
    }
  });
});

describe('the reported incident', () => {
  /**
   * Encode a real `Stats` message, drop the last four bytes -- one f32, one
   * trait -- and decode it. This is the reproduction from the bug report
   * verbatim: a client one trait ahead of its server reads past the end of
   * every `Stats` frame, because `writeTraits` is the tail of `writeStats`.
   */
  it('a Stats frame one trait short fails exactly as reported', () => {
    const stats = SERVER_CORPUS.find((message) => message.type === ServerMessageType.Stats);
    expect(stats, 'the corpus must carry a Stats fixture for this to mean anything').toBeDefined();
    if (!stats) return;

    const frame = encodeServerMessage(stats);
    const shortOfOneTrait = frame.subarray(0, frame.length - 4);

    let caught: unknown;
    try {
      decodeServerMessage(shortOfOneTrait);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CodecError);
    const error = caught as CodecError;
    expect(error.message).toBe('truncated frame: wanted 4 bytes, 0 left');
    // Pins where it came from, not merely that something threw: readTraits is
    // the tail of readStats, so the same shortfall anywhere else in the
    // message would throw at a different byte count or a different frame.
    expect(error.stack ?? '').toContain('readTraits');
  });
});

describe('WIRE_FINGERPRINTS ledger', () => {
  it('has a row for the running PROTOCOL_VERSION', () => {
    expect(WIRE_FINGERPRINTS[PROTOCOL_VERSION]).toBeDefined();
  });

  // Append-only, the shape StatusVisual.wire already is: a row is added, never
  // edited, so the ledger's own keys should never skip a version -- a gap
  // would mean a version existed that nobody ever pinned a fingerprint for.
  it('has no gap between its lowest and highest key', () => {
    const versions = Object.keys(WIRE_FINGERPRINTS)
      .map(Number)
      .sort((a, b) => a - b);
    expect(versions.length).toBeGreaterThan(0);
    const lowest = versions[0];
    const highest = versions[versions.length - 1];
    if (lowest === undefined || highest === undefined) {
      throw new Error('WIRE_FINGERPRINTS has no rows');
    }
    for (let version = lowest; version <= highest; version++) {
      expect(WIRE_FINGERPRINTS[version], `missing a row for protocol version ${version}`).toBeDefined();
    }
  });
});
