# 244 — a body that is not an enemy

## Problem

Every body in this world is something to kill. `MONSTERS` is the only table that
puts a body on the ground, `isHostile` says yes to every pair of it, and the four
temperaments in spec 163 are four ways of deciding *when* to fight rather than
whether. There is no way to stand next to something and talk to it.

The shop is the sharp end of that. Spec 129 built a whole vendor — stock, a
markup, a buyback, an affordability check, a screen — and then had nowhere to put
one, so it says so in as many words: *"there is no map yet that says where a town
is"*. Both vendors are therefore invisible coordinates near the spawn, and the
way you shop is to stand on one and press a key. A merchant you can see, walk up
to and speak with is the thing that table has been waiting for, and it needs
three things this game has none of: a body that will not fight you, a way to
address one, and something for it to say.

## Shape

### A fifth temperament

```ts
// data/monsters.ts
export type Temperament =
  | { readonly kind: 'skittish'; readonly fleeTicks: number }
  | { readonly kind: 'defensive' }
  | { readonly kind: 'territorial'; ... }
  | { readonly kind: 'ferocious'; ... }
  /** Never fights, and cannot be fought. */
  | { readonly kind: 'friendly' };
```

A union member rather than a flag beside one, for the reason the other four are:
**a row only names a number the behaviour it chose actually reads**, and this one
reads none. It is also the whole of the non-hostility — `isHostile` refuses a
friendly body at both ends, the way it already refuses a projectile, a mote and a
drop, so nothing swings at it, nothing aggros onto it, no blast catches it and it
never appears in `nearestQuarry`.

Everything else a body has, it keeps: it spawns from a `spawner` marker, wanders
through `sim/idle.ts`, moves through `resolveMovement`, replicates, streams and
is drawn like any other unit. **No new entity kind**, because a friendly NPC is a
body that walks and is looked at, and `Prop` is scenery that does neither.

### An NPC table

```ts
// data/npcs.ts, beside vendors.ts
export interface NpcDefinition {
  readonly id: string;          // the MONSTERS row it is
  readonly name: string;
  readonly talkRadius: number;  // how close you must be to start
  readonly voice: DialogueVoice;
  readonly vendorId: string | null;
  readonly dialogue: DialogueScript;
}
```

Keyed by monster type id, so a body and the thing it says are one row apart and
`npcById(entity.typeId)` is the only lookup anybody makes. The server reads
`talkRadius` and nothing else; the client reads the rest. One table rather than
two, because a name authored in two places is a name that disagrees with itself.

### A conversation is a claim on the body

```ts
// sim/types.ts
readonly conversationWith: number | null;   // on ServerEntity
```

Held on the NPC, naming the player. `monsterIntent` reads it *before*
`idleDecision`, and a body with a claim on it stands still and faces the player —
which is the pose that function already has for "stopped, facing you", so nothing
new steers.

Two wire messages, in the shape `OpenVendor`/`VendorState` already has:

```ts
ClientMessageType.Talk        // { entityId }  — 0 ends it
ServerMessageType.Conversation // { entityId } — 0 means "you are not talking"
```

The server refuses a `Talk` that names something that is not an NPC, is out of
`talkRadius`, is dead, or is already talking to somebody else. It **ends one
without being asked** when the player walks past the radius, when either body
dies or leaves the world, and when the connection drops — so no path leaves an
NPC frozen mid-conversation with nobody in front of it.

Nothing about the dialogue itself crosses the wire. What the NPC *says* is
content the client already has, and sending it would be replicating a table both
ends can read.

### The dialogue script

```ts
// data/dialogue.ts
export interface DialogueLine {
  readonly id: string;
  readonly text: string;
  readonly choices: readonly DialogueChoice[];   // empty ends the line on advance
}
export interface DialogueChoice {
  readonly text: string;
  readonly go: string | null;  // another line id, or null to close
  readonly opens?: 'shop';     // what pressing it does besides move
}
```

