/**
 * The Technical Description standard, as assertions (spec 191).
 *
 * These are the invariants `docs/mechanics-vocabulary.md` states in prose. The
 * point of having them here is that a standard nothing checks is a style guide,
 * and a style guide is what the ability table already had: eleven `description`
 * strings in three different registers, two of which were factually wrong.
 */

import { describe, expect, it } from 'vitest';
import { ALL_ABILITIES, abilityById } from './abilities.js';
import { ALL_ITEMS } from './items.js';
import { STATUS_VISUALS } from './status-visuals.js';
import { ALL_DOTS, dotById, dotPulseDamage } from './damage-over-time.js';
import { ALL_SKILLS } from './skills.js';
import {
  GRANT_LABELS,
  describeAbility,
  describeStatSkill,
  describeStatus,
  formatSeconds,
  grantsOf,
  technicalText,
} from './description.js';

const SECONDS = 60;

/** Every description the game can produce, so a rule can be asserted over all of them. */
function everyDescription(): readonly { readonly what: string; readonly text: string }[] {
  return [
    ...ALL_ABILITIES.map((ability) => ({
      what: ability.id,
      text: technicalText(describeAbility(ability)),
    })),
    ...STATUS_VISUALS.map((visual) => ({
      what: visual.id,
      text: technicalText(describeStatus(visual)),
    })),
    // Both readings of every stat skill: the rate a fresh row states, and the
    // total a held one does. They are different strings and both are shown.
    ...ALL_SKILLS.map((skill) => ({
      what: `${skill.id}@0`,
      text: technicalText(describeStatSkill(skill, 0)),
    })),
    ...ALL_SKILLS.map((skill) => ({
      what: `${skill.id}@max`,
      text: technicalText(describeStatSkill(skill, skill.maxLevel)),
    })),
  ];
}

