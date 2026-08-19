# 189 — A line you can say

## Problem

The chat protocol is finished at both ends and **nothing calls any of it.**

`0x07 Chat {str text}` goes up, is truncated to 240 characters, is refused while
muted, and has a rate-limit bucket of its own — `CHAT_BURST` 5 with
`CHAT_REFILL_PER_SECOND` 1, separate from the verb bucket since spec 151,
because *"a chat line costs every connection in the game one"*. `0x45 Chat
{u8 channel, str from, str text}` comes back down over three channels: `Say`,
`System` and `AdminBroadcast`. `GameClient.say(text)` encodes the first;
`GameClient.onChat(listener)` fans out the second.

Neither has a caller anywhere in the tree. A grep for `.say(` and `onChat`
across `src/render/`, `src/ui/` and `scripts/` returns nothing, so the
`chatListeners` array is empty for the life of every session. The server is
already talking into it: `server.ts` emits a `System` line on every death
(deliberately once per death rather than sixty times a second, which somebody
took the trouble to get right) and an `AdminBroadcast` for every admin message
the console sends. All of it is encoded, framed, sent, decoded, and handed to a
listener list with nothing in it.

So the game has a working multiplayer chat that no player can read and none can
type into. This spec is the client half, and only the client half: no wire
message changes, no server behaviour changes, nothing new is replicated.

## Shape

### What a log is (`src/render/iso3d/world/chat-log.ts`)

Pure, no DOM, no clock — the time is an argument, as it is everywhere under
`src/ui/`. This is the client state the mount owns: what has been said, what
*this* player has said, and how long ago the last line arrived.

```ts
export type ChatChannelId = 0 | 1 | 2;          // Say | System | AdminBroadcast

export interface ChatEntry {
  readonly id: number;                           // monotonic, for keying
  readonly channel: ChatChannelId;
  readonly from: string;                         // '' for System
  readonly text: string;
  readonly atMs: number;
}

export class ChatLog {
  append(channel: number, from: string, text: string, nowMs: number): void;
  readonly entries: readonly ChatEntry[];        // oldest first, capped
  /** Remember what was sent, for Up/Down. Deduped against the last entry. */
  remember(text: string): void;
  /** Walk the ring: -1 is older, +1 is newer. '' at the newest end. */
  recall(step: number): string;
  resetRecall(): void;
  get lastAtMs(): number;
}
```

`SCROLLBACK = 200` entries and `HISTORY = 20` sent lines. Both are ring caps:
the oldest falls off rather than the log growing for the life of a session.

### When it is on screen (`chat-log.ts`, beside the log)

```ts
export const QUIET_MS = 10_000;   // silence before it starts leaving
export const WIPE_MS = 260;       // how long leaving takes
/** 1 fully out, 0 fully gone. A fraction of the panel's height to draw. */
export function revealAt(lastAtMs: number, nowMs: number, open: boolean): number;
```

**It wipes rather than fades.** The two are not the same thing and this feature
needed both: the log *leaves* by wiping, and while it is there it sits on a
plate you can see through.

Leaving is a **clip**, the way a window arrives (spec 133), computed while
painting from the time it was handed. Paint-time, so it costs no layout, and
`animate` already answers reduce-motion centrally — for a player who asked for
less motion the log is simply there or not there. A fade-to-nothing would have
to blend against the world, and there is nothing to blend against: the UI canvas
is cleared to transparent, so the "background" a departing log would dissolve
into is not a colour anything here can name.

### The plate, and the one blend in the framework

`budget.test.ts` asserts every quad comes out at alpha 255 and every palette
colour is opaque, because a source-over blend is the one operation `raster.ts`
and a browser canvas round differently — `preview-ui-gallery.ts` caught exactly
that once, a cooldown scrim off by one in two channels.

The chat is the exception, and it is allowed to be because the exception is
**measured rather than waived**. It is the only surface drawn over the *world*,
and a solid rectangle in the corner of a game is a hole in it.

```ts
export const PLATE_TOKEN = 'panelSunken';
export const PLATE_ALPHA = 156;   // a byte, and a chosen one
```

