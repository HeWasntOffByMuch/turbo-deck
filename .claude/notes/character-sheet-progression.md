# Character sheet: progression half (spec 128, 244)

Traced for: what the sheet displays about attributes/milestones/specializations,
how a purchase round-trips, whether any "you unlocked X" notification exists
anywhere in the client, what `data/description.ts` can describe, and what the
chat log accepts / who can push a line. Kept because the next session asking
"can we add an unlock toast" should start here instead of re-deriving it.

## 1. Display: what text a player actually reads

**Six track rows** (`src/ui/screens/character.ts:183-271` `TrackRow`), one per
attribute, always visible:
- Selector label: `` `[${abbrev}]` `` when selected else `` ` ${abbrev} ` `` (`character.ts:217`).
- Value column, fixed-width 7 (`VALUE_WIDTH`, `character.ts:166`): `${allocated}`
  or `${allocated} (${total})` when a grant differs from spend (`character.ts:226-230`).
- Progress meter toward the *next threshold only* (not the hard cap), no caption
  drawn on it (`character.ts:242-248`).
- Tooltip (`character.ts:253-270`): `${name} ${total}`, then the track's fixed
  `description` (`${verb}. ${sentenceCase(owns.join(', '))}.` -- built in
  `character-model.ts:451`), then if not maxed: `${toNext} more: ${nextEffect}`,
  then if tiers bought: `${tiersBought} point(s) in specializations`, then if
  blocked: the server's own refusal string.

**One line under the six rows**, `nextChangeLine` (`character.ts:759-767`):
picks the *single nearest* threshold across all six tracks and prints
`` `${toNext} more ${abbrev}: ${nextEffect}` ``. Empty string (and hidden) once
every track is capped.

**Detail panel for the selected track** (`character.ts:532-580` `buildDetail`):
- Heading: `${track.name} ${track.total}`.
- `Next milestone: ${nextThreshold} ${abbrev}, ${toNext} point(s) away`, or
  `'Every milestone on this track is reached'` (`character.ts:539-543`).
- Per node: a heading line, either `` `${threshold} ${abbrev}` `` (no milestone)
  or `` `${threshold} ${abbrev} -- ${milestone.name}` ``, accent-coloured once
  `reached` (`character.ts:550-557`). If the node carries a milestone, a second
  dim line with `milestone.effect` verbatim -- this is **authored prose straight
  out of `data/milestones.ts`**, e.g. `'Your blows carry 25% more poise damage,
  and a break you cause interrupts whatever it was doing.'`
  (`src/server/data/milestones.ts:64`), never touched by `description.ts`.
- Per specialization under that node: a `SpecializationRow` (`character.ts:297-360`)
  showing name, tier pips `tierPips()` = `` `[${'#'.repeat(held)}${'-'.repeat(max-held)}]` ``
  (`character.ts:168-171`), and a "+" button. Its tooltip is
  `specializationTooltip()` (`character-model.ts:356-363`) = `describeSpecialization`
  output split on `\n`, plus `` `Next tier: ${tier+1} of ${maxTier}, ${cost} point(s)` ``,
  plus a refusal line if blocked.
- A Respec button: `` `Respec (${cost}c)` ``.

**Stats tab** (separate `TabPanel` entry, `character.ts:711`): ~20 rows from
`STAT_ROWS` in `character-model.ts:197-332`, each `` `${label}  ${value}` `` with
a one-sentence hint on hover, e.g. `'Guard'`, `'Wind-up'`, `'Break off'`.

Nothing about a milestone or specialization is announced anywhere else on the
sheet or off it -- see part 3.

## 2. Purchase flow

Button -> `TrackRow.advanceButton` / `SpecializationRow.spendButton`
(`character.ts:203-204`, `314-315`) -> `CharacterScreen.onAdvance`/`onSpend`
callbacks, wired in `ui-screens.ts:597-605` to `options.onAdvance`/`onSpend`,
wired again in `view.ts:2254-2262`:

```
onSpend: (specializationId) => {
  audioDriver.flat('player.skillUp');
  client.spendOnSpecialization(specializationId);
},
onAdvance: (key) => {
  audioDriver.flat('player.attributeUp');
  client.spendOnAttribute(key as BaseStatKey);
},
onRespec: () => client.respecProgression(),
```