describe('the writer is total', () => {
  it('produces at least one line for every ability and every status', () => {
    for (const ability of ALL_ABILITIES) {
      expect(describeAbility(ability).lines.length, ability.id).toBeGreaterThan(0);
    }
    for (const visual of STATUS_VISUALS) {
      expect(describeStatus(visual).lines.length, visual.id).toBeGreaterThan(0);
    }
  });

  it('never emits an empty line', () => {
    for (const ability of ALL_ABILITIES) {
      for (const line of describeAbility(ability).lines) {
        expect(line.text.trim(), ability.id).not.toBe('');
      }
    }
  });

  it('never leaks a raw id, a tick count or an undefined', () => {
    for (const { what, text } of everyDescription()) {
      expect(text, what).not.toMatch(/undefined|NaN|\[object/);
      expect(text, what).not.toMatch(/\bticks?\b/i);
      // An internal id has a dot in it and no space around it: `melee.slash`.
      expect(text, what).not.toMatch(/\b[a-z]+\.[a-zA-Z]+\b/);
      // The internal name for the Guard pool must never reach a player.
      expect(text, what).not.toMatch(/\bpoise\b/i);
    }
  });
});

describe('grammar conformance', () => {
  it('ends every line in a full stop', () => {
    for (const ability of ALL_ABILITIES) {
      for (const line of describeAbility(ability).lines) {
        expect(line.text.endsWith('.'), `${ability.id}: ${line.text}`).toBe(true);
      }
    }
  });

  it('writes every duration as seconds with at most two decimals', () => {
    for (const { what, text } of everyDescription()) {
      for (const match of text.matchAll(/(\d+(?:\.\d+)?)s\b/g)) {
        const decimals = (match[1] ?? '').split('.')[1] ?? '';
        expect(decimals.length, `${what}: ${match[0]}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('writes every percentage to at most one decimal, trimmed', () => {
    // The standard said *integer* until the skill tree was run through it, and
    // Lightfoot's `armor: 0.008` broke it honestly: 0.8% rounded to an integer
    // is 1%, which overstates it by a quarter. Accuracy outranks consistency in
    // this document's own priority order, so the rule moved rather than the
    // number -- and it moved to what the item tooltip has always done.
    for (const { what, text } of everyDescription()) {
      for (const match of text.matchAll(/(\d+(?:\.\d+)?)%/g)) {
        const decimals = (match[1] ?? '').split('.')[1] ?? '';
        expect(decimals.length, `${what}: ${match[0]}`).toBeLessThanOrEqual(1);
        expect(decimals, `${what}: ${match[0]} has a trailing zero`).not.toBe('0');
      }
    }
  });

  it('uses none of the banned synonyms', () => {
    // The document's §1 "do not use" lists, as one regex. Each of these is a
    // word some other game uses for a thing this game already has a word for.
    const banned =
      /\b(buff|debuff|DoT|HoT|proc|procs|CC|crowd control|mana|energy|stamina|hitpoints?|HP|DPS|AoE|cleanse|dispel|purge|stun(?:s|ned|ning)?|knockdown|daze)\b/i;
    for (const { what, text } of everyDescription()) {
      const hit = banned.exec(text);
      expect(hit?.[0] ?? null, `${what}: ${text}`).toBeNull();
    }
  });

  it('never describes a target cap as the nearest', () => {
    // `sim/skill-area.ts` picks in candidate order, not by distance.
    for (const { what, text } of everyDescription()) {
      expect(text, what).not.toMatch(/nearest|closest/i);
    }
  });
});

describe('derived numbers match the row they came from', () => {
  it('states the damage, range, cost and cooldown each row carries', () => {
    for (const ability of ALL_ABILITIES) {
      const text = technicalText(describeAbility(ability));

      if (ability.range > 0) expect(text, ability.id).toContain(`Range ${String(ability.range)}.`);
      if (ability.cost > 0) {
        expect(text, ability.id).toContain(`${String(ability.cost)} Resource`);
      }
      // A basic attack's cadence is Base Attack Time, so its row cooldown is
      // deliberately not shown -- see the standard's §1.6.
      if (!ability.basicAttack && ability.cooldownTicks > 0) {
        expect(text, ability.id).toContain(`Cooldown ${formatSeconds(ability.cooldownTicks)}.`);
      }
      if (ability.windupTicks > 0) {
        expect(text, ability.id).toContain(`Wind-up ${formatSeconds(ability.windupTicks)}.`);
      }
    }
  });

  it('never shows a cooldown for a basic attack', () => {
    for (const ability of ALL_ABILITIES) {
      if (!ability.basicAttack) continue;
      expect(technicalText(describeAbility(ability)), ability.id).not.toContain('Cooldown');
    }
  });

  it('follows a retune without being edited', () => {
    const slash = abilityById('melee.slash');
    expect(slash).not.toBeNull();
    if (!slash) return;
    const louder = { ...slash, damage: 99, range: 123 };
    const text = technicalText(describeAbility(louder));
    expect(text).toContain('Deals 99 damage.');
    expect(text).toContain('Range 123.');
  });

  it('converts ticks to seconds', () => {
    expect(formatSeconds(SECONDS)).toBe('1s');
    expect(formatSeconds(SECONDS * 2.5)).toBe('2.5s');
    // 0.35s is 21 ticks, which one decimal place would report as 0.4s.
    expect(formatSeconds(21)).toBe('0.35s');
  });
});

describe('effects are described in the row order', () => {
  it('puts Guard Break’s strip before its damage', () => {
    const ability = abilityById('skill.guardBreak');
    expect(ability).not.toBeNull();
    if (!ability) return;
    const text = technicalText(describeAbility(ability));
    const strip = text.indexOf('Removes 50 Guard');
    const guardDamage = text.indexOf('25 Guard damage');
    const damage = text.indexOf('Deals 12 damage');
    expect(strip).toBeGreaterThanOrEqual(0);
    expect(guardDamage).toBeGreaterThan(strip);
    expect(damage).toBeGreaterThan(guardDamage);
  });

  it('names the status a skill applies, with its duration', () => {
    const ability = abilityById('skill.cripplingStrike');
    expect(ability).not.toBeNull();
    if (!ability) return;
    expect(technicalText(describeAbility(ability))).toContain(
      'Applies Slowed to the target for 2.5s.',
    );
  });

  it('calls a stun a Stagger, because that is the state the sim enters', () => {
    const ability = abilityById('skill.stunningBlow');
    expect(ability).not.toBeNull();
    if (!ability) return;
    expect(technicalText(describeAbility(ability))).toContain('Staggers the target for 1.4s.');
  });

  it('writes a channel as a cadence rather than as one blow', () => {
    const ability = abilityById('channel.drain');
    expect(ability).not.toBeNull();
    if (!ability) return;
    expect(technicalText(describeAbility(ability))).toContain(
      'Deals 7 damage every 0.25s for 2s.',
    );
  });
});

describe('nothing is invented', () => {
  it('adds no effect line beyond damage for a row with no effects', () => {
    const ability = abilityById('melee.heavy');
    expect(ability).not.toBeNull();
    if (!ability) return;
    const effects = describeAbility(ability).lines.filter((line) => line.tone === 'effect');
    expect(effects).toHaveLength(1);
    expect(effects[0]?.text).toBe('Deals 42 damage.');
  });

  it('adds no facing line for a row with no cast angle', () => {
    for (const ability of ALL_ABILITIES) {
      if (ability.castAngleDeg !== undefined) continue;
      expect(technicalText(describeAbility(ability)), ability.id).not.toContain('Facing tolerance');
    }
  });

  it('adds no target-count line for a row with no area', () => {
    for (const ability of ALL_ABILITIES) {
      if (ability.area !== undefined) continue;
      expect(technicalText(describeAbility(ability)), ability.id).not.toMatch(/up to \d+ enemies/);
    }
  });

  it('never claims an arc blocks or unblocks anything', () => {
    // `sim/world.ts`: "`arcHeight` is a *look* ... It buys nothing mechanical."
    for (const ability of ALL_ABILITIES) {
      if (!ability.projectile) continue;
      const text = technicalText(describeAbility(ability));
      expect(text, ability.id).not.toMatch(/arc|lob|over anything|unblockable/i);
    }
  });
});

describe('flavour is separated', () => {
  it('keeps the authored description out of the mechanical lines', () => {
    for (const ability of ALL_ABILITIES) {
      const described = describeAbility(ability);
      expect(described.flavor, ability.id).toBe(ability.description);
      for (const line of described.lines) {
        expect(line.text, ability.id).not.toBe(ability.description);
      }
      expect(technicalText(described), ability.id).not.toContain(ability.description);
    }
  });

  it('gives a status no flavour at all', () => {
    for (const visual of STATUS_VISUALS) {
      expect(describeStatus(visual).flavor, visual.id).toBeNull();
    }
  });
});

describe('statuses', () => {
  it('marks which way each one cuts', () => {
    for (const visual of STATUS_VISUALS) {
      const text = technicalText(describeStatus(visual));
      expect(text, visual.id).toContain(visual.kind === 'boon' ? 'Beneficial.' : 'Harmful.');
    }
  });

  it('states a stack ceiling only where one can be reached', () => {
    for (const visual of STATUS_VISUALS) {
      const text = technicalText(describeStatus(visual));
      if (visual.maxStacks > 1) {
        expect(text, visual.id).toContain(`Stacks up to ${String(visual.maxStacks)} times.`);
      } else {
        expect(text, visual.id).toContain('Does not stack.');
      }
    }
  });

  it('never promises a refresh for a status with no duration', () => {
    for (const visual of STATUS_VISUALS) {
      if (!visual.indefinite) continue;
      const text = technicalText(describeStatus(visual));
      expect(text, visual.id).not.toContain('Refreshes the duration.');
      expect(text, visual.id).toContain('Lasts until it is spent.');
    }
  });
});

describe('sigils', () => {
  it('carries no numbers of its own: every sigil names a real skill', () => {
    for (const item of ALL_ITEMS) {
      if (item.activeSkillId === undefined) continue;
      const ability = abilityById(item.activeSkillId);
      expect(ability, item.id).not.toBeNull();
      expect(ability?.skill, item.id).toBe(true);
      // The item table deliberately holds no damage, cooldown or cost for a
      // sigil -- a second copy would be a second place to retune.
      expect(Object.keys(item.modifiers), item.id).toHaveLength(0);
    }
  });
});

describe('the passive skill tree (spec 191)', () => {
  it('describes every row with at least its requirement and its trigger', () => {
    for (const skill of ALL_SKILLS) {
      const lines = describeStatSkill(skill, 0).lines;
      expect(lines.length, skill.id).toBeGreaterThanOrEqual(2);
      const text = lines.map((line) => line.text).join('\n');
      expect(text, skill.id).toContain('Requires ');
      expect(text, skill.id).toMatch(/Trigger: |Always active\./);
    }
  });

  it('states a number for every row that grants one', () => {
    // The gap this closes. Before it, the sheet showed the authored sentence
    // and the trigger, and a player could not read a single figure off any of
    // the thirty-six rows.
    for (const skill of ALL_SKILLS) {
      if (grantsOf(skill.perLevel).length === 0) continue;
      const text = technicalText(describeStatSkill(skill, 0));
      expect(text, skill.id).toMatch(/[+-]\d/);
    }
  });

  it('scales the total with the level held, and keeps the rate beside it', () => {
    const crushing = ALL_SKILLS.find((skill) => skill.id === 'str.crushingBlows');
    expect(crushing).toBeDefined();
    if (!crushing) return;
    expect(technicalText(describeStatSkill(crushing, 0))).toContain('+18% Guard damage per level.');
    expect(technicalText(describeStatSkill(crushing, 2))).toContain(
      '+36% Guard damage (+18% per level).',
    );
    // One rank is the rate, so the parenthesis would say the same thing twice.
    expect(technicalText(describeStatSkill(crushing, 1))).toContain('+18% Guard damage.');
    expect(technicalText(describeStatSkill(crushing, 1))).not.toContain('per level');
  });

  it('clamps the level to what the row can actually hold', () => {
    const crushing = ALL_SKILLS.find((skill) => skill.id === 'str.crushingBlows');
    expect(crushing).toBeDefined();
    if (!crushing) return;
    expect(technicalText(describeStatSkill(crushing, 99))).toBe(
      technicalText(describeStatSkill(crushing, crushing.maxLevel)),
    );
  });

  it('skips a socket rather than claiming an effect', () => {
    // A zero in `perLevel` is a documented "this row is about that trait" whose
    // magnitude comes from a milestone or a synergy. Catalysis authors
    // `appliesSundered: 0`, which reaches nothing, and Opening Read authors
    // `vulnerableWeakPointFactor: 0`. Neither may produce a line.
    for (const skill of ALL_SKILLS) {
      expect(technicalText(describeStatSkill(skill, 0)), skill.id).not.toMatch(/[+-]0[^.\d]/);
    }
    const catalysis = ALL_SKILLS.find((skill) => skill.id === 'int.catalysis');
    expect(catalysis).toBeDefined();
    if (!catalysis) return;
    expect(grantsOf(catalysis.perLevel)).toHaveLength(1);
  });

  it('never appends a rate to a flag', () => {
    // Unstoppable grants `poiseArmorAllCasts: 1`, which is on or off. "Guard
    // protection covers every cast per level" is what happens when a flag is
    // run through the same path as a quantity.
    const unstoppable = ALL_SKILLS.find((skill) => skill.id === 'str.unstoppable');
    expect(unstoppable).toBeDefined();
    if (!unstoppable) return;
    const text = technicalText(describeStatSkill(unstoppable, 1));
    expect(text).toContain('Guard protection covers every cast, not only attacks.');
    expect(text).not.toContain('attacks per level');
  });

  it('reads a reduction as a reduction', () => {
    // `backswingReduction: 0.1` is a positive number meaning *less* backswing.
    // Named as the quantity rather than as the reduction, the line said the
    // opposite of what the trait does.
    const quick = ALL_SKILLS.find((skill) => skill.id === 'agi.quickRecovery');
    expect(quick).toBeDefined();
    if (!quick) return;
    expect(technicalText(describeStatSkill(quick, 0))).toContain('+10% Backswing reduction');
  });

  it('marks a premium as bad and a benefit as good', () => {
    const shaping = ALL_SKILLS.find((skill) => skill.id === 'int.shaping');
    expect(shaping).toBeDefined();
    if (!shaping) return;
    const grants = grantsOf(shaping.perLevel);
    const cost = grants.find((grant) => grant.text.includes('Cost of shaped abilities'));
    const radius = grants.find((grant) => grant.text.includes('radius'));
    expect(cost?.good).toBe(false);
    expect(radius?.good).toBe(true);
  });

  it('keeps the flavour out of the mechanical lines', () => {
    for (const skill of ALL_SKILLS) {
      const described = describeStatSkill(skill, 1);
      expect(described.flavor, skill.id).toBe(skill.description);
      expect(technicalText(described), skill.id).not.toContain(skill.description);
    }
  });

  it('reports which granted fields still have no label', () => {
    // The safe default made measurable. A field with no row draws no line, so
    // an unlabelled trait is a silent gap rather than a wrong sentence -- and
    // this is the thing that stops it staying silent.
    const labelled = new Set(GRANT_LABELS.map((label) => `${label.where}:${label.key}`));
    const missing = new Set<string>();
    for (const skill of ALL_SKILLS) {
      const modifier = skill.perLevel as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(modifier)) {
        if (key === 'traits' || value === 0) continue;
        if (!labelled.has(`stat:${key}`)) missing.add(`stat:${key}`);
      }
      const traits = (modifier['traits'] ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(traits)) {
        if (value === 0) continue;
        if (!labelled.has(`trait:${key}`)) missing.add(`trait:${key}`);
      }
    }
    // The three that cannot be turned into a signed quantity reading correctly
    // in English, each left to its row's authored sentence on purpose:
    // `juggernautBelow` is a health threshold, `masteryRelief` is a count that
    // *lowers* a requirement, and `overflowHealthPerResource` is a price the
    // skill charges for a benefit.
    expect([...missing].sort()).toEqual([
      'trait:juggernautBelow',
      'trait:masteryRelief',
      'trait:overflowHealthPerResource',
    ]);
  });
});

describe('afflictions are derived, never authored (spec 190)', () => {
  it('gives every row exactly one source for what it does', () => {
    // The rule the whole file rests on, as a check rather than a habit: an
    // affliction *is* its row in `data/damage-over-time.ts`, so authoring a
    // sentence beside it would be a second copy of `damagePerSecond` with
    // nothing keeping it true -- and a row with neither source says nothing.
    for (const visual of STATUS_VISUALS) {
      const derived = dotById(visual.id) !== null;
      const authored = visual.effect !== undefined;
      expect(derived !== authored, `${visual.id}: derived=${String(derived)} authored=${String(authored)}`).toBe(true);
    }
  });

  it('states each affliction’s rate, cadence and count off its own row', () => {
    for (const dot of ALL_DOTS) {
      const visual = STATUS_VISUALS.find((row) => row.id === dot.id);
      expect(visual, dot.id).toBeDefined();
      if (!visual) continue;
      const text = technicalText(describeStatus(visual));
      expect(text, dot.id).toContain(`Deals ${String(Math.round(dotPulseDamage(dot) * 100) / 100)} damage`);
      expect(text, dot.id).toContain(`${String(dot.pulses)} times`);
    }
  });

  it('never reports the expiry guard as a designed duration', () => {
    // `dotDurationTicks` is `pulses * interval + 1`, and that one tick is slack
    // so the last pulse lands inside `statusOf`'s comparison. Reported as-is it
    // reads "over 4.02s", which is an implementation detail in front of a player.
    for (const dot of ALL_DOTS) {
      const visual = STATUS_VISUALS.find((row) => row.id === dot.id);
      if (!visual) continue;
      const text = technicalText(describeStatus(visual));
      expect(text, dot.id).toContain(`over ${formatSeconds(dot.pulses * dot.intervalTicks)}`);
    }
  });

  it('names an affliction a skill applies without restating its numbers', () => {
    // `applyDot` carries one field -- the row *is* the affliction, whole -- so a
    // skill that lands one names it and claims none of its numbers.
    for (const ability of ALL_ABILITIES) {
      for (const effect of ability.effects ?? []) {
        if (effect.kind !== 'applyDot') continue;
        const dot = dotById(effect.dotId);
        expect(dot, `${ability.id} names ${effect.dotId}`).not.toBeNull();
        if (!dot) continue;
        const text = technicalText(describeAbility(ability));
        expect(text, ability.id).toContain(`Applies ${dot.name}`);
      }
    }
  });
});