A browser canvas stores premultiplied 8-bit and `getImageData` unpremultiplies
it, so a straight-alpha colour written over a transparent pixel comes back
rounded where `raster.ts` writes it through untouched. At 0.62 this plate came
back `rgb(27,24,39)` in Chromium against `rgb(28,25,39)` in the rasterizer —
which is what the browser script reported before the number was chosen.

But the round trip is lossy only for *some* alphas. For this colour, 156 is one
of the values where `round(round(c * a / 255) * 255 / a) === c` holds on every
channel, so the two backends agree byte for byte and the **exact** comparison
keeps working. A tolerance would have hidden every future blending mistake along
with this one; a chosen constant hides nothing. `budget.test.ts` asserts the
property, so a change to `panelSunken` or to the constant fails in `npm test`
rather than in a browser months later — and the fix if it does is a neighbouring
alpha, never a looser check.

One plate for the whole surface, drawn by the screen rather than by the scroller
and the field separately: two would overlap where they met and the seam would be
a third colour, which is what a translucent widget inside a translucent widget
always looks like. So the scroller and the field are drawn without their own
chrome — the field keeps its frame and focus ring, which are what say "you can
type here", and loses only its fill.

Everything else stays opaque, every glyph included. What is see-through is the
backing and nothing else, so the text is exactly as legible as it was.

### Nothing is drawn when nothing has been said

An empty plate over the world is a black bar announcing that the chat exists,
and the chat announcing itself is the opposite of furniture. So the log, its
lines and the plate under them are all hidden while there is nothing in them —
opening the chat before anybody has spoken shows the input line and nothing
above it.

The decision is taken *before* the "have the lines changed" early-out, because
an empty list is the one case that matches what is already shown: `sameLines` is
true from the first frame, so a visibility settled after it is a decision never
taken.

### The screen (`src/ui/screens/chat.ts`)

Docked bottom-left in the `hud` layer, above where the pool bars sit. Not a
`UiWindow`: it has no title bar, is not dragged, and is not in the layout store,
because it is always-on furniture rather than something the player opened.

```ts
export interface ChatLineView {
  readonly id: number;
  readonly channel: ChatChannelId;
  readonly from: string;
  readonly text: string;
}

export interface ChatView {
  readonly lines: readonly ChatLineView[];
  /** 0..1, from `revealAt`. The screen clips to it. */
  readonly reveal: number;
  readonly open: boolean;
}

export class ChatScreen extends Column {
  setView(view: ChatView): void;
  onSend: ((text: string) => void) | null;
  open(root: UiRoot): void;      // shows the field and takes focus
  close(root: UiRoot): void;
  get isOpen(): boolean;
  /** Up/Down while open. Returns whether it took the key. */
  recall(step: number): boolean;
}
```

The input row exists only while open. `TextField` already pushes `textEntry` on
focus and pops it on blur, which is what makes a typed `1` a one rather than a
cast — the context stack this widget was built to justify (spec 123), used for
the first time by something a player types into during a fight.

`maxLength` is **240**, matching the server's `text.slice(0, 240)` exactly, so
what the field will not let you type is what the server would have thrown away.

### Colour, out of the palette that exists

The palette is capped at nineteen by `theme.test.ts` and sits at exactly
nineteen. That cap is against *invented* colour, and a chat channel is not a new
thing in the world — it is three existing tones doing what they already mean:

| channel | name | body |
|---|---|---|
| `Say` (0) | `focus` | `text` |
| `System` (1) | — | `textDim` |
| `AdminBroadcast` (2) | — | `accent` |

`focus` is the pale blue a focus ring is drawn in and reads as "this one is
addressed to you"; `textDim` is what the interface already says its quieter
things in, which is what a death notice is; `accent` is the game's gold, spent
here on the one channel an operator sends by hand. No new palette entry, no cap
change.

### The key (`src/ui/input/bindings.json`)

One row: `ui.chat`, category `ui`, context **`gameplay`**, primary `Enter`.

`gameplay` rather than `ui`, because Enter has to reach the game to *open* the
chat; once it is open the field holds the keyboard and the map is not consulted
at all. Rebindable like everything else, and it is the first `ui` action whose
window is not a window.

