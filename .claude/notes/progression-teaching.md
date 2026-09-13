# Teaching the earliest attribute-track mechanics

An audit of what a player unlocks first, what they can currently *see* of it, and
the surfaces already in the tree that could explain it. Written 2026-09-13.
Companion inventories: `.claude/notes/character-sheet-progression.md` (the sheet
and the purchase flow) and `.claude/notes/feedback-systems-inventory.md` (every
client surface that can show a player something happened).

## 1. Where the earliest mechanics are

`SCALING.startingAttribute` is 5 and the hard cap is 60. Nodes sit at
**10 / 20 / 25 / 35 / 40 / 50** — `SPECIALIZATION_THRESHOLDS` 10/25/40 and
`MILESTONE_THRESHOLDS` 20/35/50, plus Constitution's three mastery rows at 50.

A level-1 character holds `SCALING.startingPoints` = **6** progression points,
and `pointsPerLevel` = 4 after that. Five points takes one attribute from 5 to
10. So six points is exactly *reach the first node and buy one tier* — **the
first unlock is reachable before the first level-up**, and nothing in the game
mentions it.

## 2. The twelve earliest mechanics

Two specializations per attribute at `requires: 10`, three tiers each.

| Attribute | Row | Trigger | What a tier is |
|---|---|---|---|
| STR | Crushing Blows | every blow | +18% Guard damage |
| STR | Committed Swing | while winding up | +8% wind-up poise armour |
| AGI | Quick Recovery | passive | −5% of the follow-through before you may leave it |
| AGI | Mobile Offense | on cancelling a follow-through | cooldown off every waiting ability |
| INT | Arcane Weaving | cast a different ability than the last | **grants Weave** + 9% affliction strength |
| INT | Spell Shaping | ground/projectile abilities | +8% radius, +5% range, +10% cost premium |
| CON | Deep Reserves | passive | +25 health, +8 Guard |
| CON | Steady Frame | always, most while holding ground | +40% Guard regen, +5% of it while moving |
| PER | Weak-Point Study | every blow | +4% weak-point chance |
| PER | Opening Read | an enemy committing an attack | **grants Opening Read** → Vulnerable |
| WIS | Conservation | an ability that connects | **grants Attuned** |
| WIS | Measured Recovery | receiving healing | +12% healing |

**Three of the twelve turn a capability on rather than moving a number**, and
that is derivable from data rather than a judgement: `GRANT_LABELS` marks those
fields `form: 'flag'`, so `grantsOf(row.perTier)` returns a `Grant` with
`whole === true` carrying the whole second-person sentence. That flag is the
right test for "this purchase needs explaining".

## 3. What a player can see of each, today

| Row | Tell | Verdict |
|---|---|---|
| Mobile Offense | `-1.2` floats off the slot (spec 254, `cooldown-marks.ts`) | **good** |
| Arcane Weaving | Weave glyph in the self-status row + hover description | **good** |
| Opening Read | Vulnerable mark over the enemy | **good** |
| Conservation | Attuned glyph in the self-status row | **good** |
| Spell Shaping | the aim decal is visibly bigger | moderate |
| Deep Reserves | the bars are longer | moderate |
| Measured Recovery | a bigger green number | moderate |
| Crushing Blows | the target's Guard bar drops faster | weak — a monster's guard row is only drawn when dented (spec 257) |
| Steady Frame | the Guard bar refills | weak — the "hold ground" condition is unsignalled |
| Committed Swing | a stagger that did not happen | **none** — an absence |
| Quick Recovery | nothing | **none** — the cancel point is drawn nowhere |
| Weak-Point Study | nothing | **none** — see below |

### A weak point never crosses the wire

`sim/blow.ts` computes `weakPoint` as a boolean separate from `critical`, with
its own multiplier, its own resource return and its own Exposed application.
`CombatFlag` (`net/messages.ts:917`) is `Killed | Critical | Blocked | Periodic`
and has no weak-point bit, and `server.ts:3255` packs only those four. So the
entire Perception payoff is invisible below Perception 20, where the milestone
starts leaving an `Exposed` mark. A threshold-10 purchase buys a thing the
player cannot observe at all.

Spec 219 is the precedent for fixing it: it promoted `periodic` onto this same
message on the argument that **the client cannot work it out**, which is exactly
true here.

## 4. The three distinct failures

Conflating these is why it looks like one problem.

1. **The unlock moment is silent.** `view.ts:2258` plays `player.attributeUp` on
   the *press*, unconditionally, for every point — so 9→10, which opens two
   mechanics, sounds identical to 5→6, which opens none. The purchase only
   surfaces on a sheet the player has open (`ui-screens.ts:1064`). Nothing
   anywhere says a node opened.
2. **The mechanic has no tell when it fires** — §3 above.
3. **There is nowhere to practise.** `data/monsters.ts` has a `dummy` row (25000
   health, `sentinel`, `defensive`, no attack) with **no spawner on the shipped
   map**; a respec costs coins; and every other body fights back.

## 5. Surfaces already built

- **Signs.** Spec 260 built the prop, the `text` field, the crosshair, the pick
  volume, the bubble and a probe, and its own Problem section names *"a tutorial
  line"* as the first thing it is for. **There are zero signs on the shipped
  map** (5,666 props: trees, bushes, fences, torches, campfires, graves, lamps,
  houses, one well). 240 chars each, about four lines in the bubble.
