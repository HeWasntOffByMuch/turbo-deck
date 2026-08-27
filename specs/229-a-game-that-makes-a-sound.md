# 229 — A game that makes a sound

## Problem

This game has been silent for two hundred specs, and it is silent in a
particular way: **every seam an audio system would plug into is already cut,
and every one of them is connected to nothing.**

- `src/ui/core/sound.ts` (spec 133) declares a closed `UiSoundId` vocabulary, a
  `SoundSink` interface, a `SILENT` default and a `RecordingSink` for tests. The
  sink is threaded to exactly one field — `Button.sounds` — and **assigned by
  nobody**, so every widget in the game emits into `SILENT`. Its own header says
  the real sink "lives in `src/render/`, where the platform is", and there is
  nothing there.
- `server/data/loot.ts` (spec 158) authors four cue **names** — `loot.spawn`,
  `loot.anticipation`, `loot.reveal.rare`, `loot.reveal.exceptional` — under a
  comment reading *"the renderer decides what a name sounds and looks like"*.
  `scene.ts`'s `playCue` hands them to the effect registry, which holds none of
  them, and drops them.
- `vfx/types.ts` (spec 121) has `SoundSpec { cue, on }` on every emitter,
  compiled by `compile.ts` into `soundCue`/`soundOn` and fired by `system.ts` at
  emitter start, at burst and at particle-collide — into `VfxHooks.sound`, which
  `scene.ts` does not supply. Its comment: *"a sink today; there is no audio
  system to wire it to."* One authored cue exists in the whole registry.
- `client/game-client.ts` exposes `onCastStarted` and `onCastEnded`, carrying the
  ability id, the phase and all three ticks. **Neither has a listener in the
  shipped renderer** — only in four tests.
- `src/render/music.ts` is 394 lines of pure note data whose header names an
  `audio.ts` that no longer exists. Nothing but its own test imports it.

Meanwhile 74 production sound takes are sitting on a branch: 51.56 MB of 96kHz
24-bit stereo WAV, of which a single footstep is 1.85 MB for **0.2 seconds of
content followed by 2.3 seconds of digital silence**. The whole library is 130
seconds of audio.

## Shape

### The one decision everything rests on

**The event set is code; the assignment of files to events is data.**

Gameplay says `audio.play('combat.hit.flesh', at)` and a typo is a build error.
Which `.ogg` that turns into is `assets/audio/sfx.json`, which the SFX tab writes
and nothing in gameplay reads. Adding a sound to a skill is an edit in a tool;
adding a *kind* of moment to the game is a row in `events.ts` plus one call site.

### The modules

```
src/render/audio/
  events.ts    the closed vocabulary: 57 rows, each with a bus, a section,      pure
               a placement and a sentence saying what fires it
  catalog.ts   the document: parse, write, resolve against defaults, clamp      pure
  variants.ts  which take, at what pitch, and whether at all                    pure
  mix.ts       per-bus levels, versioned over an injected StorageLike           pure
  sink.ts      the `Audio` interface, the handle type, and SILENT_AUDIO         pure
  engine.ts    the only AudioContext in the repo                              IMPURE

src/render/iso3d/world/
  audio-wire.ts     game facts -> sound events. Beside vfx-wire.ts             pure
  footsteps.ts      the distance accumulator                                   pure
  audio-driver.ts   the per-frame driver, over an injected `Audio`             pure

src/render/iso3d/sfx/
  model.ts     the tree, the filter, the edits, the coverage                   pure
  view.ts      the tab                                                          DOM
```

```ts
interface Audio {
  play(id: SoundEventId, options?: PlayOptions): void;
  hold(id: SoundEventId, options?: PlayOptions): AudioHandle;   // loops
  move(handle: AudioHandle, options: PlayOptions): void;
  isLive(handle: AudioHandle): boolean;
  stop(handle: AudioHandle): void;
  setListener(pose: ListenerPose): void;
  setMix(mix: AudioMix): void;
  setCatalog(catalog: SoundCatalog): void;
  warm(buses: readonly BusId[]): void;
  resume(): void;   // from a user gesture
  suspend(): void;
  stats(): AudioStats;
  stopAll(): void;
}
```

A catalog entry stores `variants` and **only what differs from the defaults**:

```json
"combat.hit.flesh": {
  "variants": ["/audio/combat/hits/sword_clash_01.ogg", "..."],
  "volume": 0.85,
  "pitch": { "min": 0.94, "max": 1.06 }
}
```

