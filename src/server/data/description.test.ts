/**
 * The Technical Description standard, as assertions (spec 189).
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
import { describeAbility, describeStatus, formatSeconds, technicalText } from './description.js';

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

  it('writes every percentage as an integer', () => {
    for (const { what, text } of everyDescription()) {
      for (const match of text.matchAll(/(\d+(?:\.\d+)?)%/g)) {
        expect(match[1], `${what}: ${match[0]}`).not.toContain('.');
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