A map of lines and the choices out of them. Deliberately not a graph type, not a
condition language, and not a flag store: this is the smallest thing that
expresses *"a line, some replies, one of which opens the shop"*, and a second NPC
needs a second row rather than a framework.

### Reveal and voice

One controller owns both, which is what the handoff spec recommends and what
`src/ui/`'s own fence requires — a screen may not import `render/audio/`, so it
cannot be the thing scheduling sounds.

```ts
// render/iso3d/world/dialogue.ts — pure, time is an argument
class DialogueSession {
  constructor(npc: NpcDefinition, entityId: number, speech: DialogueSpeech, nowMs: number);
  update(nowMs: number): void;                 // reveal, and speak what asks to
  advance(nowMs: number): DialogueOutcome;     // skip the line, or move on
  choose(index: number, nowMs: number): DialogueOutcome;
  end(): DialogueOutcome;                      // idempotent; always stops the voice
  get view(): DialogueView;                    // what the bubble draws
}
```

Pure and driven by a clock it is handed, so the reveal is a function of elapsed
time rather than of frame rate, and a test asserts a rhythm without waiting for
one. The sound sink is injected for the same reason: driven against a recorder,
the whole feature runs in Node with no `AudioContext` anywhere.

There is a generation counter, as the handoff spec suggests, but it is not what
makes cancellation correct. **Nothing is ever scheduled ahead** — a voice starts
at the instant the reveal reaches its character — so at any moment there are no
pending sounds to cancel and skipping cannot produce a burst. That is a property
of the loop rather than a check inside it, and it is stronger than the token,
which is kept for the sounds that have already *started*.

`DialogueDriver` beside it is what joins a session to the four things it has to
be connected to: the server's authoritative answer about who is talking, the
audio, the bubble and the camera. `ClientView.conversationEntityId` is the whole
trigger, so every way a conversation can end arrives as one event.

```ts
// render/audio/dialogue-voice.ts — pure: which characters speak, at what pitch
// render/audio/dialogue-sound.ts — impure: the four synthesis engines
export type DialogueVoiceId = 'soft' | 'chirpy' | 'warm' | 'nasal';
export interface DialogueVoice {
  readonly voice: DialogueVoiceId;
  readonly speed?: number; readonly density?: number;
  readonly volume?: number; readonly pitchMultiplier?: number;
  readonly pitchVariation?: number; readonly questionLift?: number;
}
```

Split for the reason every other pure/impure pair here is split: *which* letter
speaks, at what pitch, after what delay is arithmetic and belongs in a test;
*making a noise* needs an `AudioContext`. The merchant is `soft`.

### The bubble

`src/ui/screens/dialogue.ts`, in the `hud` layer, docked to a **projected anchor
handed in per frame** — the mount knows where the speaker is on screen, the
screen does not and must not. Choices are `Button`s, so they take their own
clicks and nothing leaks into the world; the bubble itself is opaque to the
pointer for the same reason.

### The camera

A *temporary* framing pushed on top of the player follow, never a write into the
view controls: the focus eases toward the midpoint of the two bodies and the
half-width comes down, and closing the conversation eases both back. Both go
through the ease the camera has always used to follow a body, so "smoothly
reframes" and "smoothly restores" are one mechanism rather than two.

It may only ever pull the camera **in**. A framing that could push it out would
override a preference rather than decorate it: somebody playing zoomed right in
would have the game jump away from them the moment they said hello.

## Corrections

Three things this design got wrong, found by building it.

**A friendly body needs a client-side predicate too.** The spec above says the
non-hostility is one line in `isHostile`, and it is -- for the *server*. The
client independently decides what a right-click means, and `attackable` had no
way to know: clicking a merchant was a walk over and a swing that quietly never
landed. `isFriendlyMonster` lives in `data/monsters.ts` because three trees ask
it (the sim wraps it as `isFriendly`, `appearanceOf` withholds a health bar with
it, and a test picking something to fight has to skip one), and `talkable` is
the fourth reading of `world.order` beside pickup, attack and walk.