### The four decisions worth arguing over

**The listener sits at the player, not the camera.** This camera is
orthographic and parks a constant 6,000 units from its focus — only the two
orbit *angles* are reachable from a slider — so across the visible frame the
camera's distance to a source varies by under 7%. A camera-mounted listener
gives every sound identical attenuation and collapses every pan onto the view
axis. Two systems already hit this and rebased onto the focus: `inkOrigin`, and
the animation LOD, whose comment records every unit in the game reading as
maximally distant. Orientation is the camera's bearing *flattened to the ground
plane* — not an approximation of the camera's basis but exactly equal to it,
since `camera.up` is never assigned and the camera's right vector is therefore
horizontal at every elevation.

**`maxDistance` is a cull, not a fade.** The Web Audio `inverse` model clamps
distance into `[ref, max]` and never reaches zero, so a sound at the far edge
plays forever at a small non-zero gain — and forty of them is a wash of noise
from things nobody can see. The cull is a decision taken once, where a voice
would have been allocated, which is what makes the range mean what a designer
thinks it means. Nothing past ~1,697 units is replicated at all, so `max` is
bounded by the interest radius rather than by taste.

**There is no voice pool.** `AudioBufferSourceNode` is single-use by spec and
cheap to allocate for that reason; pooling it is not possible and pooling the
panner is not worth it. What there *is* is a voice **cap**, a distance **cull**,
and a per-event **cooldown** — because the thing that actually goes wrong is
`skill.whirlwind` landing on eight bodies in one tick, and eight copies of one
recording starting on the same sample is not eight sounds, it is one sound 2.5x
as loud with a comb filter on it.

**Randomness and time are arguments.** `variants.ts` takes a `Random`, the
throttle takes a `nowMs`. The sim's rule, for a weaker but real reason: "never
repeats a footstep immediately" is exactly the kind of claim that is true in the
three cases somebody tried by hand and false in the fourth.

### The assets

`npm run bake:audio` (ffmpeg, offline, the shape `bake:units` already has):
48kHz, Vorbis q4, **mono for anything spatial** (a `PannerNode` downmixes stereo
before it pans, so stereo is twice the bytes for an image that is discarded) and
the trailing silence trimmed. Leading silence deliberately is *not* trimmed:
trimming the head moves the transient, and a footstep that fires late is worse
than a footstep that is large. **51.56 MB → 1.36 MB, 97.4% smaller.** Sources
live in `assets/audio/raw/` and are gitignored for the reason `.studio/` is; the
baked tree is committed to `public/audio/`, which is `publicDir`, so one tree is
served by vite in dev and copied into `dist/` by a build at the same `/audio/…`
URL.

**The bake discovers; it is not told.** Every audio file under the source tree is
baked, at the name `paths.ts` derives from where it sits. The first cut had a
hand-written table of 74 rows, which made **adding a sound a code edit** — which
is precisely the friction the events/catalog split exists to remove, and it is
indefensible for the *file* half to have it when the *assignment* half does not.
The table survives as `BAKED_NAMES`, a rename map for the delivered library
alone, because those 74 paths are referenced by `sfx.json` and are not free to
move: drop a row and the name re-derives to something different and perfectly
valid, the catalog points at nothing, and the game goes quiet with every test
green. It is also **incremental** — a take whose `.ogg` is newer than its source
is skipped, so dropping in one file is one ffmpeg call rather than 74 — and it
**never deletes without `--prune`**. That last one is a deliberate reversal of
what a build usually does, and the reason is that the sources are gitignored: a
fresh clone has none of them, so a bake that tidied away what it could not
account for would delete the entire committed library the first time somebody ran
it before checking the raws out. Orphans are reported instead.

**`paths.ts` is one module because three places have to agree.** The bake writes
the file, the dev server decides where an upload may land, and the SFX tab
predicts the URL so it can assign a take the instant the bake finishes. If they
drifted, the failure would be an import that succeeds, a bake that succeeds, and
a variant pointing at a URL that 404s only when somebody swings a sword.

### Adding a sound

The whole of it, and none of it is a terminal: choose or drop files on the SFX
tab's editor pane. They are written under `assets/audio/raw/` at a folder
**derived from the event id** (shown, not hidden — somebody importing three takes
for one event should not have to invent a folder or remember where the last one
went), baked, and assigned as variants of the selected event.

