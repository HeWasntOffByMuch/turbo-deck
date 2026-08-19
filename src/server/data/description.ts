/**
 * What a mechanic does, said once (spec 189).
 *
 * The writer for the Technical Description standard in
 * `docs/mechanics-vocabulary.md`. Every player-facing statement about an
 * ability or a status is produced here and nowhere else, which is what makes
 * the brief's bar -- *two designers independently describing the same mechanic
 * produce nearly identical descriptions* -- a property of the module graph
 * rather than a habit somebody has to keep: there is one writer, so there is
 * one description.
 *
 * **Derived, not authored.** The lines are composed from the same row the sim
 * reads, so a retuned number is described correctly on the next frame with
 * nothing to remember. `inventory-model.ts` has worked this way since spec 185
 * -- an item's stat lines come from its `modifiers` rather than from a sentence
 * somebody wrote -- and this is that precedent applied to the two tables that
 * never got it.
 *
 * The corollary is the rule that keeps the file honest: **nothing that can be
 * derived may be authored.** A `StatusVisual` knows its name, its kind and its
 * stack ceiling and does *not* know what the condition does -- that lives in
 * `sim/blow.ts` and `SCALING` -- so the effect sentence is authored on the row
 * and everything around it is composed here. An ability knows all of it, so
 * none of an ability's technical text is authored.
 *
 * **Flavour is never mixed in.** `AbilityDefinition.description` is the
 * authored flavour line and it is returned in its own field, never concatenated
 * into {@link TechnicalDescription.lines} and never included by
 * {@link technicalText}. A flavour line that makes a mechanical claim is a bug,
 * because it will drift from the row beside it.
 *
 * **Nothing is invented.** Where the sim's answer is unclear the line is
 * omitted rather than guessed, and the question is recorded in the document's
 * open-questions section. The two that bite hardest are worth naming here: a
 * shape's `maxTargets` is candidate order rather than distance, so no line may
 * say *the nearest*; and a basic attack's cadence comes from Base Attack Time
 * rather than from its `cooldownTicks`, so no basic attack shows a cooldown.
 *
 * Pure, dependency-free, part of the deterministic core: no clock, no
 * randomness, no entity is read. Every number comes out of a table.
 */

import { SERVER_TICK_RATE } from '../config.js';
import type { AbilityDefinition } from './abilities.js';
import { subjectOf, type SkillArea, type SkillEffect } from './skill-effects.js';
import { visualFor, type StatusVisual } from './status-visuals.js';

/**
 * Which register a line is in, so a surface can style the block without
 * parsing it.
 *
 * Also the standard's information order: `target`, `effect`, `cost`, `timing`,
 * `note`. A line with nothing to say is omitted rather than left blank, so the
 * order is stable and a reader learns where to look.
 */
export type Tone = 'target' | 'effect' | 'cost' | 'timing' | 'note';

export interface TechnicalLine {
  readonly text: string;
  readonly tone: Tone;
}

export interface TechnicalDescription {
  readonly name: string;
  /** The mechanical lines, in the standard's order. Never empty. */
  readonly lines: readonly TechnicalLine[];
  /** Authored flavour, kept out of {@link lines} and never mixed into them. */
  readonly flavor: string | null;
}

/**
 * What the Resource pool is called in front of a player.
 *
 * One string, because it is the open question the document records first: the
 * pool has no in-world name and "Resource" is a category. When it gets one,
 * this is the line that changes.
 */
export const RESOURCE_NAME = 'Resource';

/**
 * What `poise` is called in front of a player.
 *
 * The internal name never appears: the pool is Guard, the damage to it is Guard
 * damage, and the skill that strips it is named for it.
 */
export const GUARD_NAME = 'Guard';

// --- number forms -------------------------------------------------------
//
// The standard's §2.3, in four functions, so a number cannot be formatted two
// ways in two places.