**A shop with a body in it must leave the proximity search.** Its reach is
derived from `talkRadius + wander radius + margin`, which is four times a
walk-up shop's -- so in `nearestVendorTo` it swallowed both older shops, and
pressing the shop key near the square opened a merchant's stock with no word
exchanged. `VendorDefinition.byProximity` is the fix and the better design: this
shop is reached by talking, which is what its reach was sized for.

*(Spec 245 deleted the flag along with the search it was hiding from. A field
whose only job is to keep one row out of a lookup is that lookup asking to be
removed, and the two older shops have bodies now.)*

**There is no `voice` bus.** One was written. `BUSES` is the *sound event*
vocabulary and `events.test.ts` asserts every bus appears in the SFX tab's tree
in mixer order, so a bus that can never hold a catalog event is an empty folder
and a slider with nothing behind it. The mumble rides `ui`, which is what the
out-of-scope note below already said it would; a Dialogue level is a follow-up
wanting a mixer that separates "a bus of events" from "a level".

## Invariants tested

- A friendly body is refused by `isHostile` in **both** directions, is never
  returned by `nearestQuarry`, is not provoked by a blow, and is not rallied by
  one landing beside it -- each with a control, since a rule that refused
  *everything* passes every one of those on its own.
- It draws no health bar, and everything that can be fought still does.
- The camera framing never pushes the camera further out than the player's own
  zoom, and clearing it restores exactly what the sliders say.
- A friendly body wanders inside its authored radius and comes home if dragged
  off, through the existing `idle.ts` — asserted off the real tick.
- A body with a conversation claim **does not move**, and faces the player.
- The claim is released by: an explicit end, the player leaving `talkRadius`,
  either body dying, either body leaving the world, and a disconnect. After
  release the body wanders again.
- A `Talk` naming a non-NPC, a dead body, an out-of-range body, or one already
  claimed by another player is refused, and refusing writes no claim.
- Two players cannot claim one NPC; repeated `Talk` from the holder is a no-op
  rather than a re-entry.
- The sim draws **nothing** from the `Rng` for any of it: an `Rng` state after a
  conversation equals the state after the same ticks with none.
- Reveal timing: punctuation lengthens the pause by the authored amounts, and a
  line's total is a pure function of its text and its speed.
- Sound density: no line speaks on every character; a word start speaks; the gap
  rule holds.
- A `?` inside the lookahead window lifts pitch, and the lift grows as the mark
  approaches.
- `skip()` reveals the whole line and emits **no** backlog of speak events.
- A generation bump makes every later scheduled sound a no-op — asserted by
  driving the controller against a recording sink with no `AudioContext` present.
- Closing the bubble, replacing the line, and ending the conversation each cancel
  playback; nothing speaks afterwards.
- The shop opened from a choice is the NPC's own vendor, not `nearestVendor`.
- Buying: an affordable purchase moves coins and goods together; an unaffordable
  one moves neither and says why. (Spec 129's own rules, asserted through this
  entry point.)
- Mounting the dialogue screen changes no authoritative state: the same seed and
  inputs, once with it driven and once without, produce identical server state.

## Out of scope

- **No authoring tools.** No node editor, no graph view, no inspector, no
  dialogue tab. A conversation is a row in a table.
- No conditions, flags, quest state, branching memory, or "seen this before".
- No dialogue for existing monsters, and no second NPC — the table takes one and
  the point is that it would take a second without new machinery.
- No selling, restocking, reputation, or vendor progression: spec 129 decided all
  of that and this changes none of it.
- No barks, no idle chatter, no overhead name plates.
- Nothing replicated about *what* is being said. Other players see a body
  standing still; they do not see the words.
- No accessibility toggle for dialogue sound yet — it rides the existing audio
  buses, and a dedicated switch is a row on the options page when somebody wants
  one.
