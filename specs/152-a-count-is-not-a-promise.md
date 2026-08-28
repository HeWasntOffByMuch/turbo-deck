# 152 — A count is not a promise

## Problem

`readInventory` reads a length straight off the wire and allocates it:

```ts
const count = reader.varuint();
const bag = new Array<ItemStack | null>(count).fill(null);
```

`decodeServerMessage(Uint8Array.from([82, 0, 128, 128, 128, 64]))` throws
`RangeError: Invalid array length` — not a `CodecError`, so nothing that
catches `CodecError` catches it. A count that is merely *large* rather than
invalid is worse: it allocates gigabytes and takes the process with it. That is
the `Builtin_ArrayPrototypeFill` frame in the heap-exhaustion stack that failed
CI twice while spec 151 was being merged, and it is the same bug wearing its
other face.

Spec 151's fuzz test — "either decodes or throws `CodecError`, and never
anything else" — is finding this correctly. It is random-seeded, so it finds it
roughly one run in three, which is why it shipped green and why CI has been
flaky since for everybody.

Thirteen sites allocate from a wire-supplied count, across `messages.ts` and
`map-messages.ts`. `readInventory` is the one that was caught.

## Assumptions

- **`str` already got this right**, and is the model: it calls `need(length)`
  *before* reading, so a declared length of four billion is a thrown
  `CodecError` and not an allocation. Counted collections never learned the
  same lesson.
- **Spec 151's frame cap does not cover this.** `MAX_FRAME_BYTES` bounds an
  incoming frame at 16KB, which bounds the *input*, not what the decoder is
  told to allocate from it. Six bytes ask for a four-billion-element array today.

## Shape

### One primitive, and the bound is a proof rather than a number

`BufferReader` gains a sibling to `str`:

```ts
/** A varuint that is about to size a collection. Refused if the frame is too short for it. */
count(): number;
```

It reads a varuint and throws `CodecError` if the value exceeds `remaining`.

That bound is exact, and worth spelling out because it means no legitimate frame
is ever refused and no arbitrary cap has to be tuned:

- Every element of every counted collection in this protocol costs **at least
  one byte** — a `str` is a varuint length of one byte minimum, a `varuint` is
  one byte minimum, a struct is at least one field.
- So a collection of `n` elements needs at least `n` bytes after its count.
- Therefore `n > remaining` describes exactly the frames that **cannot exist**,
  and refusing them rejects the impossible and nothing else.

The largest allocation any frame can now provoke is bounded by the frame that
carried it, which spec 151 already caps at 16KB.

### Every site that sizes a collection uses it

All thirteen, in `messages.ts` and `map-messages.ts`: the inventory, the skill
list, spawner states, vendor stock and buyback, trade offers, delta upserts and
removals, and the map's runs, species, layers, coords, heights, props and
markers. `reader.varuint()` stays for ids, levels, prices and every other
number that sizes nothing.

The distinction is the rule the file should read by afterwards: **a varuint that
is about to be used as a length is a different thing from a varuint that is a
value**, and it now has a different method.

### The fuzz test stops finding this by luck

Spec 151's codec property is seeded, so it is a regression guard rather than a
dice roll — this repo's whole premise is that the same seed gives the same
answer, and a test that fails one run in three is the opposite of that.

Seeding alone would narrow what it explores, so the frames that are already
known to break it — beginning with the six bytes above — become explicit cases
alongside the generated ones. A seed can be bumped deliberately to go looking
for more; what it must not do is vary by accident.

## Invariants tested

- **The reported frame.** `decodeServerMessage([82, 0, 128, 128, 128, 64])`
  throws `CodecError`, not `RangeError`, by name.
- **A count larger than the frame is refused, at every site.** For each of the
  thirteen, a frame declaring more elements than it has bytes throws
  `CodecError` and allocates nothing.
- **A count that only just fits is accepted**, so the bound is not off by one
  and no legitimate message is refused.
- **Nothing allocates before it is checked.** Asserted by time rather than by
  hope: decoding a frame that declares four billion elements returns in
  milliseconds, which an allocation of that size could not.
- **The fuzz property is deterministic.** Two runs of the codec property
  explore the same inputs and give the same answer.
- **Every real message still round-trips.** `codec.test.ts` is unmodified and
  passes: this refuses impossible frames and touches no possible one.

## Out of scope

- **Per-message maximums** — refusing an inventory of 500 because a bag holds
  24. That is a rules check and belongs where the rules are; this is the
  decoder, and its job is to refuse what cannot be decoded, not what would be
  silly. The `remaining` bound is what the decoder can prove on its own.
- **The admin namespace.** `admin-messages.ts` is token-gated and has no
  wire-counted allocation of this shape; if it grows one it should use the same
  primitive.
- **Making the encoder refuse to write an over-long collection.** The encoder is
  ours and its inputs come from the server's own state.