/** A bare quantity: damage, healing, range, radius. Nearest integer. */
function amount(value: number): string {
  return String(Math.round(value));
}

/**
 * Ticks as seconds, to at most two decimals with trailing zeros trimmed.
 *
 * Two rather than the one the first draft of the standard asked for, because
 * one is not enough to be *accurate*: `seconds(0.35)` is 21 ticks and one
 * decimal reports it as 0.4s. Accuracy outranks brevity, and every authored
 * duration in the game lands exactly on two.
 */
export function formatSeconds(ticks: number): string {
  if (!Number.isFinite(ticks)) return '0s';
  const value = Math.round((ticks / SERVER_TICK_RATE) * 100) / 100;
  return `${String(value)}s`;
}

/** A fraction as an integer percentage. `0.4` -> `40%`. */
function percent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

/**
 * A cone's **full** opening angle in degrees, from the squared cosine of its
 * half-angle.
 *
 * The inverse of `arcCosSqOf`, and it answers in the full angle because that is
 * what the standard fixed and what a caller means by "a 90-degree cone".
 */
function coneDegrees(arcCosSq: number): string {
  const clamped = Math.max(0, Math.min(1, arcCosSq));
  const half = Math.acos(Math.sqrt(clamped));
  return `${String(Math.round(((half * 2) * 180) / Math.PI))}°`;
}

