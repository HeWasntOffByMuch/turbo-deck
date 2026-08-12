# 143 — A refusal that stacks in the corner

## Problem

Every refused cast — and in practice that means "on cooldown", pressed again and
again during a fight — is written into one shared line at the top centre of the
frame, in the browser's UI monospace, and cleared by a frame counter:

```ts
notices.textContent = noticeAge < 120 ? notice : '';
```

Four things are wrong with that, and they are separate things.

- **It is one line.** A second refusal overwrites the first. Press two skills
  that are both cooling and the first one's answer never existed.
- **It decays in frames, not in seconds.** 120 frames is two seconds at 60fps,
  five at 24 and five-sixths of one at 144. How long a warning stays on screen
  is currently a property of the machine it is read on.
- **It is in the wrong corner.** Top centre is where nothing else on this HUD
  lives, and during a fight it is the part of the frame a player is least
  looking at — the hotbar, the cooldown sweeps and the body being hit are all
  along the bottom.
- **It does not look like this game.** `ui-monospace` at 13px in salmon over a
  posterized, low-resolution world reads as a debug overlay that was left
  switched on. Spec 065 already made exactly this argument about damage numbers
  and answered it with the pixel font; the refusals never got the same
  treatment.

## Shape

The old system goes away entirely: the `notices` element, the `notice` /
`noticeAge` pair and `HudHandle.notice` are deleted rather than repositioned.

**`src/render/iso3d/world/error-log.ts`** — pure, no DOM, beside
`damage-popup.ts` and with the same division of labour: everything about
lifetime, coalescing, order and fade lives here where a test can reach it, and
`hud.ts` owns nothing but the elements.

```ts
export const MESSAGE_LIFE_MS = 3500;
export const MESSAGE_FADE_MS = 700;
export const MESSAGE_CAPACITY = 5;

export interface ErrorLine {
  readonly id: number;
  /** What to draw, the repeat count already folded in. */
  readonly text: string;
  readonly opacity: number;
}
export interface ErrorStep {
  /** Oldest first. The caller draws them down the column, so the newest is at the bottom. */
  readonly live: readonly ErrorLine[];
  /** Ids whose element the caller should now delete. Reported exactly once. */
  readonly expired: readonly number[];
}

export class ErrorLog {
  add(text: string): { readonly id: number; readonly expired: readonly number[] };
  step(nowMs: number): ErrorStep;
  get count(): number;
}

/** `SLASH: ON COOLDOWN` — the wording, in one place. */
export function castRefusalText(abilityName: string, reason: string): string;
```

**Time is an argument, and `add` does not take one.** A message is stamped with
the last time the log was *stepped* — which is the last frame, at most one frame
ago — because a refusal arrives on a network callback outside the frame loop and
the alternative is a second clock in a module that has no business owning one.
An entry added before the first ever step is stamped by that step, so a page
whose `requestAnimationFrame` timestamps start in the thousands does not open
with a message that is already expired.

**Repeats coalesce.** Auto-attack turns one held click into a refusal per tick
(the comment in `target.test.ts` records sixty a second), so an identical text
already on screen has its count bumped and its clock reset rather than pushing a
sixth line: `SLASH: ON COOLDOWN X7`. It keeps its place in the column, because a
line that jumped to the bottom every time it repeated would be the noisiest
thing on the screen.

**The stack is anchored at its bottom.** The container is
`position:absolute; bottom: …; right: …` with no height, so it grows *upward* as
children are appended: the newest message is the bottom line and every older one
is pushed toward the top. It sits directly above the window buttons, which is
the one thing already in that corner.

**Red, in the pixel font.** `pixelTextSvg` per line, which means the font needs
letters: spec 065 authored the digits, `+`, `-` and `!` and nothing else, so
`THROWING STAR: ON COOLDOWN` would have drawn twenty-six solid blocks. This adds
`A`–`Z`, `:` and `.` to the same 5x7 table. The face is a caps face and stays
one — `ErrorLog.add` uppercases, rather than the table growing a second case
that would double it for one screen's benefit.

`hud-layout.ts` gains `errorScale` and `errorGap`, for the same reason
everything else in it is there: whether the longest refusal this game can
produce still fits across a phone is a sum, and it should fail in Node.

## Invariants tested

- **Newest last.** `step` returns oldest first, so the caller appending in order
  puts the newest at the bottom; the order never depends on when something
  expired.
- **A few seconds, in seconds.** A message is gone after `MESSAGE_LIFE_MS`
  whatever the step cadence — stepped once per second, or four hundred times —
  and stepping the same log twice with the same timestamps gives the same
  answer.
- **It fades before it goes**, and opacity is monotonically non-increasing over
  a message's life.
- **A repeat coalesces**: same text while live means one line, a count and a
  reset clock, and no new id. A repeat arriving after the first has expired is a
  new line at the bottom.
- **A different message never coalesces**, and alternating two texts gives two
  lines rather than a flapping one.
- **Nothing grows without bound.** Past `MESSAGE_CAPACITY` the oldest is
  dropped, and every id ever handed out is reported expired exactly once, so no
  element is ever orphaned.
- **`add` before the first `step`** lives its full life from that first step,
  not from zero.
- **The wording covers every reason the server can send.** Every `reason` in
  `abilities.ts` and `world.ts` has a phrase; an unknown code becomes readable
  uppercase rather than `notEnoughResource`.
- **Everything drawn has a glyph**: for every ability in the table crossed with
  every refusal reason, the composed text uses no character the font falls back
  on.
- **The longest of those messages fits** across `PHONE_LANDSCAPE` at the compact
  scale, clear of both edges.
- **The font's new glyphs are distinct.** No two glyphs in the table draw the
  same pixels, which is the check that catches `O`/`0`, `I`/`1`, `S`/`5` and
  `Z`/`2` — and the numeric UI face derives from this table, so it inherits the
  letters without a second copy to keep in step.

## Out of scope

- **Anything but cast refusals.** The log takes a string, and the two callers
  that used `hud.notice` are the two that call `hud.error`. Trade refusals,
  equip refusals and disconnects have their own surfaces and stay there.
- **Wrapping.** One message is one line. The fit test is what keeps that
  honest; the day a message cannot fit, the wording changes.
- **Moving it into `src/ui/`.** The shipped HUD is the DOM one and swapping it
  is a redesign rather than a mount (spec 131), so this lands where the damage
  numbers already are.
- **Sound.** A refusal that clicks is a real idea and belongs with spec 133's
  sink, not with a stack of text.
