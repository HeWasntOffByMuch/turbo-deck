# Client-side "something happened" feedback systems — inventory (for: teaching newly-unlocked mechanics)

Scope: every existing system that can show a player a transient or standing
notice, surveyed as reuse candidates before building a new one. No tutorial/
onboarding/hint system exists except the one-shot controls card (§7). See
`.claude/notes/ui-framework-map.md` for the full `src/ui/` framework map this
note assumes.

## 1. Floating number trail — `src/render/iso3d/world/damage-popup.ts` + `xp-gain.ts`

Pure field (`DamagePopups` class, damage-popup.ts:167) of world-anchored,
camera-projected floating text. `hud.ts` (the real impure Play-tab mount,
`src/render/iso3d/world/hud.ts` — NOT the same file as the gallery-only
`src/ui/screens/hud.ts`) owns the DOM elements and the actual string content;
the pure module knows nothing about what string is drawn.

- **Text is arbitrary.** `DamagePopups.add(group, at, trail)` (damage-popup.ts:187)
  takes no string at all — the caller (hud.ts) builds a `pixelTextSvg(text, {...})`
  string itself. `addDamage` (hud.ts:2189) composes `text` as
  `(heal?'+':'') + Math.round(Math.abs(damage))`, but nothing stops a caller
  building any other short string through the same font — `error-log.ts`
  already draws full words/phrases ("ON COOLDOWN") through the same
  `pixel-font.ts` face (digits since spec 065, capitals since spec 143), so a
  short word ("UNLOCKED") is mechanically identical to a number here.
- **Two trails exist today**: `'damage'` (damage-popup.ts:91, cycles
  `NUMBER_LANES`) and `'xp'` (spec 184, rides *under* the blow's own lane,
  `XP_GAP`/`XP_STACK`/`XP_RISE`). A third trail is one union member plus a
  spawn-site color/scale choice — the field, lanes, capacity and expiry are
  already generic over `trail`.