/** `['a', 'b', 'c']` -> `a, b and c`. Never an Oxford comma; never `&`. */
function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${String(parts[parts.length - 1])}`;
}

// --- abilities ----------------------------------------------------------

/**
 * The Technical Description for one ability.
 *
 * Every line is composed from the row. The only authored string that survives
 * is the flavour, and it is returned separately.
 */
export function describeAbility(ability: AbilityDefinition): TechnicalDescription {
  const lines: TechnicalLine[] = [];
  const push = (tone: Tone, text: string): void => {
    if (text.length > 0) lines.push({ tone, text });
  };

  push('target', targetLine(ability));
  // Travel before shape: a shot flies and *then* bursts, and the burst line
  // reading first put the impact before the flight that causes it.
  push('target', travelLine(ability));
  push('target', shapeLine(ability));

  for (const text of effectLines(ability)) push('effect', text);
  push('cost', costLine(ability));
  for (const text of timingLines(ability)) push('timing', text);
  for (const text of noteLines(ability)) push('note', text);

  return {
    name: ability.name,
    lines,
    flavor: ability.description.length > 0 ? ability.description : null,
  };
}

/** Who or what the cast is aimed at, and how far away it may be. */
function targetLine(ability: AbilityDefinition): string {
  const parts: string[] = [];
  switch (ability.targeting) {
    case 'self':
      parts.push('Target: yourself.');
      break;
    case 'unit':
      parts.push('Target: one enemy.');
      break;
    case 'point':
      parts.push('Target: a point on the ground.');
      break;
    case 'direction':
      parts.push('Target: a direction.');
      break;
  }
  // Range zero is a self-cast and says nothing; the standard omits an absent
  // field rather than writing it as zero.
  if (ability.range > 0) parts.push(`Range ${amount(ability.range)}.`);
  return parts.join(' ');
}

/**
 * The shape the landing picks with, where there is one.
 *
 * `area` first, because `kind: 'area'` is the only kind that reads it; then the
 * cone a melee swing or a channel sweeps; then the burst a ground blast or an
 * exploding projectile leaves.
 */
function shapeLine(ability: AbilityDefinition): string {
  if (ability.area) return areaLine(ability.area);
  if (ability.arcCosSq !== undefined) {
    return `Hits enemies in a ${coneDegrees(ability.arcCosSq)} cone.`;
  }
  if (ability.kind === 'ground' && ability.radius !== undefined) {
    return `Hits enemies within ${amount(ability.radius)} of the point.`;
  }
  if (ability.projectile && ability.radius !== undefined) {
    return `Bursts on impact, hitting enemies within ${amount(ability.radius)}.`;
  }
  return '';
}

/**
 * One area shape as a sentence.
 *
 * `up to N` and never *the N nearest*: `sim/skill-area.ts` picks in candidate
 * order and says at length that sorting by distance "would be a better game and
 * a worse guarantee". Naming distance would be a claim the code does not make.
 */
function areaLine(area: SkillArea): string {
  const cap = area.maxTargets === undefined ? 'enemies' : `up to ${amount(area.maxTargets)} enemies`;
  switch (area.shape) {
    case 'circle':
      return area.origin === 'caster'
        ? `Hits ${cap} within ${amount(area.radius)} of you.`
        : `Hits ${cap} within ${amount(area.radius)} of the target point.`;
    case 'cone':
      return `Hits ${cap} in a ${amount(area.angleDeg)}° cone, up to ${amount(area.range)} away.`;
    case 'line':
      return `Hits ${cap} in a line ${amount(area.range)} long and ${amount(area.width)} wide.`;
  }
}

/**
 * What a shot does on the way, where the row has a projectile.
 *
 * **Derived from `targeting`, deliberately not from `arc`.** The first draft of
 * this function read the arc, on the strength of the comment in
 * `data/abilities.ts` that a lobbed shot "flies over whatever is between the
 * archer and the body it named" and the two flavour lines that say the same.
 * `sim/world.ts` says the opposite in as many words -- *"`arcHeight` is a
 * *look*: whether the shot rises on its way. It buys nothing mechanical, so an
 * arrow and a star reach the same body at the same tick"* -- and
 * `projectileHits` is a flat 2D overlap with no height term in it at all.
 *
 * What actually decides whether a bystander can take the shot is whether it
 * **named** a body: a shot with a target id resolves against that body and
 * ignores everything else, and a shot thrown at a point takes the first hostile
 * thing it overlaps. That is the fact worth telling a player, and it is the one
 * the row can honestly support.
 *
 * Flight speed is omitted: `ProjectileSpec.speed` is the value *before*
 * `PROJECTILE_SPEED_SCALE`, so the number in the row is not the speed the shot
 * travels at and printing it would be worse than saying nothing.
 */
function travelLine(ability: AbilityDefinition): string {
  if (!ability.projectile) return '';
  return ability.targeting === 'unit'
    ? 'The shot follows the enemy it was aimed at, and passes anything else.'
    : 'The shot hits the first enemy in its path.';
}

/**
 * What happens to whoever the landing picked, in the row's own order.
 *
 * The order is load-bearing: `sim/skill-effects.ts` runs the list in the order
 * it is written, so Guard Break strips guard *before* its guard damage is
 * measured against the pool. Reordering the row is a balance change and the
 * description follows it rather than tidying it.
 */
function effectLines(ability: AbilityDefinition): readonly string[] {
  // A channel's damage is a cadence rather than a blow, and the row carries
  // both halves of it. Said here rather than in the damage case below, because
  // "deals 7 damage" about a channel is true of one pulse and false of the
  // ability.
  if (ability.kind === 'channel') {
    const out: string[] = [];
    if (ability.damage > 0 && ability.pulseIntervalTicks && ability.channelTicks) {
      out.push(
        `Deals ${amount(ability.damage)} damage every ` +
          `${formatSeconds(ability.pulseIntervalTicks)} for ` +
          `${formatSeconds(ability.channelTicks)}.`,
      );
    }
    out.push('Withdraw at any point to stop early.');
    return out;
  }

  if (ability.effects && ability.effects.length > 0) {
    const out: string[] = [];
    for (const effect of ability.effects) out.push(...effectLine(effect, ability));
    return out;
  }

  // No effect list is "the damage, as before", which is what every row written
  // before spec 188 means.
  const out: string[] = [];
  if (ability.damage > 0) out.push(`Deals ${amount(ability.damage)} damage.`);
  const healing = healLine(ability.healing ?? 0, ability.healingFraction ?? 0, true);
  if (healing) out.push(healing);
  return out;
}

/** One effect. Returns more than one line where the effect has a stacking rule. */
function effectLine(effect: SkillEffect, ability: AbilityDefinition): readonly string[] {
  const onCaster = subjectOf(effect) === 'caster';
  const who = onCaster ? 'you' : 'the target';

  switch (effect.kind) {
    case 'damage': {
      const base = effect.amount ?? ability.damage;
      const scaled = base * (effect.multiplier ?? 1);
      if (scaled <= 0) return [];
      return [`Deals ${amount(scaled)} damage.`];
    }

    case 'poiseDamage':
      return [`Deals ${amount(effect.amount)} ${GUARD_NAME} damage.`];

    case 'poise':
      // The pool written directly, which `sim/skill-effects.ts` is explicit
      // cannot break it -- so this is "removes" and never "breaks".
      return effect.amount < 0
        ? [`Removes ${amount(-effect.amount)} ${GUARD_NAME} from ${who}.`]
        : [`Restores ${amount(effect.amount)} ${GUARD_NAME} to ${who}.`];

    case 'stun':
      // Staggered, not stunned: one state, one word (the standard's §1.14).
      return [`Staggers ${who} for ${formatSeconds(effect.ticks)}.`];

    case 'applyStatus': {
      const visual = visualFor(effect.statusId);
      // A status with no row in `STATUS_VISUALS` is one the player is never
      // shown, so naming it in a description would name something they cannot
      // see. Omitted rather than printed as a raw id.
      if (!visual) return [];
      const out = [
        `Applies ${visual.name} to ${who} for ${formatSeconds(effect.durationTicks)}.`,
      ];
      const ceiling = effect.maxStacks ?? 1;
      if (ceiling > 1) out.push(`Stacks up to ${amount(ceiling)} times.`);
      return out;
    }

    case 'removeStatus': {
      const visual = visualFor(effect.statusId);
      if (!visual) return [];
      return [`Removes ${visual.name} from ${who}.`];
    }

    case 'heal': {
      const line = healLine(effect.amount ?? 0, effect.fraction ?? 0, onCaster || ability.targeting === 'self');
      return line ? [line] : [];
    }

    case 'resource':
      return effect.amount >= 0
        ? [`Restores ${amount(effect.amount)} ${RESOURCE_NAME} to ${who}.`]
        : [`Drains ${amount(-effect.amount)} ${RESOURCE_NAME} from ${who}.`];
  }
}

/**
 * A heal, flat or proportional or both.
 *
 * The two add rather than replace -- `applyEffects` sums them -- so a row that
 * carries both says both in one sentence rather than in two that read as two
 * heals.
 */
function healLine(flat: number, fraction: number, self: boolean): string {
  const parts: string[] = [];
  if (flat > 0) parts.push(amount(flat));
  if (fraction > 0) parts.push(`${percent(fraction)} of maximum health`);
  if (parts.length === 0) return '';
  return self ? `Heals you for ${joinList(parts)}.` : `Heals the target for ${joinList(parts)}.`;
}

/**
 * Everything the cast is priced in, in one sentence.
 *
 * One line rather than one per currency, because a player deciding whether they
 * can afford something is asking one question. Every one of them is refunded in
 * full by a withdrawal, which the standard states once rather than on each row.
 */
function costLine(ability: AbilityDefinition): string {
  const parts: string[] = [];
  if (ability.cost > 0) parts.push(`${amount(ability.cost)} ${RESOURCE_NAME}`);
  const extra = ability.costs;
  if (extra?.health) parts.push(`${amount(extra.health)} health`);
  if (extra?.poise) parts.push(`${amount(extra.poise)} ${GUARD_NAME}`);
  if (ability.chargeCost) {
    parts.push(
      ability.chargeCost === 1 ? '1 flask charge' : `${amount(ability.chargeCost)} flask charges`,
    );
  }
  if (parts.length === 0) return '';
  return `Costs ${joinList(parts)}.`;
}

/**
 * The spans the cast occupies.
 *
 * A basic attack's `cooldownTicks` is deliberately **not** shown. Its cadence
 * comes from Base Attack Time (spec 144), so printing the row's cooldown beside
 * it would tell a player that attack speed shortens a skill's cooldown -- the
 * one thing the standard's §1.6 exists to keep apart. The note takes its place.
 */
function timingLines(ability: AbilityDefinition): readonly string[] {
  const out: string[] = [];
  if (ability.windupTicks > 0) out.push(`Wind-up ${formatSeconds(ability.windupTicks)}.`);
  if (ability.backswingTicks && ability.backswingTicks > 0) {
    out.push(`Backswing ${formatSeconds(ability.backswingTicks)}.`);
  }
  if (!ability.basicAttack && ability.cooldownTicks > 0) {
    out.push(`Cooldown ${formatSeconds(ability.cooldownTicks)}.`);
  }
  return out;
}

/** The few rules a row carries that are not a number, a cost or a span. */
function noteLines(ability: AbilityDefinition): readonly string[] {
  const out: string[] = [];
  if (ability.basicAttack) {
    out.push('Swing rate comes from your attack speed, not a cooldown.');
  }
  if (ability.skill) {
    out.push('Cast from an equipped skill slot.');
  }
  if (ability.castAngleDeg !== undefined) {
    out.push(`Facing tolerance ${amount(ability.castAngleDeg)}°.`);
  }
  if (ability.chargeCost) {
    // Where charges come back is a real rule and the only one here that is not
    // in the row: `advanceRest` returns one at a time while a player is out of
    // combat and resting. It used to live in the flavour line, which is exactly
    // the drift the standard forbids, so it is stated by the presence of a
    // charge cost instead.
    out.push('Flask charges return one at a time while resting out of combat.');
  }
  return out;
}

// --- statuses -----------------------------------------------------------

/**
 * The Technical Description for one status.
 *
 * The one place the writer reads an authored string as a *mechanical* line, and
 * the reason is stated in the header: a `StatusVisual` genuinely does not know
 * what its condition does. Everything around it -- the stacking rule, the
 * refresh rule, whether a count is shown -- is derived from the row.
 */
export function describeStatus(visual: StatusVisual): TechnicalDescription {
  const lines: TechnicalLine[] = [
    { tone: 'effect', text: visual.effect },
    {
      tone: 'note',
      text: visual.kind === 'boon' ? 'Beneficial.' : 'Harmful.',
    },
  ];

  // Every status in this game refreshes its duration when re-applied, and takes
  // the larger of the two magnitudes. Stated on the ones where a reader could
  // expect otherwise, which is all of them: a stacking status because the
  // ceiling matters, and a non-stacking one because "does not stack" without
  // "refreshes" reads as "a second application does nothing".
  //
  // An indefinite status has no duration to refresh, so it says so instead.
  // Saying "refreshes the duration" about Prepared -- which is applied with an
  // effectively infinite window and ends by being *spent* -- would describe a
  // clock that does not exist.
  const stacking = visual.maxStacks > 1 ? `Stacks up to ${amount(visual.maxStacks)} times.` : 'Does not stack.';
  const clock = visual.indefinite ? 'Lasts until it is spent.' : 'Refreshes the duration.';
  lines.push({ tone: 'note', text: `${stacking} ${clock}` });

  return { name: visual.name, lines, flavor: null };
}

/**
 * The mechanical block as plain text, one line each.
 *
 * The flavour is **not** included, which is the point of it being a separate
 * field: a caller that wants both puts them in two places with two styles, and
 * a caller that wants the rules gets only the rules.
 */
export function technicalText(described: TechnicalDescription): string {
  return described.lines.map((line) => line.text).join('\n');
}
