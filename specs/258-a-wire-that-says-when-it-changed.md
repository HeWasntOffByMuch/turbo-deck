# 258 — A wire that says when it changed

## Problem

A player on the published client got an uncaught `CodecError: truncated frame:
wanted 4 bytes, 0 left` on connecting to a restarted server. Reproduced exactly:
encode a `Stats` message on this build, drop the last four bytes, decode it.

```
CodecError: truncated frame: wanted 4 bytes, 0 left
  BufferReader.need <- BufferReader.f32 <- readTraits <- readStats <- decodeServerMessage
```

Four bytes is one trait. `TRAIT_WIRE_ORDER` went from 86 entries to 87 at spec
254, and `writeTraits` is the **tail** of `writeStats` — so a client one trait
ahead of its server reads four bytes past the end of every `Stats` frame, and
`Stats` is sent on login. The client is not subtly wrong for a while; it throws
before the first frame is drawn.

That mismatch is exactly what `PROTOCOL_VERSION` exists to refuse, and the
refusal is good: the server answers `Error(BadProtocolVersion, "server speaks
protocol N")`, which is two fields wide and decodable by every build in
existence. It did not fire, because **the version has been 20 since spec 226
while the wire changed underneath it at least ten times**:

- `Stats` lost `unspentSkillPoints`, renamed `unspentAttributePoints` to
  `unspentProgressionPoints`, and turned skill allocations into specialization
  allocations (spec 244)
- `Stats` gained `skillAbilityIds`, `weaponScaling`, `weaponDamageMin/Max`,
  `scalingModifiers` and `scalingAttributes` (specs 188, 216, 217, 238)
- `TRAIT_WIRE_ORDER` gained `staggerImmuneBelow` (spec 232) and
  `mobileOffenseCooldownTicks` (spec 254)
- `Effect` gained `rotation` (spec 235)
- `CombatResult` gained `element` (spec 229)
- `Talk` and `Conversation` were added (spec 246)

The version comment ledger is careful and well kept; it is just not *wired to
anything*. Nothing in the tree compares it against the wire it describes, so
"bump the version when the wire moves" is a habit, and a habit that has to hold
across ten commits by people who are thinking about something else does not
hold. The two halves are also deployed by two workflows on different triggers —
Pages on every push, the server only on pushes touching server paths — so the
window in which they disagree is not hypothetical, it is every rollout.

## Shape

Two things, one small and one mechanical.

**The bump.** `PROTOCOL_VERSION` goes to 21, with a ledger entry naming the wire
changes above. That converts today's failure, in both directions, from an
uncaught throw into `server speaks protocol N`.

**The guard.** A fingerprint of the wire's shape, pinned per version:

```ts
// src/server/net/wire-corpus.ts
export const CLIENT_CORPUS: readonly ClientMessage[];
export const SERVER_CORPUS: readonly ServerMessage[];

// src/server/net/wire-fingerprint.ts
export function wireFingerprint(): string;
export const WIRE_FINGERPRINTS: Readonly<Record<number, string>>;
```

The corpus is one representative message per member of `ClientMessageType` and
`ServerMessageType`. `wireFingerprint` encodes all of them and hashes the bytes.
`WIRE_FINGERPRINTS` is an **append-only ledger keyed by protocol version**, the
shape `StatusVisual.wire` already is and for the same reason: getting a green
suite after a wire change means either rewriting the row for a version that has
already been deployed — a diff that reads as obviously wrong — or adding a row
and bumping the version, which is one line each and the shape that is meant.

The hash is FNV-1a over the encoded bytes rather than anything from `node:`,
because this sits in the deterministic core and has to run in a browser tab as
well as in CI. What is being detected is accidental drift, not an adversary.

The corpus moves out of `codec.test.ts`, which already held two of them for the
round-trip test, so there is one canonical set of message shapes rather than a
test's copy and a fingerprint's copy.

## Invariants tested

- `WIRE_FINGERPRINTS[PROTOCOL_VERSION]` equals `wireFingerprint()`. This is the
  guard: any change to any message's encoding fails it, and the failure says to
  bump the version and add a row.
- The corpus names **every** member of `ClientMessageType` and
  `ServerMessageType`. A message type added and left out of the corpus would be
  a shape the fingerprint cannot see, so exhaustiveness is asserted rather than
  maintained by hand.
- Every corpus entry survives encode/decode — the round-trip property
  `codec.test.ts` already asserted, now over a set that is known to be complete.
- `wireFingerprint()` is stable across calls, and changes when a trait is added
  to `TRAIT_WIRE_ORDER`. The second half is the regression test for this
  incident: the exact edit that caused it now fails CI.
- A `Stats` frame one trait short still fails with the reported error, decoded
  by `readTraits`. The bug is pinned, not just fixed around.
- `WIRE_FINGERPRINTS` has a row for `PROTOCOL_VERSION` and no gaps below it.

## Out of scope

**Making the client survive an undecodable frame.** `codec.ts` says a
`CodecError` is for "the caller drops the frame" and no caller drops anything:
`GameClient.receive` has no `catch`, so one malformed frame throws out of the
socket callback and takes the message pump with it. That is a real second
finding and it is deliberately not fixed here — "drop it and carry on" hides
protocol bugs, and "fail loudly and disconnect" is a change to how the client
reports a fault, which wants its own spec. The version guard removes the way
this incident *reached* the decoder; it does not make the decoder forgiving.

**Making the two deploys atomic.** The server and the client will still be at
different commits for the few minutes a rollout takes. The point of the guard is
not to close that window but to make what happens inside it legible: a refusal
naming two version numbers, rather than a stack trace in a minified bundle.

**A negotiated or backward-compatible wire.** One version, both ends, refuse on
mismatch. Nothing here makes an old client work against a new server.