`POST /api/sfx/import` takes the bytes **as the body** rather than as multipart:
a multipart parser is a dependency and a boundary to get right for a form with
one field, where `fetch(url, { body: file })` sends a `File` as its bytes with no
ceremony. `POST /api/sfx/bake` calls `bakeAudio` **in process**, so "ffmpeg is
not installed" is a sentence in the status line rather than an exit code and a
log somebody has to go and read; it blocks the dev server while it runs, which is
affordable exactly because the bake is incremental. Both are `apply: 'serve'`
like `POST /api/sfx`, and both are registered **before** it — vite matches
middleware by prefix, so `/api/sfx` would otherwise swallow them and try to parse
a `.wav` as a catalog.

Every folder segment is slugged, so traversal cannot leave the source root
whatever is sent. A segment with no alphanumeric in it is **refused anyway**: the
difference between neutralising an attempt and refusing one is that the first
quietly writes junk somewhere harmless and the second says what it thought it was
doing.

Two things learned by getting them wrong. The picker's re-read is **cache-busted
with a version query**, because `manifest.json` is a `publicDir` file with no
hash in its name — without it you can bake a file and be handed the manifest from
before it existed, which reads exactly like a bake that silently did nothing. And
only URLs the manifest **actually lists** are assigned, so a take ffmpeg refused
does not become a variant pointing at nothing.

### Follow-ups

**A wind-up is the weapon in your hand.** The sound was chosen by the *ability's*
damage, so a maul and the starting sword wound up identically. `weaponTypeFor`
(beside `weaponModelFor`, the question that file already answers) gives sword,
maul and staff a row each. Only ever your own weapon: equipment is replicated to
its owner alone, so a monster has none and another player's is not knowable, and
those keep `combat.swing.light/heavy` — which is what that pair is *for* now.
Two things beat it, both already right: the **look** first, because it is what
the body is drawn doing (an arrow ability draws a bow whether or not a bow is
equipped), then the **element**, so the ember staff still casts fire.

**A shot has three moments.** `combat.projectile.launch` and
`combat.projectile.impact` were rows fired by nothing, so a bow had a draw and
then silence. The loose is taken on a body's first frame, which *is* the release;
the landing is owed from the sweep that notices the body has gone. Both doors out
share one `end`, or an arrow lands audibly or silently depending on which pass
noticed first; `stopAll` fires none of them, because leaving the tab is not a
dozen arrows landing at once.

**Your own footsteps come out of your own head.** The listener sits on the
predicted self and bodies came from the replica, which lags it. For a monster
across the arena that lag is a rounding error on a long vector; for your own body
there is no vector for it to be small against, so the panner placed your
footsteps entirely by your own network lag — and the lag points backwards along
the way you are going, which put your feet in the wrong speaker. Measured: 0.0
units from the ears, 713 with the fix taken back out.

**A blow asks what the body is made of.** `bleeds` was hardcoded true at both
fact sites, so every blow routed to `combat.hit.flesh` and `combat.hit.armored`
was unreachable — the training dummy threw blood. `bleedsFor` is a deny list, so
the default is flesh: a monster added tomorrow bleeds unless somebody says
otherwise.

**The mix has to be able to reach the takes.** The bake does not normalise,
because loudness relative to the rest of the game is a mix decision and the mix
lives in the catalog. That assumes the catalog can express the range the takes
span, and at a 2x ceiling it could not: source levels differ by about 14 dB
across the delivered library, and a bow draw mixed to parity with a sword swing
needs 3.7x. The ceiling is 4x. And `ref` is a property of the *ability's reach* —
a bow reaches 420, so an arrow landing at the edge of its own range was losing
10 dB for being far away when what it is, is the thing the player just did.

**A footstep asks what the ground is made of.** One row per entry in
`TERRAIN_MATERIALS` — the authority, so a seventh material arrives with a
footstep row or fails a test rather than quietly walking on the fallback. The
reader is `MapChunkStore.materialAtWorld`, which answers the **baked** material;
`classify.ts`'s `worldMaterialAt` is the trap and is not it, because it
re-derives from height and slope with `region: 'default'` and so reports a
hand-painted dirt path as grass and painted snow as rock. Since spec 179 a
material is a *choice*, and this is the reader for the choice.

