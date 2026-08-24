/**
 * The afflictions, as data (spec 190).
 *
 * An affliction is `a rate + a cadence + a length`, and everything past that is
 * a **rider that reaches into a system this game already has**. So this is one
 * table rather than seven mechanics, and the resolver beside it
 * (`sim/damage-over-time.ts`) is the only thing that reads it.
 *
 * The three numbers every row authors are the three a designer actually thinks
 * in: **how hard** ({@link DotDefinition.damagePerSecond}), **how lumpy**
 * ({@link DotDefinition.intervalTicks}) and **how long**
 * ({@link DotDefinition.pulses}). Everything else about the shape is derived,
 * because two of the derivations are where an off-by-one lived:
 *
 * ```
 *   pulse damage = damagePerSecond * intervalTicks / SERVER_TICK_RATE
 *   duration     = pulses * intervalTicks + 1
 *   total        = pulse damage * pulses
 * ```
 *
 * The `+ 1` is the whole of the arithmetic and is stated once, here. A pulse
 * fires on `elapsed % intervalTicks === 0` with `elapsed > 0`, and `statusOf`
 * refuses an entry at `tick >= expiresAtTick` -- so a duration of exactly
 * `pulses * interval` loses its last pulse to the expiry comparison and "eight
 * pulses of 4.5" quietly means seven. One tick of slack fixes it for every row
 * at once, where authoring the durations by hand would have been seven chances
 * to get it wrong and no way to notice.
 *
 * Pure data. No behaviour, in the same register as `data/skill-effects.ts`.
 */

import { SERVER_TICK_RATE } from '../config.js';
import { StatusId } from '../sim/statuses.js';

export interface DotDefinition {
  /** The {@link StatusId} this is, which is also its id on the wire. */
  readonly id: string;
  readonly name: string;
  /**
   * Damage a second, per stack, before the ramp and before the applier.
   *
   * A rate rather than a per-pulse amount, so that changing how lumpy an
   * affliction is does not silently change how much it is worth. Shock and
   * Poison differ in `intervalTicks` by a factor of six and the column above is
   * still comparable down the page.
   */
  readonly damagePerSecond: number;
  /** How lumpy it arrives -- the axis that separates a trickle from a burst. */
  readonly intervalTicks: number;
  /** How many pulses one application is worth. The length, in pulses. */
  readonly pulses: number;
  readonly maxStacks: number;

  // --- the riders. One system each, and none of them arithmetic here ------

  /**
   * The rate gains this fraction of itself per second held (Frostbite).
   *
   * Measured from {@link StatusState.appliedAtTick}, which a refresh does not
   * move -- so topping the cold up keeps the escalation running rather than
   * restarting it, which is the whole of "dangerous if exposure continues".
   */
  readonly rampPerSecond?: number;
  /** What the ramp may reach. Absent with a ramp is a mistake the validator catches. */
  readonly rampCap?: number;
  /**
   * What a pulse is worth while the body is exerting itself (Bleed).
   *
   * Read off the **replicated** `activity`: `Moving` or `Casting` is exertion
   * and `Idle` is not. A field somebody watching the fight can already see,
   * rather than a hidden per-tick measurement, so "stop moving and it hurts
   * less" is legible from outside the body it is happening to.
   */
  readonly exertionScale?: number;
  /**
   * How far a pulse looks for somebody to pass this on to (Burn, Shock).
   *
   * Burn's "spreads" and Shock's "jumps to nearby targets" are the same
   * question -- how does an affliction reach the body next to it -- so they are
   * one field with two radii rather than two propagation systems. See
   * `sim/damage-over-time.ts` for the rule and why it terminates.
   */
  readonly spreadRadius?: number;
  /** Guard taken a second, written straight into the pool and never breaking it. */
  readonly guardPerSecond?: number;
  /**
   * The armour this strips while it is on (Corrosion).
   *
   * Applied as {@link StatusId.Sundered} rather than as a second armour-
   * reduction reader: `blow.ts` already takes `Sundered.magnitude` off the
   * armour in its mitigate step, and a corrosion that reduced armour its own
   * way would be two answers to "how much armour has this body lost".
   */
  readonly sunderMagnitude?: number;
  /**
   * What healing is multiplied by while this is on (Decay).
   *
   * A scale rather than a block, and floored well above zero: "suppresses" is
   * not "prevents", and an affliction that switched healing off outright would
   * make one status decide a whole fight.
   */
  readonly healingScale?: number;
  readonly description: string;
}

function seconds(value: number): number {
  return Math.max(1, Math.round(value * SERVER_TICK_RATE));
}