- **Lanes**: `NUMBER_LANES` (damage-popup.ts:77) — 5 fixed screen-space offsets,
  cycled per `group` (the target's entity id) so 3 hits in quick succession fan
  out instead of stacking.
- **Colours** (hud.ts:2200-2204, chosen by caller, not the pure module): white
  `#f4f4f4` normal, gold `#ffdc78` crit, green `#8ce696` heal; XP number is
  purple `#a878e8`/`#200d36` outline (hud.ts:2234-2238).
- **Lifetimes**: `NUMBER_LIFE = 48` frames (damage-popup.ts:64, 0.8s @60fps),
  `XP_LIFE = NUMBER_LIFE + 30` (line 130, 1.3s). `CAPACITY = 40` total popups
  (line 143), oldest evicted first.
- **Anchor is a world point taken once**, re-projected every frame — not tied to
  an entity, so it survives the target despawning (damage-popup.ts:2-14).
- Caveat: this is a *combat* vocabulary (floats off a body that was just hit/
  rewarded). A "you just unlocked X" notice isn't anchored to a blow, so reusing
  this literally means picking a `WorldAnchor` (e.g. the player's own head) and
  a new `trail`, not "hijack an existing hit".

## 2. Refusal stack — `src/render/iso3d/world/error-log.ts` + `hud.ts`

Pure `ErrorLog` class (error-log.ts:62), a capped column of coalescing text
lines, currently used only for cast/attack refusals.

- **Arbitrary lines**: `ErrorLog.add(text: string)` (line 91) takes any string,
  uppercases it (font has one case), and is not restricted to refusal codes —
  `castRefusalText`/`REFUSAL_PHRASES` (lines 154-203) are a *convenience
  formatter* layered on top, not something the log itself requires. A generic
  "SKILL X UNLOCKED" line would go through `add()` unchanged.
- **Lifetime**: `MESSAGE_LIFE_MS = 3500`, tail `MESSAGE_FADE_MS = 700` (lines
  17-20).
- **Capacity**: `MESSAGE_CAPACITY = 5` (line 30), oldest evicted.
- **Coalescing**: an identical (already-normalized) string bumps a `count` and
  resets its clock instead of adding a new line, drawn as `TEXT X3` (lines
  97-101, 136). Repeats keep their position rather than jumping to the bottom.
- Drawn in hud.ts (2247-2260) via `pixelTextSvg`, `ERROR_RED` (#ff3b3b),
  bottom-pinned column so newest is at the bottom.
- Caveat: it exists conceptually as *refusals/warnings* (red ink, "something
  didn't happen"). Reusable mechanically for anything transient, but the tone
  (red, "error") is wrong for a positive "you can now do X" notice without at
  least a colour override — currently hardcoded to `ERROR_RED` in hud.ts, not
  parameterized per-line.

## 3. Status marks + corner readout

**`src/render/iso3d/world/status-marks.ts`** — pure, stateless function
`statusMarks(statuses, drawnTick)` (line 156) turns `WireStatus[]` into
`StatusMark[]` (name, icon, kind, stacks, ticksLeft, timer string or null for
indefinite). Drawn twice: as glyphs over a body's head (hud.ts) and as rows in
the corner panel (below). No push/notify — a body just *has* the mark for as
long as the sim says the status is live; nothing announces the transition.

**`src/ui/screens/selected-unit.ts`** (`SelectedUnitScreen`, line 160) — the
corner readout for **whatever body is currently clicked/selected** (not
necessarily the player). Docked HUD furniture, not a window. Up to
`MAX_STATUS_ROWS = 8` (line 106) pre-built rows, shown/hidden rather than
created per status. Each row: label (`Adapted x3`), remaining time string,
tone (`boon`→`focus` colour / `affliction`→`danger` colour, line 109-112),
dimmed (`textDim`) in its last `FADE_TICKS` (status-marks.ts:51, =8 ticks).
Nothing here is a *notice* — it's a live status readout, drawn only while
something is selected, and only for the 8 rows the wire can carry.

**`src/server/data/status-visuals.ts`** — the content table deciding which
sim-internal statuses are shown at all (`DEFINITIONS`, line 135). Rule (file
header, lines 11-17): **the wire carries conditions a player could point at,
not the sim's own internal bookkeeping timers** — a status with no row here
(`visualFor`/`visualByWire` return null) is invisible by construction, so
"teach a newly-unlocked mechanic" via a *status mark* only works for
mechanics that already grant a `StatusId` with a row in this table.
Each row optionally carries `effect?: string` (line 104) — **one or two
authored sentences of exactly what the condition does** ("Shortens your
backswing. Lost when you are Staggered."), required for every row *except*
the 7 afflictions and the aura fields, whose effect is derived instead
(`description.ts`'s `describeStatus`, line 1125, folds in
`afflictionLines`/`auraFieldLines` when `effect` is absent — "nothing
derivable may be authored").

**This `effect` sentence already reaches a player today**: hud.ts:2062-2064
sets the overhead status glyph's native `title` attribute to
`` `${mark.name}\n${technicalText(describeStatus(visual))}` `` — a
browser-tooltip explanation of the mechanic, keyed off the same table a
"just unlocked" notice would want to quote. This is the most direct existing
plumbing from "a mechanic's authored one-line description" to "a player can
read it," short of building a new screen.

## 4. Action-bar skill tooltip — `src/ui/screens/action-bar.ts`

`ActionBarScreen.tooltip` (line 139) is a `src/ui/widgets/tooltip.ts` `Tooltip`
instance, pointed via `pointerMoved` (line 249) at whichever slot the cursor
rests on. Content comes from `ActionSlotView.hint: readonly TooltipLine[]`
(line 77) — **composed outside `src/ui/` entirely** and handed over already
built; the mount derives it via `server/data/description.ts`'s
`describeAbility` (description.ts:194), which walks an `AbilityDefinition` into
`target`/`effect`/`scaling`/`cost`/`timing`/`note` toned lines
(`Tone` — see `src/ui/screens/tones.ts`).

- `TooltipLine = { text, colorToken?, spans? }` (tooltip.ts, per the framework
  note) — `spans` are same-line coloured runs (e.g. the S/D/- scaling
  notation), never wrapped; plain lines wrap per-line at `MAX_WIDTH = 140`.
- Tones map through `src/ui/screens/tones.ts` to theme colour tokens — shared
  by the bag and the shop so "is this a drawback" reads the same colour
  everywhere an item/ability is described (spec 269's stated reason for
  extracting `tones.ts`).
- This is the richest "explain a mechanic" surface that already exists and is
  driven by the exact same technical-description vocabulary
  (`docs/mechanics-vocabulary.md`) a new-mechanic notice would want to quote
  from — but it is *on-hover*, not a *push* notice; nothing currently makes a
  tooltip appear unprompted.
- Also worth knowing: `SkillSlot.refund` (`src/ui/widgets/skill-slot.ts:112`,
  spec 254) is a `{ label, startedMs }` pair that floats a short string
  straight up off a hotbar slot over `MOTION.refund` (800ms, linear, `drift()`
  motion helper — `src/ui/core/motion.ts:217`), used today for "a cooldown
  reduction just landed here." It is UI-canvas (not world-space) and its label
  is drawn in the `numeric` font (digits + `+-!` only, per the framework note),
  so today it can't spell a word — but it is a second, independent precedent
  for "a short label drifts off a specific slot to mark an event," entirely
  inside `src/ui/` and not tied to combat.

## 5. `src/ui/core/` facilities

- **Tooltip widget**: yes — `widgets/tooltip.ts`, `Tooltip` (`tooltip.ts:97`,
  see framework note §3). Delay-gated (`theme.input.tooltipDelayMs`), flips to
  stay on-screen, `MAX_WIDTH=140`, `CURSOR_GAP=8`. Used by the bag, the shop,
  the action bar.
- **Toast**: no widget of that name or shape exists. `core/layers.ts:20` *does*
  declare a `'notification'` layer id in `LAYER_IDS` (also `layers.ts:55`,
  `{ blocksBelow: false, interactive: false }`) — an empty, wired-nowhere
  socket in the same register as this repo's other "declared but nothing
  placed here yet" findings (grep confirms no `layers.place('notification', …)`
  call anywhere). This is the natural slot for a toast/notice screen if one is
  built as a `src/ui/` widget.
- **Animation/tween**: yes — `core/motion.ts`. `Tween`/`ease`/`tweenTo`/
  `valueAt`/`animate`/`drift`, all pure functions of a `nowMs` argument (no
  running animator, no per-frame state — see file header, motion.ts:1-26).
  `animate()` snaps to the end value under `reduced` motion; `drift()` (for
  things with no resting state, e.g. a floating label) holds its *start*
  instead. `MOTION` (line 176) is the one place per-widget timings/easings
  live: `window` (120ms), `modal` (90ms), `meter` (180ms), `refund` (800ms,
  linear) — `RESPONSE_TIMINGS` vs `NOTICE_TIMINGS` (lines 234-240) already
  distinguishes "the interface answering something" from "a notice nothing
  waits on," which is exactly the category a mechanic-unlock notice falls in.
- **Sound sink**: yes — `core/sound.ts`. Closed `UiSoundId` union (8 members:
  `ui.press/open/close/error/drop/pickUp/coin/equip`), a widget emits an id
  into an injected `SoundSink`; `SILENT` no-op default, `RecordingSink` for
  tests. Adding a 9th id ("ui.unlock"?) is one union member plus a mapping in
  whatever `src/render/audio/` catalog wires it (per CLAUDE.md's audio section,
  `events.ts` is the closed vocabulary of *moments*, `sfx.json` the file
  assignment).

### `src/ui/widgets/` — one line each

- `Panel` — a drawing `Linear` container/background; base for custom screens.
- `Label` — text, optional wrap, `colorToken`.
- `Button`/`Icon`/`Separator` — press target, bare icon, row/column rule.
- `Checkbox` — boolean toggle with label.
- `Slider` — press-anywhere-on-track + drag numeric input.
- `TextField` — the one focusable-on-press widget; masking, placeholder.
- `ScrollView` — scrollable single-child container.
- `Tab`/`TabStrip`/`TabPanel` — lazily-built, kept tab bodies.
- `ItemSlot` — bag/shop cell; drag/drop, `acceptsSlot`.
- `DragGhost` — the thing that follows the cursor mid-drag.
- `Meter` — a fill fraction + caption; `setValueAnimated` chases via a tween.
- `SkillSlot` — hotbar cell: cooldown wedge, badge, highlight, swap/refund overlays.
- `Window`/`Dialog`/`Tooltip` — chrome-bearing popups (window = draggable/
  resizable; Dialog = modal confirm; Tooltip = hover text).

## 6. NPC/sign dialogue bubble

**`src/server/data/dialogue.ts`** — pure content table. `DialogueScript =
{ start, lines }`, `DialogueLine = { id, text, choices }`, `DialogueChoice =
{ text, go: string|null, opens?: 'shop' }`. No graph/condition language, no
flags, no "seen before" state (file header, lines 15-20) — a line just names
the ids its replies go to. `go: null` or empty `choices` ends the conversation.

**`src/render/iso3d/world/dialogue.ts`** — pure `DialogueSession` (line 111):
owns reveal-by-character timing (`update(nowMs)`), the two-stage confirm
(`advance` reveals-the-rest-then-ends, `choose` picks a reply), and speech
triggering through an injected `DialogueSpeech` sink. Needs only a
`DialogueSpeaker` (line 68): `{ id, name, voice, vendorId: string|null,
dialogue: DialogueScript }` — **not** an NPC-specific type; `vendorId` is the
only NPC-flavoured field and it's nullable.

**How hard to trigger from something other than an NPC or a sign**: already
proven cheap — spec 260's sign is exactly this generalisation done once.
`world/sign.ts:309` `signSpeaker(mark)` builds a synthetic `DialogueSpeaker`
inline (`id: 'sign:<key>'`, a one-line script, `vendorId: null`) and feeds it
through the **same** `DialogueSession`/`DialogueScreen`/camera-lean plumbing
with zero special-casing downstream. The two things a sign's caller supplies
that an NPC's doesn't: (a) `entityId: 0` — `DialogueSession`'s constructor
already accepts `0` for "not a body" (dialogue.ts:124-126); the `end()`/close
condition then has to be *driven by the caller* rather than by the server's
`conversationEntityId` (which is what `DialogueDriver.readSign`/`update`, in
`dialogue-driver.ts:229-286`, exist to do: a sign starts a session on this
client's own say-so and ends it by the client's own range check, spec 260's
"the server decides whether a conversation exists" rule is explicitly *not*
what a sign follows). (b) a `DialogueSpeech` sink — `SILENT_SPEECH`
(sign.ts:346) is a two-method do-nothing implementation, so "no voice" costs
nothing.
For a **pure client-side, no-server-claim notice** (which a "mechanic
unlocked" event almost certainly is — nobody else needs to be refused it),
the sign path is the template to copy, and it's *simpler* than the sign case:
no need for `SignIndex`/proximity/pick-volume machinery at all, since there's
no "where in the world is this" question — the trigger is a client-observed
fact (a level-up, a new specialization tier bought) rather than a look/click
at a prop. It would need: a synthetic `DialogueSpeaker` (or a narrower type,
since `vendorId`/`voice` aren't wanted), a way to *start* one (call
`DialogueDriver` with something other than `readSign`, or a sibling driver),
and a decision about *where* the bubble anchors (`DialogueFocus.entityId=0`
already supports a non-body anchor — currently always a fixed world point;
anchoring at the player's own head is one more `DialogueFocus` case).

**`src/ui/screens/dialogue.ts`** (`DialogueScreen`, line 74) — the bubble
widget itself: fixed `BUBBLE_WIDTH=260`, speaker/body/replies, opaque to hit
tests (deliberately, unlike selected-unit/chat), replies rebuilt only when the
list changes, hides completely when nobody is speaking. Reusable as-is for any
`DialogueView` (speaker, text, typing, choices) regardless of what produced it.

## 7. Tutorial / onboarding / first-time-experience: one exists, nothing else does

Searched: `tutorial`, `onboarding`, `walkthrough`, `coachmark`, `toast`,
`banner`, `first.time`/`FTUE`, `newlyUnlocked`/`justUnlocked`/
`milestoneReached`/`unlockedAt`/`specializationUnlocked`, `quest`/
`achievement`/`objective` (the last three are noise — only match as substrings
of `request`/`requested`, no real hits) across `src/` and `specs/`.

**Found: the controls card (spec 255, revised spec 256)** —
`src/ui/screens/controls.ts` (`ControlsScreen`, line 350). A **one-shot,
dismissible, content-derived onboarding panel**: shown once, the first time
the player presses Start from the title screen
(`src/render/iso3d/world/view.ts:2439-2458`), never again unless "DON'T SHOW
AGAIN" is left unchecked. This is the only first-time-experience mechanism in
the repo, and its shape is directly relevant prior art:
- **Rows are derived from the live `InputMap`**, never authored fixed text —
  `controlHints(map)` (controls.ts:157) walks a fixed list of `FEATURED_ROWS`
  (action ids + a short label, e.g. `{ actionIds: ['combat.stop'], label:
  'Stop' }`, lines 112-121) and drops any row whose action has no bound chord
  rather than drawing a blank cap. A "you unlocked X, press Y" notice wants
  exactly this pattern: name the action id(s), derive the current binding.
- **Persistence**: `controlsSeen: boolean` in `display-store.ts` (line 104,
  `DISPLAY_VERSION` unchanged — an absent field means "never seen," costing no
  version bump, display-store.ts:66-72). `loadControlsSeen`/`saveControlsSeen`
  (imported in view.ts:171/177) are the read/write pair; a per-mechanic "have
  they seen the note for skill X" would need its own keyed store (this one is
  a single boolean, not a set), but the same versioned-`StorageLike` document
  pattern applies directly.
- **Dismissal is two separate signals** (spec 256): `onDismiss` (closes for
  this session only) vs `onRemember(checked)` (persists "never again") —
  the screen has no storage itself; the mount decides what each means
  (view.ts:2478-2486).
- Drawn over the world, translucent plate reusing `chat.ts`'s
  `PLATE_TOKEN`/`PLATE_ALPHA` (the framework's only blend, proven to round-trip
  losslessly — see `chat.ts` and the framework note §2), opaque close button
  and checkbox on top.
- **Out of scope per spec 255**: re-opening once dismissed (the keybindings
  window is the stated "permanent answer to the same question" instead).

No other candidate exists: no quest log, no achievement popup, no "new item"
banner, no separate hint/coachmark system, no per-mechanic seen-state. The
`connection-banner.ts` (`src/render/iso3d/world/connection-banner.ts`) is a
plain DOM status line for socket connectivity only (connected/reconnecting/
failed) — unrelated to content, not a reusable notice surface for mechanics.