### The mount (`ui-screens.ts`, `view.ts`)

`layers.place('hud', chat)` — the `hud` layer's first occupant in the Play tab,
which has been `interactive: true` since phase 5 for exactly this reason. It is
docked inside an `Anchor` whose bottom inset is the measured height of the HUD's
own furniture **plus** a margin: clearing something by nothing is still sitting
on it, and the gap is what makes the log read as its own thing rather than as
another row of the bottom band.
`view.ts` registers `client.onChat` into the log and points `chat.onSend` at
`client.say`.

Three rules the mount keeps:

**Enter opens, Enter sends, Escape closes.** A submit with nothing in it closes
rather than sending an empty line. Escape joins `escapeTaken`'s list — ahead of
closing a window, behind cancelling a drag — because the chat is the thing in
front of you when it is open.

**Up and Down are asked directly, not routed.** `TextField` swallows every key
it is given and answers `ArrowLeft`/`ArrowRight` itself, so a routed `ArrowUp`
would be eaten by the field and reach nothing. `UiScreens.handleKey` asks the
chat first, exactly as it already asks a keybinding capture in progress — the
one place that sees every key.

**The wheel is only taken while open.** The wheel is camera zoom in the Play
tab, so a log that took it whenever the cursor happened to be bottom-left would
break zoom in one corner of the screen and there would be nothing on screen to
explain why. Closed, the chat is `pointerTransparent` throughout.

There is **no local echo**: `broadcastMessage` sends to every connection with a
player on it, the sender included, so a line the player sends comes back through
the same path as everyone else's. Echoing locally would draw it twice.

## Invariants tested

- `append` caps at `SCROLLBACK`, dropping oldest first; ids stay monotonic.
- `remember` caps at `HISTORY`, and does not store a line identical to the one
  most recently remembered.
- `recall(-1)` walks back through what was sent, `recall(+1)` forward, and the
  newest end is `''` — so Down past the end clears the field rather than
  sticking on the last line.
- `revealAt` is 1 while open regardless of how long the silence has been; 1 for
  the whole of `QUIET_MS` after a line; 0 once `QUIET_MS + WIPE_MS` has passed;
  and monotonically non-increasing across that window.
- A line arriving while the log is wiping out puts it back to 1.
- `ChatScreen` maps each channel to the palette token in the table above, and a
  `Say` line draws its sender in a different colour from its body.
- The field refuses a 241st character.
- Opening pushes `textEntry` and closing pops it — asserted through the root's
  context stack, so a gameplay key does not reach the game while typing.
- Submitting a non-empty line calls `onSend` once with the text and clears the
  field; submitting an empty one calls `onSend` not at all and closes.
- The plate colour survives premultiplied 8-bit storage exactly at
  `PLATE_ALPHA`, on every channel — which is what lets the cross-backend
  comparison stay exact rather than gaining a tolerance.
- The plate is the *only* translucent thing the chat draws: every other command
  in the scene comes out at alpha 255.
- An empty log draws no plate and no scroller, from the very first frame.
- The mount is presentation only: `mount-presentation.test.ts` plays the same
  fight with the chat driven and without, and the authoritative state is
  identical.
- A golden image of the screen open, with one line per channel, through both
  backends.

## Out of scope

- **No protocol change.** No new message, no new field, no channel added. If
  something here wants the wire to change, it is the wrong shape.
- **No slash commands.** `/w`, `/party`, `/me` — the server has three channels
  and no notion of a whisper, so a client-side `/w` would be a promise the
  protocol cannot keep.
- **No channel filter tabs.** Three channels, colour-coded, one stream. Tabs are
  worth building when there is a channel worth muting.
- **No timestamps**, which would need a wall clock the deterministic core bans
  and the render layer has no reason to grow.
- **The refusal stack stays where it is.** `error-log.ts` keeps its own corner;
  a cooldown refusal is not conversation, and folding sixty-a-second refusals
  into a scrollback is how a chat log becomes unreadable during a fight.
- **No emote, no profanity filter, no mute list.** Muting is the server's, and
  it already refuses a muted player with `ErrorCode.Muted`.
