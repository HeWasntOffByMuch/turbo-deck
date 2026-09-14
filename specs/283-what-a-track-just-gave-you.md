# 283 — What a track just gave you

## Problem

Attributes start at 5 and the first node on every track is at 10. A fresh
character holds `SCALING.startingPoints` = 6 progression points, and five of them
reach that node — so **the first twelve mechanics in this game are unlocked
before the first level-up**, and nothing anywhere says one opened.

Three separate failures, and conflating them is why it reads as one:

1. **The unlock is silent.** `view.ts` plays `player.attributeUp` on the *press*,
   unconditionally, for every point — so 9→10, which opens two mechanics, sounds
   exactly like 5→6, which opens none. The purchase surfaces only on a sheet the
   player already has open.
2. **Three of the twelve have no tell at all.** `sim/blow.ts` computes
   `weakPoint` as a boolean separate from `critical`, with its own multiplier and
   its own resource return — and `CombatFlag` is
   `Killed | Critical | Blocked | Periodic`, so **a weak point never crosses the
   wire**. Perception's entire payoff is unobservable until the milestone at 20
   starts leaving an `Exposed` mark. Quick Recovery buys the tick a
   follow-through may be left on and that tick is drawn nowhere. (Committed
   Swing's tell is a stagger that did not happen; that one is out of scope, see
   below.)
3. **There is nowhere to practise.** `data/monsters.ts` has a `dummy` row —
   25,000 health, `sentinel`, `defensive`, no attack — with **no spawner on the
   shipped map**, a respec costs coins, and every other body fights back.

Two finished systems have been sitting with no content behind them the whole
time. Spec 260 built the sign — prop, `text`, crosshair, pick volume, bubble,
probe — and its own Problem section names *"a tutorial line"* as the first thing
it is for; there are **zero signs on the shipped map** (5,666 props, none of
them a board). And `LAYER_IDS` has carried `'notification'`
(`blocksBelow: false, interactive: false`) since spec 124 with **nothing ever
placed in it**.

## Shape

### 1. A weak point crosses the wire

```ts
export const CombatFlag = { Killed: 1<<0, Critical: 1<<1, Blocked: 1<<2,
                            Periodic: 1<<3, WeakPoint: 1<<4 } as const;
```

A fifth bit on a message that already has four, on spec 219's argument verbatim:
it was kept sim-side on the theory that a client draws a number the same way
whatever caused it, and **the client cannot work this one out** — a
`CombatResult` names an attacker and a target and no ability, and the weak-point
roll is not derivable from anything on the wire.

`hud.addDamage` takes the mark rather than a second boolean beside `crit`:

```ts
export type DamageMark = 'normal' | 'crit' | 'weakPoint' | 'heal';
addDamage(entityId: number, at: Vec3, damage: number, mark: DamageMark): void;
```

A weak point and a crit are **independent rolls** in `resolveBlow` and can both
land, so the mark is resolved once, in one place, rather than by two callers
each deciding. Weak point outranks crit: the weak point is what a Perception
build bought and the crit is what everybody has.

### 2. The cancel point is drawn on the cast bar

`castBar` gains one number, and it is the fraction the bar is already drawn in:

```ts
export interface CastBar {
  /** …existing fields…
   *  Where in the follow-through it may first be walked out of (spec 258),
   *  0..1 along this bar. Null in every phase that is not the backswing. */
  readonly cancelAt: number | null;
}
```

`castBar` takes the fraction rather than computing it: `backswingCancelPointOf`
lives in the sim and the bar is handed numbers. The local player's fraction comes
from `ClientView.selfCancelPoint`, published beside `selfCommitted` off the same
`heldByFollowThrough` arithmetic — so the mark and the rule that roots the legs
are one answer rather than two. **It is drawn on the local player's bar only**,
because it is the only body whose traits and Flow stacks this client holds.

### 3. A milestone describes itself

```ts
export function describeMilestone(milestone: MilestoneDefinition): TechnicalDescription;
```

The one hole in the Technical Description standard: eighteen milestones carry
hand-authored `effect` prose read straight off the table while every ability,
status and specialization is derived — against `mechanics-vocabulary.md`'s first
rule. `grantsOf` already turns a `StatModifier` into lines; the authored sentence
stays as the `flavor`, which is what it is.

### 4. The unlock notice

Client-side and **no wire change**: `ClientView.attributes` and
`ClientView.specializations` are already replicated on `Stats`, so a threshold
crossing is a diff of two readings in `xp-gain.ts`'s own register — the first
reading only baselines, and a move backwards re-baselines silently.