All six ship **unassigned**, and the fallback is what makes that possible:
`footstepEvents` returns an ordered preference and the driver plays the first the
catalog has files for, so today every surface resolves to `player.footstep` and
walking sounds exactly as it did. Without the chain, adding six rows would take
the sound of walking out of the game until somebody had recorded six sets of
takes. `Audio.has(id)` is what the driver asks — a question about the *document*,
not about whether a voice would start right now, since a buffer that has not
decoded, a source past the cull and a throttled repeat are all transient and none
of them mean an event has stopped existing.

`null` from the store is **"I do not know", never "no surface"**: it is the
ordinary state on a streaming client for ground a body is walking toward, and it
falls straight to the plain footstep — a body walking into un-arrived ground
should sound like a body walking, not like nothing.

The whole join can be dead with every Node test passing, because falling back is
exactly what those tests assert while the rows are unassigned. So the probe reads
`data-audio-surface` and requires a real material; measured `grass` on the shipped
map, and with a take temporarily assigned to `player.footstep.grass` the count
moves to that row and the plain one goes to zero.

## Invariants tested

- **Round trip.** `parseCatalog(catalogToJson(c))` is `c`, over the shipped
  document. Every variant URL in it names a file that exists under `public/audio/`.
- **Every URL the shipped catalog references is one the bake still produces**
  for the source it came from — the assertion that catches a dropped rename row,
  which is otherwise silent all the way to a player noticing a sound has gone.
- **Derivation is stable and URL-safe**: baking a source twice names it the same
  thing, a slugged name needs no escaping, and no segment is ever empty (`___.wav`
  is still a file, and a path segment of nothing is a different path).
- **Every event in the vocabulary gets its own import folder**, and no two share
  one — sharing would offer one event's takes under another and make
  `unusedClips` report neither.
- **An import never escapes the source root**, whatever folder it is handed: the
  path is relative, contains no `..`, and is exactly as deep as it looks.
- `catalogToJson` writes only fields that differ from `SOUND_DEFAULTS`, in the
  vocabulary's order.
- `parseCatalog` refuses a bad document whole and never returns a partial
  catalog; it *skips* an unknown event id, which is what lets a newer build's
  catalog still load.
- **A variant never repeats immediately** when there is more than one, under an
  adversarial `Random` (always 0, always 0.999999) as well as a uniform one, and
  every index stays reachable.
- **`soundsForBlow` returns nothing for a periodic blow** — the audio half of
  spec 219 — and `-0` is a heal rather than a blow.
- Every ability id in `ABILITY_ELEMENTS` is a real ability; the four loot cue ids
  exactly match `RARITIES[].cues`; the seven affliction rows exactly match
  `data/damage-over-time.ts`. A drift in any of those is a sound that silently
  never plays.
- **Footstep cadence is frame-rate independent**, at most one per frame per body,
  and a teleport-sized jump banks nothing.
- **The stagger edge fires once per break**, and first sight of an
  already-stunned body is never an edge.
- **A held loop is started once, asked `isLive` every frame, and owes a stop.**
  A refused `hold` retries; a stale handle is re-held; `sweep` stops what left.
- `mix.ts` never throws on a corrupt profile, is read-modify-write per field, and
  mute does not lose the level.
- SFX-tab edits never mutate the catalog they were handed; setting a field back
  to its default removes it from the document.

## Out of scope

- **Music.** `src/render/music.ts` stays an orphan. It is oscillator note data
  for a game that no longer exists, and reviving it is a decision about what this
  game sounds like rather than about how it makes a sound.
- **Surface-varied footsteps.** The signal is reachable and precise —
  `StreamedMap.meshLayers` is public and `MeshLayer.materialAt` returns the
  *baked* index, with `null` meaning "that chunk has not arrived" — but the
  library ships one boot set and one sandal set, which are two kinds of shoe and
  not two kinds of ground. Five surface rows with one assigned would be five
  things to look at and one thing to hear.
- **Ambience content.** Two rows and the emitter seam, no assets: inventing an
  ambient bed out of a combat library would be worse than silence.
- **Reverb, occlusion, DSP chains, voice prioritisation, streaming.** The
  extension point for the only one that might be needed is stated in
  `engine.ts`: if the voice cap starts refusing sounds a player wanted, the fix
  is priority (refuse the *furthest* live voice), not a pool.
- **Anything on the wire.** Audio is triggered client-side from events the client
  already receives. No message gained a field and no message was added.