The sound cue fires **unconditionally on press**, before any server answer --
it is not gated on success (though the button is only enabled when
`canSpend`/`canAdvance` was already true, so a refusal here is rare/racy).

`GameClient.spendOnAttribute`/`spendOnSpecialization`
(`src/server/client/game-client.ts:1417-1444`) both send one wire message,
`ClientMessageType.SpendProgressionPoint` (`0x06`, `protocol.ts:32`), with a
`target: ProgressionTarget.Attribute | Specialization` discriminant -- "one
message for one economy" (spec 244), replacing the old two-currency
`SpendSkillPoint`/`AllocateAttribute`. `respecProgression()` sends
`RespecProgression` with no payload (`game-client.ts:1446-1447`).

Server handling, `server.ts:1092-1118`:
```
case ClientMessageType.SpendProgressionPoint: {
  ... result = await this.players.allocateAttribute(...) 
        or await this.players.buySpecializationTier(...)
  this.reportAction(connection, result.ok ? null : (result.reason ?? 'refused'));
}
case ClientMessageType.RespecProgression: {
  ... result = await this.players.respec(...)
  this.reportAction(...); if (result.ok) this.sendInventory(connection, 0);
}
```
`PlayerManager.allocateAttribute`/`buySpecializationTier`/`respec`
(`src/server/player/player-manager.ts:799-846`) validate, `commit()` the new
record, then `recalculate()`.

**What comes back** -- `reportAction` (`server.ts:1793-1805`):
- Refused: `{ type: ServerMessageType.Error, code: ErrorCode.RejectedAction,
  message: rejection }`.
- Accepted: `this.sendStats(connection)` (a fresh, full `Stats` message --
  level, experience, specializations, baseStats, attributes,
  unspentProgressionPoints, stats) plus `syncEntityStats()` onto the sim entity.

Client stores the new `Stats` fields as plain fields with **no diffing**
(`game-client.ts:2535-2542`: `this.stats = ...`, `this.specializations = ...`,
etc.). The sheet is only rebuilt while it is the open window, gated by an
equality check: `ui-screens.ts:1064-1077`
`if (this.isOpen('character') && view.stats && this.characterChanged(view))`.
Closed, nothing about the change is surfaced anywhere until it is reopened.

## 3. Existing "you unlocked X" notification: there is none

Searched broadly (toast/banner/announce/notification/level-up/unlocked) across
`src/ui` and `src/render`. Findings:
- `connection-banner.ts` -- socket phase only (connecting/connected/closed),
  unrelated.
- `error-log.ts` (via `hud.error(...)`) -- the only "surfaces a line over the
  world" mechanism reachable from progression, and it is **refusal-only**:
  `view.ts:1937-1940` `client.onError((_code, message) => { if (message.length
  > 0) hud.error(message); ... })`. A rejected spend/respec is the one
  progression event with any on-screen presentation outside the sheet itself,
  and it says why it *failed*, never that something succeeded.
- `xp-gain.ts` / `xp-bar.ts` -- floating `+N XP` and the strip; about
  experience/kills, not about milestones or tiers.
- No `describeMilestone`, no "toast" widget, no achievement/unlock banner
  system anywhere in `src/ui/` or `src/render/`.
- The one *existing* precedent for a progression change being announced as text
  is server-authored and admin-only: `PlayerManager.setProgress` (invoked from
  the admin console) sends `ChatChannel.System`: `` `An admin changed your
  progression: ${result.detail}.` `` (`server.ts:3538-3548`). A normal player's
  own purchase never goes through this path.

So: a purchase changes the sheet's numbers (if open) and nothing else. A
milestone crossed as a side effect of an attribute purchase gets no callout at
all beyond the sheet's own accent-coloured "reached" heading next time it's
viewed.

## 4. `src/server/data/description.ts` -- what it can generate

Exported functions:
- `formatSeconds(ticks): string` (`:156`) -- ticks to `"1.5s"`.
- `describeAbility(ability: AbilityDefinition): TechnicalDescription` (`:194`)
  -- full Technical Description for one ability row (target/effect/cost/timing/
  note lines + `flavor`).
- `GRANT_LABELS: readonly GrantLabel[]` (`:662`) -- ordered table of every
  `StatModifier` field with its display name/form; the alphabet `grantsOf`
  walks.
- `grantsOf(modifier: StatModifier, times = 1): readonly Grant[]` (`:913`) --
  one line per non-zero field a modifier grants, e.g. `"+18% Guard damage."`.
