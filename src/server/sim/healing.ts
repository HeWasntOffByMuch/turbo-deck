/**
 * One restoration, with the economy applied (specs 147, 156).
 *
 * Moved out of `sim/abilities.ts` by spec 188 and otherwise untouched. It came
 * out because the skill resolver needs it and `sim/abilities.ts` needs the skill
 * resolver, and two peers importing each other is a cycle even when ESM happens
 * to survive one. It reads better here anyway: healing is asked about by
 * abilities, by motes and now by skills, and it was never *about* casting.
 *
 * The one place healing is scaled and the one place overheal goes anywhere.
 *
 * Pure. The tick is an argument.
 */

import { healingScaleOf } from './damage-over-time.js';
import { salvageFrom } from './restoration.js';
import type { ServerEntity } from './types.js';

export interface HealResult {
  readonly entity: ServerEntity;
  /** What actually went into the health bar. */
  readonly healed: number;
  /** What did not fit, before Constitution or Wisdom got hold of it. */
  readonly overheal: number;
  /** Of that, what Wisdom put back into the restoration meter (spec 156). */
  readonly salvaged: number;
  /** And what nothing caught. The number the instrumentation calls waste. */
  readonly wasted: number;
}

/**
 * One restoration, with the economy applied (spec 147).
 *
 * The one place healing is scaled and the one place overheal goes anywhere. In
 * order:
 *
 *  1. Wisdom (and a little Constitution) scale the amount.
 *  2. The Constitution+Wisdom pair doubles it below its threshold, because an
 *     attrition build should get *more* out of a heal exactly when it is losing.
 *  3. What fits goes into health -- up to `ceiling` if one is given, which is
 *     how Second Wind stabilizes a body without lifting it out of the danger
 *     band (spec 273).
 *  4. What does not fit goes to a shield (Constitution 50), or to resource
 *     (Wisdom 50), or nowhere. Both are capped -- the shield by `maxShield`, the
 *     conversion by `conversionCap` per event -- so neither is a loop.
 *
 * A body with no traits at all gets `min(max, health + amount)`, which is
 * exactly what `landSelf` did before this existed.
 */
export function applyHealing(
  entity: ServerEntity,
  amount: number,
  tick: number,
  ceiling?: number,
): HealResult {
  if (!(amount > 0)) return { entity, healed: 0, overheal: 0, salvaged: 0, wasted: 0 };
  const traits = entity.stats.traits;

  const surge =
    traits.healingSurge > 0 &&
    entity.stats.maxHealth > 0 &&
    entity.health / entity.stats.maxHealth <= traits.healingSurgeBelow
      ? 1 + traits.healingSurge
      : 1;
  // Decay's suppression, here rather than at each caller (spec 190). This one
  // line is what reaches the flask, Mend, a skill's heal and a collected mote,
  // and it goes *before* the outlets rather than after them so that the shield,
  // the conversion and Wisdom's salvage each see the amount that was actually
  // restored -- a suppression applied afterwards would leave a body converting
  // overheal it never got.
  const total = amount * traits.healingScale * surge * healingScaleOf(entity.statuses, tick);

  // **The ceiling on what this particular heal may raise health to** (spec 273).
  //
  // Absent it is `maxHealth`, so every caller that does not pass one is
  // byte-identical to what it was. Second Wind passes the danger threshold,
  // because a comeback that lifted the body clear of the band would switch off
  // Hard to Kill, the stagger immunity and the desperation surge -- the three
  // things the same threshold armed.
  //
  // It bounds the *health*, not the heal: everything above it is `overheal` and
  // falls through the cascade below exactly as an ordinary overheal does. So a
  // capped Second Wind on a Constitution character with Overflow Vitality
  // becomes health up to the band and a shield after it, which is durability
  // rather than health and therefore cannot eject anybody from anything.
  const top = ceiling === undefined ? entity.stats.maxHealth : Math.min(entity.stats.maxHealth, ceiling);
  const room = Math.max(0, top - entity.health);
  const healed = Math.min(room, total);
  const overheal = total - healed;

  let shield = tick < entity.shieldUntilTick ? entity.shield : 0;
  let shieldUntilTick = entity.shieldUntilTick;
  let resource = entity.resource;

  // What none of the outlets caught. Tracked rather than inferred, because
  // Wisdom's salvage is applied to *what is actually left* (spec 156) -- a
  // salvage that read the whole overheal would pay twice for the part
  // Constitution's shield or Wisdom's own conversion had already taken.
  // **The overheal cascade** (spec 239). Three outlets, each taking from what
  // the one above it left, in a fixed order that is stated once here:
  //
  //   1. Constitution's shield   (`overhealShieldTicks`, capped by `maxShield`)
  //   2. Wisdom's conversion     (`conversionCap`, into the resource pool)
  //   3. Wisdom's salvage        (`salvageFrom`, into the restoration meter)
  //
  // The first two were an `if / else if`, which meant **the Constitution
  // capstone switched the Wisdom capstone off**: a character with Overflow
  // Vitality and Conversion took the shield branch always, and Conversion --
  // the last thing a Wisdom character buys, at 50 Wisdom -- did nothing for the
  // rest of the game. Two investments, and gaining the second one cost you the
  // first.
  //
  // Constitution's is first because a shield is a *buffer against the next
  // blow* and Conversion is explicitly a valve for what would otherwise be
  // wasted -- the skill's own words. Both remain meaningful: a big overheal
  // fills the shield to its cap and the remainder still converts, which is the
  // case a CON/WIS build produces constantly.
  //
  // Nothing is created twice, because each outlet takes from `leftover` and
  // subtracts exactly what it actually absorbed -- an outlet at its cap, or a
  // pool already full, consumes nothing and passes the whole remainder on.
  let leftover = overheal;
  if (leftover > 0 && traits.overhealShieldTicks > 0 && traits.maxShield > 0) {
    const before = shield;
    shield = Math.min(traits.maxShield, shield + leftover);
    shieldUntilTick = tick + traits.overhealShieldTicks;
    leftover -= shield - before;
  }
  if (leftover > 0 && traits.conversionCap > 0) {
    const before = resource;
    resource = Math.min(
      entity.stats.maxResource,
      resource + Math.min(traits.conversionCap, leftover),
    );
    leftover -= resource - before;
  }

  // The last outlet, and the only path in the game from healing back to the
  // restoration meter. Bounded twice -- by the fraction Wisdom has bought and by
  // a cap under one threshold -- so no amount of overhealing funds a mote
  // outright, and a build with no Wisdom simply loses the remainder.
  const salvaged = salvageFrom(entity, leftover);

  return {
    healed,
    overheal,
    salvaged,
    wasted: Math.max(0, leftover - salvaged),
    entity: {
      ...entity,
      health: entity.health + healed,
      shield,
      shieldUntilTick,
      resource,
      restoration: entity.restoration + salvaged,
    },
  };
}