const DEFINITIONS: readonly DotDefinition[] = [
  {
    id: StatusId.Burn,
    name: 'Burn',
    // The most damage a second in the table and the shortest life, which is
    // what "immediate pressure" is: it has to be answered now, and it answers
    // itself shortly whether you do anything or not.
    damagePerSecond: 1.3,
    intervalTicks: seconds(0.5),
    pulses: 8,
    // It does not stack. A second application is the same fire, refreshed --
    // and stacking a strong, short affliction is how a burst becomes a delete.
    maxStacks: 1,
    spreadRadius: 90,
    description: 'Burning. Strong, short, and it will take the next body along with it.',
  },
  {
    id: StatusId.Bleed,
    name: 'Bleed',
    damagePerSecond: 0.7,
    intervalTicks: seconds(0.5),
    pulses: 12,
    maxStacks: 3,
    // A wound that opens when you use the body it is in. Big enough to be a
    // real decision -- standing still through a bleed costs tempo, and tempo is
    // what this game charges for everything else.
    exertionScale: 1.75,
    description: 'A wound that opens up again every time you move or swing.',
  },
  {
    id: StatusId.Poison,
    name: 'Poison',
    // The weakest rate and the longest life. One stack is barely worth
    // noticing; five is the whole point, and getting to five takes five darts.
    damagePerSecond: 0.3,
    intervalTicks: seconds(0.5),
    pulses: 20,
    maxStacks: 5,
    description: 'Attrition. Weak on its own, and it stacks, and it lasts.',
  },
  {
    id: StatusId.Corrosion,
    name: 'Corrosion',
    damagePerSecond: 0.6,
    intervalTicks: seconds(0.5),
    pulses: 12,
    maxStacks: 3,
    // The guard goes with the health, which is what makes this the affliction
    // you put on something you intend somebody else to break. It never breaks
    // the guard itself -- see the resolver.
    //
    // **Measured against regeneration, not against the pool.** A monster
    // regenerates `SCALING.combat.monsterPoiseRegen` = 6 guard a second, and
    // this was authored at 6 -- exactly cancelling it, so the rider did nothing
    // at all to a body standing still, which is precisely the body you would
    // put it on. What matters is the *net*, and 14 is a net 8 a second against
    // a calm monster. Every number in it was individually defensible and the
    // difference was zero.
    guardPerSecond: 14,
    // Slightly more than the 0.1 a Strength+Intelligence build's basic attacks
    // apply, so a corroded body is the softest thing on the field and the trait
    // is still worth having on everything that is not.
    sunderMagnitude: 0.12,
    description: 'It eats through the guard and the armour on the way to what is under them.',
  },
  {
    id: StatusId.Shock,
    name: 'Shock',
    damagePerSecond: 1.1,
    // Six times Poison's interval, from the same column of rates: the same
    // arithmetic arriving in lumps you can see land.
    intervalTicks: seconds(0.75),
    pulses: 6,
    maxStacks: 1,
    // Further than a fire creeps, because an arc is a jump rather than a
    // spread. Same rule, same field, two numbers.
    spreadRadius: 150,
    description: 'It arrives in jolts, and it looks for the next body while it does.',
  },
  {
    id: StatusId.Frostbite,
    name: 'Frostbite',
    // Starts at less than Poison's single stack and ends at more than Burn.
    damagePerSecond: 0.3,
    intervalTicks: seconds(0.5),
    pulses: 16,
    maxStacks: 1,
    rampPerSecond: 0.35,
    rampCap: 3,
    description: 'Harmless for a moment. Dangerous if you let it stay on.',
  },
  {
    id: StatusId.Decay,
    name: 'Decay',
    // The lowest damage in the table by design: what it costs you is not the
    // health it takes, it is the health you cannot put back.
    damagePerSecond: 0.2,
    intervalTicks: seconds(1),
    pulses: 10,
    maxStacks: 1,
    healingScale: 0.4,
    description: 'A slow rot. Nothing you do to close a wound quite works while it runs.',
  },
];

export const DAMAGE_OVER_TIME: ReadonlyMap<string, DotDefinition> = new Map(
  DEFINITIONS.map((row) => [row.id, row]),
);

export const ALL_DOTS: readonly DotDefinition[] = DEFINITIONS;

/** The row for a status id, or null if that status is not an affliction. */
export function dotById(id: string): DotDefinition | null {
  return DAMAGE_OVER_TIME.get(id) ?? null;
}

/** What one pulse is worth, at one stack, before the ramp and the applier. */
export function dotPulseDamage(row: DotDefinition): number {
  return (row.damagePerSecond * row.intervalTicks) / SERVER_TICK_RATE;
}

/**
 * How long one application lasts.
 *
 * `pulses * interval` **plus one tick**, so the last pulse lands inside the
 * window rather than on the exact tick `statusOf` starts refusing the entry.
 * See the file header: this is the one line that makes `pulses` mean what it
 * says.
 */
export function dotDurationTicks(row: DotDefinition): number {
  return row.pulses * row.intervalTicks + 1;
}

/**
 * What the escalation is worth after `elapsedTicks` of being carried.
 *
 * Here rather than in the resolver because two things need the same answer and
 * they must not diverge: the pass, which asks it per pulse, and
 * {@link dotTotalDamage}, which sums it over the whole life. It lived only in
 * the pass at first, and `dotTotalDamage` was `pulse * pulses` -- which is the
 * truth for six rows and off by a factor of two and a bit for Frostbite, the one
 * row the field exists for. `scripts/preview-afflictions.ts` measures the total
 * rather than reading it, which is how that was caught.
 */
export function dotRampAt(row: DotDefinition, elapsedTicks: number): number {
  if (row.rampPerSecond === undefined) return 1;
  return Math.min(
    row.rampCap ?? Number.POSITIVE_INFINITY,
    1 + (row.rampPerSecond * elapsedTicks) / SERVER_TICK_RATE,
  );
}

/**
 * What a whole application is worth at one stack, unexerted.
 *
 * Summed over the pulses rather than multiplied by them, because an escalating
 * row's pulses are not all the same size. The sum is over exactly the ticks the
 * pass will fire on -- `interval`, `2 * interval`, ... -- so this and a real
 * fight cannot disagree.
 */
export function dotTotalDamage(row: DotDefinition): number {
  let total = 0;
  for (let i = 1; i <= row.pulses; i++) {
    total += dotPulseDamage(row) * dotRampAt(row, i * row.intervalTicks);
  }
  return total;
}

/** What one pulse takes off the guard, for a row that takes any. */
export function dotPulseGuard(row: DotDefinition): number {
  return ((row.guardPerSecond ?? 0) * row.intervalTicks) / SERVER_TICK_RATE;
}