```ts
// render/iso3d/world/unlock-notice.ts — pure, time is an argument
export interface Unlock { readonly title: string; readonly lines: readonly TooltipLine[]; }
export class UnlockWatch { observe(view: ProgressionReading): readonly Unlock[]; }
```

Drawn by a new `UnlockScreen` in the `notification` layer, on `NOTICE_TIMINGS`'
rule (long enough to be read, nothing waiting on it). It fires on **an automatic
milestone, or a tier whose `grantsOf` returns a `whole` grant** — the three
capability rows at threshold 10 (Arcane Weaving, Opening Read, Conservation) and
nothing else. A numeric tier is silent, which is reward-philosophy §10's "not
every tier gets ceremony" rather than a shortcut, and `whole` is a *data* test
(`GRANT_LABELS` marks those fields `form: 'flag'`) rather than a judgement.

`player.unlock` is one row in `audio/events.ts`; `player.attributeUp` moves off
the press and onto the `Stats` diff, which is `player.levelUp`'s own shape.

Seen-state goes in `ui/input/display-store.ts` beside `controlsSeen`, as
`unlocksSeen: readonly string[]`, and **does not move `DISPLAY_VERSION`** — that
file's own docstring states the rule: a field whose absence reads honestly costs
no version bump, and "this profile predates the notice, so nothing has been
shown" is honest.

### 5. Content: a training yard, and somebody to ask

`scripts/place-training-yard.ts`, in the register of `place-npc.ts` and
`light-the-square.ts`: prints what it would do, `--write` does it, idempotent,
and **refuses** ground that is not there, ground past `MAX_WALK_SLOPE`, a spot
inside a prop, and a spot inside a shopkeeper's wander disc. It places dummies
and signs; the boards are written in the game's own controlled vocabulary
(`mechanics-vocabulary.md` §11) and no board states a number.

A trainer NPC is one `npcs.ts` row, one `shopkeeper()`-shaped row in
`monsters.ts` with no `vendorId`, one `dialogue.ts` script and one marker.
`DialogueChoice.opens` gains `'character'` beside `'shop'` so a trainer can open
the sheet.

## Invariants tested

- `CombatFlag.WeakPoint` rides a real blow, and a weak point and a crit landing
  together set both bits.
- `damageMarkOf` prefers weak point over crit, and heal over both.
- `castBar().cancelAt` is null in every phase but the backswing; in the backswing
  it equals the fraction handed in, clamped to 0..1; it is unchanged
  (still null) for a bar with no fraction, so every existing caller is untouched.
- `selfCancelPoint` agrees with `selfCommitted`: the tick `committed` goes false
  is the tick `progress` reaches `cancelAt`.
- `describeMilestone` emits the `whole` sentence for a capability grant, a line
  per numeric field, and never a `+0`; its flavor is the row's own `effect`.
- `UnlockWatch`: the first reading yields nothing; a threshold crossing yields
  one unlock; a numeric tier yields nothing; a capability tier yields one; a
  backwards move yields nothing and re-baselines; the same unlock is never
  yielded twice.
- The seen list round-trips through a `StorageLike` that throws, and a corrupt
  document costs defaults rather than a black screen.
- `place-training-yard.ts` is idempotent, and refuses each of its four cases.
- Every board on the shipped map is under `MAX_SIGN_TEXT`.
- Every dialogue script still passes `scriptProblems`.

## Out of scope

- **Committed Swing's tell.** Its evidence is a stagger that did not happen, and
  the honest fix is a picture for poise absorbed — a new combat event, not a bit
  on one that exists. Left with its measurement rather than guessed at.
- **A sparring body.** The dummy has no attack, so the yard cannot teach
  Committed Swing or Opening Read, both of which need something swinging at you.
  A low-damage `defensive` row is a content decision and is not made here.
- **Conditions in dialogue.** `DialogueScript` has no flags and no condition
  language, so the trainer offers a menu and cannot react to what you have built.
  Adding one would be the first stateful content in the tree and wants its own
  spec.
- **Reward-philosophy §8.** "Do not convert discovery into a popup" is about the
  emergent attribute interactions, which stay unnamed. A tier the player *bought*
  is a transaction, and confirming a transaction is not spoiling a discovery.
- Re-showing a notice once dismissed; the character sheet is the permanent
  answer, which is spec 256's own ruling for the controls card.
