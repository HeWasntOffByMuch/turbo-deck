# 259 — A sign you can read

## Problem

There is nothing in this world that says anything to a player who is not
standing in front of a person. Spec 246 built a conversation — a bubble, a
reveal, a camera that leans in — and spec 247 gave it three bodies to come out
of, and all three of them are shopkeepers. A tutorial line, a place name, a
warning at a road fork: every one of those is a *sentence somebody wants to put
somewhere*, and the only way to put one anywhere is to author an NPC row, a
monster row, a voice and a spawner marker.

A sign is the cheap version of that, and this game already has almost all of it.
What it does not have is three things: a prop that looks like a board on a post,
a **string on that prop** so the words are a property of the thing rather than
of a table, and a client that treats a prop as something a click can act on.

## Shape

A sign is a `PropKind` and nothing else, which is spec 224's sentence about the
hut and 250's about the campfire, one system further along. It is written into
the map document, streamed, collided against, batched per region, previewed by
the structure ghost and taken out by the eraser without one line of any of those
asking what kind a prop is.

**The document.** `Prop.text?: string` and `MapProp.text?: string`, absent by
default, in exactly the shape `Prop.light` is — so no committed map gains a key,
no region file's bytes move and no `mapId` does either. `MapPropFlag.Text` is a
fourth bit on the wire prop and a `str` follows it when set, which is
`MapPropFlag.Light`'s own shape: the bit says whether a value follows, so the
common case pays the bit it was already paying.

```ts
export const SIGN_PLAN = { width: 84, height: 34, postHeight: 62 } as const;
/** The longest message a sign may carry, in characters. */
export const MAX_SIGN_TEXT = 240;
/** The words on this prop, trimmed and bounded, or null for a sign with none. */
export function signText(prop: Prop): string | null;
```

**The reading.** A sign is *client-side entirely*: no entity, no wire message,
no claim on the server. `sim/`, `world/` and `player/` do not learn that signs
exist. That is not a shortcut — it is what a sign *is*. A conversation is
server-owned because it is a claim on a body that would otherwise wander off
(spec 246); a board nailed to a post is not going anywhere, holds nothing, and
sells nothing, so there is no state for the server to arbitrate and nothing for
a second player to be refused.

```ts
// render/iso3d/world/sign.ts — pure: no three.js, no DOM, no clock.
export interface SignMark { readonly key: string; readonly x: number; readonly y: number;
                            readonly text: string; readonly radius: number; readonly height: number }
export function signMarks(props: readonly Prop[]): readonly SignMark[];
export function pickSign(ray: THREE.Ray, marks: readonly SignMark[], ground: Vec2 | null): SignMark | null;
export function signSpeaker(mark: SignMark): DialogueSpeaker;
export const SIGN_READ_RADIUS: number;
```

`pickSign` is `hover.ts`'s two tests with the meshes left out — the upright
volume through the already-exported `rayBodyDistance`, then the ground
footprint. A sign's board stands well above the point it is filed at, and at
this camera's pitch the ground under a cursor aimed at the board is metres from
the post; the editor's marker tool records the same finding and the same fix.

`DialogueSession` is widened from `NpcDefinition` to the five fields it actually
reads (`DialogueSpeaker = { id, name, voice, vendorId, dialogue }`), which
`NpcDefinition` already satisfies structurally. A sign is a speaker with one
line, no replies, no vendor — and **a silent sink**, which is the whole of "no
sound": `SILENT_SPEECH` is a `DialogueSpeech` whose `speak` and `stop` do
nothing, so the reveal, the skip, the bubble and the camera are the NPC's
exactly and the voice is the one thing that is not.

**The order.** A left click on a sign arms `signId` beside `pickupId` and
`talkId`, and `driveSign` is `driveTalk`'s shape with the ask replaced by
opening the bubble locally — one order, one open, because the reach is this
client's own comparison and cannot be refused by anybody.

**The mark.** A fourth crosshair, `'sign'`, a question mark on the same
nine-by-nine grid as the other three, ranked above `overNpc` in `worldMark` for
clarity rather than precedence — a prop and a body can never both be under the
same answer.

**The message.** A `Message` row in the editor's Structures folder, shown for a
sign and hidden for every other kind, exactly as the two light rows are shown
for a fixture. `placeStructure` reads it the way it reads `structureYaw`.

## Invariants tested

- A prop with no `text` round-trips through `bakeMap`/`parseMap`/`encode`/
  `decode` byte- and value-identical to what it is today; `mapId` is unchanged
  by the field existing.
- A sign's text survives document → wire → document, including one at
  `MAX_SIGN_TEXT` and one holding quotes and newlines.
- `parseMap` refuses a non-string `text`, and refuses one over `MAX_SIGN_TEXT`.
- `signText` returns null for a blank, whitespace-only or absent message, and a
  trimmed, bounded string otherwise — so a sign with nothing on it is a sign
  nothing offers to read, at every layer.
- `pickSign` answers the sign whose board a ray enters, prefers the nearer of
  two, answers a sign whose footprint holds the ground cursor when no board is
  hit, and answers null over bare ground.
- `worldMark` answers `'sign'` over a sign, and an armed skill still outranks it.
- A `DialogueSession` built from `signSpeaker` reveals the text, ends on the
  confirm press (no replies), and emits **no** speech events at any point.
- `SILENT_SPEECH` is what the sign session is constructed with, asserted at the
  driver rather than by inspection.
- `placeStructure` writes `text` only for a sign, only when non-blank, and
  writes nothing extra for a hut, a well or a fixture.
- `visibleGroups`/the panel show the message row for a sign and hide it
  otherwise; `EditorSettings` still holds a real value in every field, per the
  test spec 250 added after seeding a slider `null` opened the editor black.
- A sign's collider is its post, and `SIGN_READ_RADIUS` clears it by more than
  a body radius — so the reach is reachable rather than inside the thing.
- The presentation-only assertion still holds: the same seed and inputs, once
  with a sign read and once without, produce identical authoritative state.

## Out of scope

- **Editing a placed sign.** Props have no identity in the document — a `Prop`
  is an anonymous record in a chunk's list — so "select this one and change its
  message" is not a panel row, it is prop ids in the map format, which is a
  spec of its own. Correcting a sign is erase-and-place, which is the deal every
  other prop's scale, facing and brightness already gets, plus the map file
  itself: `maps/arena.json` is committed and reviewed as a diff, and a sign's
  message is the one prop field a person can honestly edit there by hand.
- **Replies.** A sign says one thing. `DialogueScript` would express a branching
  one and there is nothing to branch on, so `signSpeaker` builds a single
  terminal line and the confirm press closes it.
- **A voice.** Deliberately silent, per the request. `SILENT_SPEECH` rather than
  a voice at zero volume, so nothing is scheduled that has to be stopped.
- **Server-side reading.** No `Talk`, no `Conversation`, no claim: two players
  read the same sign at the same time and neither is refused.
- **Text on the board.** The board is blank timber. Rendering the message in the
  world means a texture or a mesh font, and this client has zero image assets by
  design (`docs/ui/00-architecture.md`); the message is in the bubble.
