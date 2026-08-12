# 143 — The chunk a blow took

## Problem

A floating health bar is a red fill over a dark track, written straight from
replicated health, so a hit is a width that is simply *different* on the next
frame. At 20Hz deltas and a fast weapon that is a bar which twitches shorter and
never says by how much — the one thing a player wants off an enemy's bar mid
fight is "how much did that land for", and the damage numbers answer it in
absolute terms while the bar, which is the thing being watched, answers not at
all.

The fix is the arcade one: the fill retreats immediately, and the ground it gave
up stays lit in white for a moment before it drains away. A burst of quick hits
must read as *one* chunk rather than a strobe, so the white is throttled — the
first blow of a burst opens a window, and every blow inside it grows the same
chunk instead of restarting the effect. Empty is black, so the three states of
the track (kept / just lost / gone) are three flat colours.

## Shape

`src/render/iso3d/world/health-bar.ts` — pure, no DOM, time is an argument:

```ts
export const FLASH_HOLD_MS = 375;   // the throttle window, and the hold
export const FLASH_DRAIN_MS = 220;  // how long the white takes to retreat

export interface BarFill {
  readonly health: number;  // 0..1, the red (or green) fill
  readonly ghost: number;   // 0..1, where the white ends; always >= health
}

export class HealthFlashes {
  read(id: number, health: number, maxHealth: number, nowMs: number): BarFill;
  retain(live: ReadonlySet<number>): void;
  get tracked(): number;
}
```

`hud.ts` owns the elements and nothing else, as it already does for the damage
numbers: the track becomes opaque black, the white sits under the fill as a
second absolutely-positioned band, and `nowMs` is the drawn tick converted at
`1000 / SERVER_TICK_RATE` — the same presentation clock the bars are already
placed by, rather than a second one read off `performance`.

## Invariants tested

- Undamaged, and long after a flash resolves, `ghost === health`.
- A hit puts `ghost` at the health *before* it, immediately, and holds it flat
  for the whole of `FLASH_HOLD_MS`.
- Hits inside an open window grow the same chunk and do **not** extend the hold:
  the chunk still resolves `FLASH_HOLD_MS` after the *first* blow of the burst.
- A hit landing mid-drain opens a new window from wherever the white had got to,
  so a chunk never jumps back up the bar.
- The drain is monotone and lands exactly on `health`, not past it.
- `ghost >= health` always, and both stay inside `0..1` — including across a
  heal, a `maxHealth` change, and overkill (`health < 0`).
- A heal that catches the white up closes the window rather than leaving a
  chunk pinned above the fill.
- `retain` drops every body not read, so a session that kills a thousand
  monsters holds a thousand tracks for no longer than they are on screen.
- The whole thing is a pure function of `(id, health, maxHealth, nowMs)`: the
  same call sequence replays to the same fills.

## Out of scope

- The player's own frame bar in the HUD, which is a different surface.
- Healing having a colour of its own (a green over-band). Damage is what a
  player reads a bar for mid fight; the same machinery would extend to it.
- Any change to what the bars are placed by, when they are shown, or the cast
  bar under them.
