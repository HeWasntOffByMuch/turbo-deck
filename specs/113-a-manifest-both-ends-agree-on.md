# 113 — A manifest both ends agree on

## Problem

Step 7 of the brief says the bake "feeds the existing offline model build".
**There is no existing offline model build.** Nothing in this repo has ever
processed a mesh: `assets/units/` holds what Export copied there, `.glb` files
go into the bundle byte-for-byte, and the only asset pipeline that exists is
`scripts/bake-map.ts`, which bakes terrain to JSON.

So the honest reading of step 7 is: build it. And the part of it that is
entirely ours, that the brief marks as a **hard error**, and that nothing else
can substitute for, is the manifest:

> The manifest hash is exchanged with the server on client connect; mismatch is
> a hard error.

That is the part this spec does, plus the bake entry point that produces the
manifest and gates on what it can check without a mesh library.

## Why the hash matters

Everything else in this pipeline has a way of noticing when it is wrong. The
documents are validated, the clip lengths are measured, the import scale is
measured, the root bone is read off the rig. A client running against stale
assets has no such tell: it draws a unit that used to be right, at timings that
used to be right, and the fight it shows you is not the fight the server is
running. There is no symptom until somebody notices a hit landing on a frame it
should not.

A content hash exchanged at connect turns that into a refused connection, which
is the loudest possible version of the same fact.

## What is baked, and what is not

**Now, with no new dependency:**

- **Content hashes.** sha256 per file, and one manifest hash over the sorted set
  of them. The manifest is committed, so a change to the roster reviews as a
  diff rather than as a rebuilt binary blob.
- **The triangle-count gate**, from the validation checklist: within ±10% of the
  unitdef's declared `import.targetTris`. Countable straight off the glTF
  accessors, so it needs no mesh reader.
- **A hand-off from Export.** The Studio panel says to run the bake, rather than
  leaving a person to discover that a staged unit is not a built one.

**Deferred, and deliberately not faked:**

- **Decimation to a target**, **meshopt compression** and **KTX2 textures** all
  need a real library — `meshoptimizer` and a basis encoder. Adding either is a
  dependency decision, not an implementation detail, and a stage that silently
  passed the bytes through while claiming to have compressed them would be worse
  than an absent stage. The manifest records, per unit, which stages actually
  ran, so "not compressed" is a fact in the file rather than an assumption.
- **Vertex splitting for flat shading** is doable in pure TypeScript over
  `glb.ts`, but `glb.ts` can only *write* a mesh and read a document's JSON —
  there is no binary accessor reader yet. That is a day's work on its own and it
  is not what makes the pipeline unsafe today.

## Data and API shape

```ts
// src/units/manifest.ts — pure
interface UnitAssetEntry { path: string; sha256: string; bytes: number; }
interface UnitManifest {
  formatVersion: 1;
  /** sha256 over the sorted `path:sha256` lines. The thing both ends compare. */
  hash: string;
  builtStages: readonly string[];   // what actually ran; [] is honest
  units: readonly { id: string; family: string; entries: readonly UnitAssetEntry[] }[];
}

manifestHash(entries): string
compareManifests(client, server): 'match' | 'client-stale' | 'server-stale' | 'unknown'
```

Wire: `HelloMessage` gains `assetManifest: string` — the hash, or `''` from a
client that has none. `PROTOCOL_VERSION` 10 → 11, because the frame changed.

## The rule for an empty hash

A client that sends `''` is saying "I have no manifest", and that is **allowed**
and logged, not refused. Two reasons. A bot harness and the in-tab single-player
server share a process and cannot be out of date with themselves. And the first
thing a hard error must not do is make the repo unrunnable before the manifest
exists — a gate that fails closed on absence would have to be committed
simultaneously with every asset, in one commit, forever.

A client that sends a hash that *differs* is refused. That is the case the brief
is about: a real mismatch, stated rather than guessed at.

## Invariants to test

- The manifest hash changes when any file's bytes change, and does not change
  when unrelated things do (file order, absolute paths, the time it was built).
- Two runs of the bake over unchanged assets produce a byte-identical manifest.
- A client whose manifest hash differs from the server's is dropped with
  `BadProtocolVersion`, and the message names both hashes.
- A client sending an empty hash connects.
- The protocol version was bumped, so an old client is refused before the
  manifest is even compared.
- A unit whose triangle count is outside ±10% of its declared target fails the
  bake, and one inside it passes.
- Every `.glb` a unitdef references is in the manifest; a referenced file that
  is missing fails the bake rather than producing a manifest with a hole in it.

## Out of scope

- Decimation, meshopt and KTX2, per above. When a dependency is chosen they
  become stages that append to `builtStages`, and nothing else here changes.
- Serving assets over the wire. The manifest says what the bytes *are*, not how
  they travel; the client still fetches them over HTTP.
- Per-file repair. A mismatch is a refused connection, not a sync protocol.