- **The `notification` layer.** `LAYER_IDS` has carried `'notification'`
  (`blocksBelow: false, interactive: false`) since spec 124 and **nothing has
  ever been placed in it.**
- **`controlsSeen`.** `ui/input/display-store.ts:104`, spec 255 — the one
  first-time system in the tree, and the pattern for "seen" state: a client-side
  preference document, and a field whose absence reads honestly costs no version
  bump. Its content is derived from the live `InputMap`, never fixed text.
- **Derived descriptions.** `describeSpecialization`, `describeStatus`,
  `grantsOf`, `technicalText` — all pure, all shared, all already imported by
  `hud.ts`. `hud.ts:2062` already puts `technicalText(describeStatus(...))` on an
  overhead glyph's `title`.
- **The System chat channel.** `server.ts:3544` already sends a progression line
  through it (`An admin changed your progression: …`) — an admin-only path, but
  the rail is built.
- **A short label floating off a slot.** `SkillSlot.refund` +
  `MOTION.refund` — and `MOTION` already distinguishes `RESPONSE_TIMINGS` from
  `NOTICE_TIMINGS`, which is the bucket an unlock notice falls in. Its label font
  is digits-only today, so it cannot spell a word as-is.
- **The client already knows.** `ClientView.attributes` and
  `ClientView.specializations` are both replicated on `Stats`, so *a threshold
  crossing is derivable client-side with no protocol change*, in exactly
  `xp-gain.ts`'s register (first reading only baselines, a move backwards
  re-baselines silently).

## 6. What the standing docs allow

`docs/reward-philosophy.md`:

- §1 — no screen that interrupts play; the reward lives in the world, the HUD, or
  a window the player opened.
- §10 — no banners, no fanfares on everything; not every tier gets ceremony.
- §11 — reuse the vocabulary: Guard, wind-up, follow-through, weak point,
  Exposed, Attuned.
- §9 — *visible consequences of progression* is listed as **future direction**,
  "do not add new stat mechanics under this heading without a spec".

§8's "do not convert discovery into a popup" is about the emergent attribute
pairs and does **not** forbid this: a milestone or a tier the player *bought* is
a transaction, and confirming a transaction is not spoiling a discovery.
Worth stating explicitly in any spec so the two do not read as contradicting.

## 7. Proposals

### Content only, zero code

1. **A training yard by the spawn village.** Two or three `dummy` spawners plus
   three to five signs, each naming one mechanic in the game's own vocabulary.
   A `scripts/place-training-yard.ts` in the register of `place-npc.ts` and
   `light-the-square.ts` — prints what it would do, `--write` does it,
   idempotent, refuses ground with no footing or a spot inside a prop.
   Note the limit: the dummy has no attack, so it cannot teach Committed Swing
   or Opening Read, both of which need something swinging at you. A low-damage
   `defensive` sparring body would cover those and is a content decision.

### Existing systems, small code

2. **Split the threshold sound from the point sound.** Move `player.attributeUp`
   off the press and onto the `Stats` diff (`player.levelUp`'s own shape at
   `view.ts:4644`), and add one event row for a crossing. A node opening should
   not sound like a number going up.
3. **An unlock notice in the `notification` layer.** Name plus one sentence,
   drawn on `NOTICE_TIMINGS`' rule, non-blocking and non-interactive by the
   layer's own declaration. Fires **only** where `grantsOf` returns a `whole`
   grant, or for an automatic milestone — silent for a numeric tier, which is
   §10's discipline rather than a shortcut. Derived client-side from the
   replicated `Stats`; no wire change.
4. **`seen` state in `display-store.ts`** beside `controlsSeen`, so a notice is
   shown once. Cost to state rather than fix: a player on a second machine is
   taught twice.

### Needs a spec

5. **A weak-point `CombatFlag` bit** and a distinct damage popup for it, on spec
   219's argument. The single highest-value item here: it makes a whole
   attribute's identity observable from Perception 10 instead of Perception 20.
6. **Draw the follow-through cancel point on the cast bar.** `selfCommitted`
   (spec 258) already mirrors the rule client-side and already knows the tick, so
   this is presentation only. It turns Quick Recovery from an invisible purchase
   into a mark the player watches move.
7. **`describeMilestone` in `description.ts`.** The one hole in the Technical
   Description standard: eighteen milestones carry hand-authored `effect` prose
   read straight off the table while every ability, status and specialization is
   derived — against `mechanics-vocabulary.md`'s own first rule. `grantsOf`
   already turns a `StatModifier` into lines.
8. **A trainer NPC.** One `npcs.ts` row, one `shopkeeper()`-shaped monster row,
   one `dialogue.ts` script, one marker. `DialogueChoice.opens` is an enum of one
   (`'shop'`); `'character'` would let a trainer open the sheet. **Limit:**
   `DialogueScript` has no conditions and no flags, so a trainer cannot react to
   what you have built — only offer a menu. A condition language would be the
   first stateful content in the tree and wants its own spec.

## 8. Suggested order

Yard and signs first (they cost nothing and make everything else observable),
then the weak-point flag (largest single gain), then the unlock notice, then the
cancel-point mark. `describeMilestone` folds in cheaply alongside the notice.