- `describeSpecialization(skill: SpecializationDefinition, level = 0):
  TechnicalDescription` (`:954`) -- Requires/Trigger + per-tier grant lines via
  `grantsOf`; this is what a specialization tooltip on the sheet uses
  (`character-model.ts:360`).
- `describeStatus(visual: StatusVisual): TechnicalDescription` (`:1125`) --
  affliction/field/status lines (stacking, refresh/indefinite, beneficial vs
  harmful).
- `technicalText(described: TechnicalDescription): string` (`:1165`) -- lines
  joined `\n`, flavor excluded.

**No `describeMilestone`.** `MilestoneDefinition` (`src/server/data/milestones.ts:31-45`)
carries its own authored `name` and `effect` string directly ("What
mechanically changes, in the words the sheet shows") -- `character-model.ts`
reads `node.milestone.name`/`.effect` straight off the table
(`character-model.ts:404-407`) with no pass through `description.ts` at all.
Only *specializations* (tiered mechanics) are derived/composed; milestones are
plain authored prose already written for display, abilities/items/statuses are
derived, but there is no writer for a milestone-crossing event or for "you
reached N Strength" as a standalone sentence -- the sheet's own
`` `${threshold} ${abbrev} -- ${name}` `` heading is composed in
`character.ts:550-557`, not in `description.ts`.

## 5. Chat log: channels, who can push, server call sites

`ChatChannelId` = `0 | 1 | 2` = Say / System / AdminBroadcast
(`src/ui/screens/chat.ts:44`, mirrored from `ChatChannel` in
`src/server/net/protocol.ts:657-661`). Colour per channel
(`CHANNEL_TOKENS`, `chat.ts:58-62`): Say -> `text`, System -> `textDim`,
AdminBroadcast -> `accent`.

Client plumbing: `GameClient.onChat(listener)` fires on every
`ServerMessageType.Chat` frame (`game-client.ts:1910-1912`, dispatch at
`:2598-2600`) with the raw `{channel, from, text}`. `view.ts:2508-2510`:
`client.onChat((message) => ui.pushChat(message.channel, message.from,
message.text))` -> `ChatLog.append(channel, from, text, nowMs)`
(`chat-log.ts:135-148`), capped at `SCROLLBACK = 200` lines
(`chat-log.ts:34`). `ChatScreen.setView` (`chat.ts:352-398`) is the only
renderer of it; a player's own outgoing line goes through
`GameClient.say(text)` (`game-client.ts:1902`) -> `ClientMessageType.Chat`
(`0x07`) -> server re-broadcasts as `channel: ChatChannel.Say` to everyone
(`server.ts:1151-1163`, muted players refused with an `Error`/`Muted`).

Every server-side line-producing call site (`grep broadcastMessage`/`this.send`
with `ChatChannel.System`/`AdminBroadcast`, non-test):
- `server.ts:1163` -- player `Chat` (Say) re-broadcast to everyone.
- `server.ts:3134` (`announceDeaths`) -- System, to the one player, once per
  death: `'You have fallen. Respawn when you are ready.'`.
- `server.ts:3544` (`setProgress`, admin console) -- System, to the one
  player: `` `An admin changed your progression: ${result.detail}.` ``.
- `server.ts:3562` (`giveItem`, admin console) -- System, to the one player:
  `` `You have been given ${count} x ${defId}.` ``.
- `server.ts:3739` (`triggerEvent('raid', ...)`, admin/dev path) -- System,
  broadcast to everyone: `` `A raid of ${spawned} descends near X, Y.` ``.
- `server.ts:4065` (`broadcast(text)`, admin console "say to everyone") --
  AdminBroadcast, to everyone, operator's own text.

So the server *does* push System lines today, but only for death, and for
three admin-console-triggered actions (progress edit, item grant, raid) --
never for an ordinary player's own attribute/specialization purchase. That is
the readiest existing rail if a "you unlocked X" line were to be added: send
`{type: ServerMessageType.Chat, channel: ChatChannel.System, from: 'World',
text: ...}` from inside the `SpendProgressionPoint` handler (or from
`reportAction`) the same way `setProgress` already does, and/or add a
`describeMilestone`-shaped writer beside `describeSpecialization` in
`description.ts` to generate the sentence from the table rather than hand
authoring it a second time.
