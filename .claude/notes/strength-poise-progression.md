# Strength POISE/STAGGER trait trace (spec 239/243/244-era code)

Traced 2026-09-01. Re-read source before relying on line numbers for edits.
Companion to `combat.md` (general attack/cast lifecycle) — this is the
progression-trait layer specifically: how Strength's specializations and
milestones turn into numbers `sim/poise.ts` and `sim/blow.ts` actually use.

## Pipeline (all pure, src/server/{data,player,sim})

`specializations.ts`/`milestones.ts` grant `StatModifier.traits` fields →
`progression.ts:80` scales a spec's `perTier` by tier count
(`scaleModifier`) → `modifiers.ts:379 sumModifiers` additively sums every
granted modifier field-by-field into `ModifierTotals.traits` (flat sum, no
caps yet) → `player/derived.ts:199 deriveTraits` is the ONE place caps/
clamps/`growth()`/`reduction()` apply, producing `TraitStats` → that rides
`EffectiveStats.traits` on `ServerEntity.stats` → `sim/poise.ts` and
`sim/blow.ts` read `entity.stats.traits.*` directly. No other file computes
any of this arithmetic.

## Key finding: two traits are read on the live sim path but currently inert

- **`abilityPoiseFactor`** (`sim/poise.ts:303`) — multiplies `staggerPower`
  for any non-basic-attack blow. **No specialization or milestone row sets
  it** (grep confirms zero hits outside type defs/tests/comments). It used
  to come from a STR+INT pair synergy; spec 244 deleted `synergies.ts` and
  nothing replaced the grant. Default is 0 (`derived.ts:71`), so **every
  ability/skill 'damage' effect currently carries zero poise damage** via
  `poiseDamageOf` — only a basic attack's full `staggerPower` matters today.
- **`juggernautBelow`** — read live (`poise.ts:85-89`, gates non-basic-attack
  hyper-armour), but the only source in the data tables is
  `str.unstoppable` setting it to exactly `1` (`specializations.ts:111`).
  `1` means "always" (`if (gate < 1) return 0` never fires when gate === 1).
  **The graduated low-health-gate behaviour the field's own type doc
  describes (`state/types.ts:334`: "Health fraction below which
  `poiseArmorAllCasts` turns on") is unreachable with current content** —
  nothing ever grants a fractional value, so in practice it behaves as a
  second on/off flag alongside `poiseArmorAllCasts`, not a health threshold.
  `poise.ts`'s own header comments (lines 60-61, 83-84) still describe "the
  Juggernaut pair" setting it to 0.5 — **stale docs**, not stale code; that
  pair (`pair.strCon` in `data/presets.ts:83`, description text only) no
  longer grants anything (spec 244).

Everything else traced (`poiseDamagePct`, `windupPoiseArmor`,
`poiseArmorAllCasts`, `poiseArmorInBackswing`, `staggerBase/Per/Knee/
Falloff`, `poisePer`, `staggerTicksBase/Per/Cap`, `healthPer`) is live and
wired end to end.

## poiseDamagePct — does NOT reach every source of poise damage

Three completely separate poise-damage paths exist and only one of them
runs through `poiseDamageOf`/`staggerPower` (which is what `poiseDamagePct`
scales):

1. **Basic attack / ability 'damage' effect** → `blow.ts:350-355` →
   `poiseDamageOf(attacker.stats, isBasicAttack, poiseMultiplier)`
   (`poise.ts:297-305`) — `poiseDamagePct` applies in full (basic attack) or
   times zero (`abilityPoiseFactor`, ability — see above).
2. **Skill `{ kind: 'poiseDamage', amount }` effect** →
   `skill-effects.ts:151` → `applyPoiseDamage(target, effect.amount, ...)`
   directly with the **row's own authored absolute number**. Bypasses
   `poiseDamageOf`/`staggerPower` entirely — `poiseDamagePct` has zero
   effect on this path (comment at `data/skill-effects.ts:144-148` states
   this is deliberate: "a skill that says 'and 40 guard' should mean 40 to
   everyone").
3. **Affliction pulse ("Corrosion") guard** → `damage-over-time.ts:389-392`
   — `entity.poise - guard`, written **straight into the pool**, clamped at
   0, bypassing `applyPoiseDamage` (and therefore hyper-armour, the
   immunity check, and the break/stagger event) entirely. Cannot ever
   trigger a stagger. `staggerPower`/`poiseDamagePct` are never read here
   (confirmed: no `staggerPower` reference anywhere in
   `sim/damage-over-time.ts`).

## windupPoiseArmor cap: 0.9, applied once, on the summed total

`derived.ts:339`: `windupPoiseArmor: clamp(t.windupPoiseArmor, 0, 0.9)` —
one clamp over the flat sum of all 4 granting sources (Committed Swing
0.08×3 + milestone@35 0.36 + Unstoppable spec 0.12 + milestone@50 0.18 =
exactly 0.90 at full investment; `specializations.ts:91-97` and
`milestones.ts:82-86` comments both state this was retuned in spec 239 so
the four sum to exactly the cap rather than overshooting it).

## staggerTicks (break duration) is the ATTACKER's own trait, not the victim's

`derived.ts:218-222` computes `staggerTicks` from the body's **own**
Strength (raw, not `above()`-baselined): `clamp(round(staggerTicksBase +
linear(STR, staggerTicksPer)), 1, staggerTicksCap)` = `clamp(round(30 +
STR*0.2), 1, 48)` ticks (30=seconds(0.5), 48=seconds(0.8) @ 60Hz). Every
`stagger(...)` call site (`blow.ts:374`, `skill-effects.ts:157-163`) passes
**the attacker/caster's** `stats.traits.staggerTicks` explicitly — `blow.ts`
carries an in-line comment (**"`A`, not `D`"**) recording that this was
previously backwards (scaled off the victim's own Strength) and was caught
by `player/progression-audit.ts`'s backwards-progression check. The skill
`{ kind: 'stun' }` effect (`skill-effects.ts:198`) is a *third*, unrelated
path: `Math.max(1, Math.round(effect.ticks))`, the **skill's own authored
duration**, no `staggerTicks` involved at all.

## staggerImmune: 2s (`SCALING.combat.staggerImmuneTicks = seconds(2)` = 120
ticks, `scaling.ts:309`), per-**victim**, gates the break/root/refill/event,
NOT the poise drain. `applyPoiseDamage` (`poise.ts:184-193`) keeps
subtracting `armored` from the pool and clamping it at 0 while immune;
only the *break* (refill to full + new immunity stamp + `Stunned` state) is
suppressed. So spamming a body during its own immunity window still drives
its pool to (and holds it at) zero, and the next qualifying hit after the
window lapses breaks it again almost for free — two Strength attackers
sharing one victim get one *break* per 2s window between them, but the
window does not protect the pool itself.

## Hyper-armour gate — exact conditional, `poise.ts:74-92`

Three gates, all must pass: `cast !== null` and `windupPoiseArmor > 0`;
phase is Windup/Turning (always covered) or Backswing (only if
`poiseArmorInBackswing > 0`, i.e. Strength-50 milestone reached); if the
cast is not a basic attack, `poiseArmorAllCasts > 0` AND (health fraction
`<= juggernautBelow`, which today is always exactly 1 = "always" once
Unstoppable is taken, never a real threshold — see inert finding above).
Returns `traits.windupPoiseArmor` (0..0.9) or 0.
