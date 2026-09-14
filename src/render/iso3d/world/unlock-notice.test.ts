import { describe, expect, it } from 'vitest';
import { UnlockWatch, type ProgressionReading } from './unlock-notice.js';
import { startingBaseStats } from '../../../server/player/attributes.js';
import type { BaseStats, SpecializationAllocation } from '../../../server/state/types.js';

function reading(
  attributes: Partial<BaseStats> = {},
  specializations: readonly SpecializationAllocation[] = [],
): ProgressionReading {
  return { attributes: { ...startingBaseStats(), ...attributes }, specializations };
}

describe('UnlockWatch (spec 283)', () => {
  it('says nothing about the first reading', () => {
    // A `Stats` carries a whole character. Reporting on the first one throws a
    // session's worth of unlocks at somebody who has just logged in, which is
    // the trap `xp-gain.ts` records falling into with experience.
    const watch = new UnlockWatch();
    expect(watch.observe(reading({ strength: 50 }))).toHaveLength(0);
  });

  it('reports a node opening, which is the one that happens at level one', () => {
    // Five points takes an attribute from 5 to 10, and a fresh character holds
    // six. This is the first thing that ever happens to anybody.
    const watch = new UnlockWatch();
    watch.observe(reading());
    const found = watch.observe(reading({ perception: 10 }));
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('threshold');
    expect(found[0]?.id).toBe('node:perception:10');
    // It names what can now be bought rather than describing it: the sheet
    // draws both rows properly, with their tiers and their costs.
    const text = found.flatMap((u) => u.lines.map((l) => l.text)).join(' | ');
    expect(text).toContain('Weak-Point Study');
    expect(text).toContain('Opening Read');
  });

  it('reports every node a single jump passes, in order', () => {
    // An admin grant or a level's worth of points spent at once crosses more
    // than one. Reporting only the last would silently drop a milestone.
    const watch = new UnlockWatch();
    watch.observe(reading());
    const found = watch.observe(reading({ strength: 25 }));
    expect(found.map((u) => u.id)).toEqual([
      'node:strength:10',
      'milestone:str.crushing',
      'node:strength:25',
    ]);
  });

  it('prefers the milestone where a node carries both', () => {
    // Constitution's three mastery rows sit on the Overflow Vitality milestone's
    // own threshold (spec 273). One notice, and the thing that fired on its own
    // is the more surprising half.
    const watch = new UnlockWatch();
    watch.observe(reading({ constitution: 49 }));
    const found = watch.observe(reading({ constitution: 50 }));
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('milestone');
    expect(found[0]?.id).toBe('milestone:con.overflowVitality');
  });

  it('reports a capability tier and stays silent for a numeric one', () => {
    // The test is `grantsOf`'s own `whole` flag rather than a list of ids:
    // Conservation grants `grantsAttuned`, which `GRANT_LABELS` marks a flag,
    // and Crushing Blows grants a percentage.
    const watch = new UnlockWatch();
    watch.observe(reading());
    expect(
      watch.observe(reading({}, [{ specializationId: 'str.crushingBlows', tier: 1 }])),
    ).toHaveLength(0);
    const found = watch.observe(reading({}, [
      { specializationId: 'str.crushingBlows', tier: 1 },
      { specializationId: 'wis.conservation', tier: 1 },
    ]));
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe('spec:wis.conservation');
    expect(found[0]?.kind).toBe('capability');
  });

  it('reports a capability only on the tier that turns it on', () => {
    const watch = new UnlockWatch();
    watch.observe(reading({}, [{ specializationId: 'int.weaving', tier: 1 }]));
    expect(
      watch.observe(reading({}, [{ specializationId: 'int.weaving', tier: 2 }])),
    ).toHaveLength(0);
  });

  it('re-baselines silently when progression moves backwards', () => {
    // A respec is not a reward. Leaving the old baseline would swallow every
    // real unlock until the character had climbed back to where it was, which
    // is exactly the bug `XpGains` records fixing on the same shape.
    const watch = new UnlockWatch();
    watch.observe(reading({ agility: 25 }));
    expect(watch.observe(reading({ agility: 5 }))).toHaveLength(0);
  });

  it('never reports the same unlock twice', () => {
    // A `Stats` arrives on login, on every equip, on every spend and on every
    // level. Without this, putting a hat on re-announces the whole tree.
    const watch = new UnlockWatch();
    watch.observe(reading());
    expect(watch.observe(reading({ wisdom: 10 }))).toHaveLength(1);
    watch.observe(reading({ wisdom: 5 }));
    expect(watch.observe(reading({ wisdom: 10 }))).toHaveLength(0);
  });

  it('honours what a previous session already showed', () => {
    const watch = new UnlockWatch(['node:perception:10']);
    watch.observe(reading());
    expect(watch.observe(reading({ perception: 10 }))).toHaveLength(0);
    expect(watch.seen).toContain('node:perception:10');
  });

  it('keys on ids a rename cannot move', () => {
    // The seen list outlives a build. An id derived from a name or an index
    // would re-show every notice the first time a row was retitled or the
    // authoring order changed.
    const watch = new UnlockWatch();
    watch.observe(reading());
    const ids = watch.observe(reading({ intelligence: 20 }, [
      { specializationId: 'per.openingRead', tier: 1 },
    ])).map((u) => u.id);
    expect(ids).toContain('node:intelligence:10');
    expect(ids).toContain('milestone:int.shaping');
    expect(ids).toContain('spec:per.openingRead');
  });
});
