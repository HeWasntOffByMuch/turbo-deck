/**
 * A fingerprint of the wire's shape, pinned per protocol version (spec 258).
 *
 * `PROTOCOL_VERSION` is a promise that both ends agree on the wire, and a
 * promise only holds if bumping it is a habit nobody forgets across however
 * many commits happen to touch a message between one version and the next. It
 * sat at 20 from spec 226 through at least ten wire changes -- `Stats` lost a
 * field and gained six, `TRAIT_WIRE_ORDER` grew twice, `Effect` and
 * `CombatResult` each gained a field, a whole message pair was added -- and
 * every one of them shipped without the number moving, because nothing in the
 * tree ever compared the version against the bytes it was supposed to
 * describe. The ledger in `config.ts` was careful and well kept; it just was
 * not wired to anything.
 *
 * `wireFingerprint` is that comparison, made mechanical instead of remembered:
 * encode a known corpus of messages, hash the bytes, and
 * `wire-fingerprint.test.ts` asserts the hash against this version's row in
 * {@link WIRE_FINGERPRINTS}. A change to any message's shape moves the hash,
 * which fails the one test whose entire job is to remind somebody to bump the
 * version and add a row.
 *
 * **FNV-1a rather than `node:crypto`.** `messages.ts` and `codec.ts` are run
 * from inside a browser tab by the in-tab loopback server (spec 057) -- it
 * exchanges the *exact bytes* a real connection would rather than shortcut to
 * decoded objects, precisely so single-player exercises the same wire code a
 * real client does. This module sits beside them for the same reason
 * `wire-corpus.ts` does, and `crypto.createHash` does not exist in that tab.
 * FNV-1a needs nothing the platform did not already give a plain function --
 * XOR and a 32-bit multiply -- so one implementation runs everywhere instead
 * of a Node path and a browser path that could quietly answer differently.
 * Nor is it being asked to resist an adversary: what this catches is an
 * accidental edit, not a forged collision, and 32 bits is ample for that.
 */

import { CLIENT_CORPUS, SERVER_CORPUS } from './wire-corpus.js';
import { encodeClientMessage, encodeServerMessage } from './messages.js';

/** FNV-1a's 32-bit offset basis and prime -- the constants the algorithm is. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * One step of FNV-1a: fold one byte into a running 32-bit hash.
 *
 * `Math.imul` keeps the multiply inside 32 bits exactly; plain `*` would
 * promote through a float and silently lose the high bits above 2^53, which
 * is the same reason `shared/hash.ts`'s spatial hash uses it. This is that
 * algorithm applied to a different domain -- raw bytes rather than the UTF-16
 * code units a document's text is made of -- and not a second implementation
 * of it: bridging a `Uint8Array` through a string first would need a text
 * encoding that promises every byte value survives unchanged, and none does.
 * `TextDecoder`'s own `latin1` label is actually windows-1252, which remaps
 * exactly the 0x80-0x9F range a varuint's continuation bit and a multi-byte
 * UTF-8 string both put bytes in. Folding the bytes in directly has nothing
 * subtle to get wrong about that mapping.
 */
function fnv1aByte(hash: number, byte: number): number {
  return Math.imul(hash ^ byte, FNV_PRIME);
}

function fnv1aBytes(hash: number, bytes: Uint8Array): number {
  let mixed = hash;
  for (const byte of bytes) mixed = fnv1aByte(mixed, byte);
  return mixed;
}

/** The same fold over a short literal tag, one byte per ASCII character. */
function fnv1aTag(hash: number, tag: string): number {
  let mixed = hash;
  for (let i = 0; i < tag.length; i++) mixed = fnv1aByte(mixed, tag.charCodeAt(i));
  return mixed;
}

/**
 * A corpus in a canonical order: by wire `type`, and stable on a tie.
 *
 * `Array.prototype.sort` has been a stable sort since ES2019, so two messages
 * that share a type keep the corpus's own relative order for free -- there is
 * no hand-rolled index key to keep in step with the array it is sorting. What
 * this buys is the property `wire-fingerprint.test.ts` names directly:
 * reordering `CLIENT_CORPUS` or `SERVER_CORPUS` -- adding an entry in the
 * middle, moving one for readability -- must not move the hash, or the guard
 * would be fingerprinting the corpus's *file*, not the wire's shape. Only the
 * encoded bytes may decide it.
 */
function sortedByType<T extends { readonly type: number }>(corpus: readonly T[]): readonly T[] {
  return [...corpus].sort((a, b) => a.type - b.type);
}

/**
 * Hash every corpus message's encoded bytes into one fingerprint.
 *
 * The client and server halves are hashed in sequence behind their own
 * literal tag rather than combined some other way -- summed, or XORed, or
 * hashed separately and merged -- because this is a single running FNV-1a
 * accumulator and a sequential hash does not commute: folding in `'client'`
 * ahead of one set of bytes and `'server'` ahead of another means a message
 * shape that moved from one half to the other changes *where in the stream*
 * its bytes land, not just which pile they are added to. A combining step
 * that treated the two halves symmetrically (an XOR of two independent
 * hashes, say) could in principle let a change on one side cancel a change on
 * the other; prefixing distinctly and folding both into one stream cannot.
 */
export function wireFingerprint(): string {
  let hash = FNV_OFFSET_BASIS;
  hash = fnv1aTag(hash, 'client');
  for (const message of sortedByType(CLIENT_CORPUS)) {
    hash = fnv1aBytes(hash, encodeClientMessage(message));
  }
  hash = fnv1aTag(hash, 'server');
  for (const message of sortedByType(SERVER_CORPUS)) {
    hash = fnv1aBytes(hash, encodeServerMessage(message));
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The fingerprint the wire produced at each `PROTOCOL_VERSION`, append-only.
 *
 * The same shape `StatusVisual.wire` already is, and for the same reason:
 * **add a row; never edit one that has shipped.** Rewriting the entry for a
 * version already deployed, to make a red suite green, is a diff that reads
 * as obviously wrong on sight: a server and a client both still speaking that
 * old version really did exchange the bytes the old row hashed, and editing
 * the row does not change what they sent each other, only what this file
 * claims about it. The shape this ledger is built to make easy is the honest
 * one instead -- the wire moved, so `PROTOCOL_VERSION` moves with it, and a
 * new row names what the new number's wire actually hashes to. Both are one
 * line, and neither is optional: `wire-fingerprint.test.ts` also refuses a
 * version with no row at all, and a gap below the highest one, because either
 * is a ledger that has stopped describing the wire it sits next to.
 *
 * 21 is the value {@link wireFingerprint} computed against the corpus at the
 * moment spec 258 closed the gap described in `config.ts`'s own ledger entry
 * for this version -- run, not guessed, because a guessed hash guards nothing.
 */
export const WIRE_FINGERPRINTS: Readonly<Record<number, string>> = {
  21: '8b94cf2b',
};
