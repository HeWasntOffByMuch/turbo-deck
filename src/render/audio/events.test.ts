/**
 * The vocabulary, and the two tables that already owned half of it (spec 229).
 *
 * The event set is code, so a typo at a gameplay call site is a build error --
 * which covers every id this framework chose and **none** of the ids it did not.
 * Those are what this file is for, and each of them fails the same way: the
 * sound stops happening and nothing anywhere says so.
 *
 * - The four loot cues are `RARITIES[].cues` (server/data/loot.ts) character for
 *   character, because spec 158 wrote them as *names* for the renderer to
 *   interpret and then had nothing to hand them to. A name with no row is a tier
 *   that reveals in silence; a row no rarity names is a sound nobody can reach.
 *   Both directions, for the reason `SHOT_ART`'s pair of assertions gives.
 * - The seven affliction beats are `ALL_DOTS`
 *   (server/data/damage-over-time.ts) spelled into ids. An eighth affliction is
 *   a beat with no sound, and a renamed one is a sound with no beat.
 * - `soundEventSections` is the SFX tab's whole outline and what the gap report
 *   counts. A row that falls out of it is a row nobody can assign a file to --
 *   which looks exactly like a sound nobody has got round to yet.
 */

import { describe, expect, it } from 'vitest';
import {
  BUSES,
  BUS_LABELS,
  isSoundEventId,
  soundEvent,
  soundEventSections,
  SOUND_EVENTS,
  SOUND_EVENT_IDS,
} from './events.js';
import { UI_SOUNDS } from '../../ui/core/sound.js';
import { RARITIES } from '../../server/data/loot.js';
import { ALL_DOTS, dotById } from '../../server/data/damage-over-time.js';

/** Ids that look like they belong and do not. The near misses are the point. */
const STRANGERS = [
  '',
  'combat',
  'combat.hit',
  'combat.hit.Flesh',
  'combat.hit.wood',
  // The tier with no reveal at all: plausible enough to be typed by somebody
  // filling in the set, and correctly absent (spec 158).
  'loot.reveal.common',
  'ui.tooltip',
];

describe('the vocabulary', () => {
  it('names every event exactly once', () => {
    // A duplicate id is not a build error -- the union swallows it -- and the
    // second row is simply unreachable through `soundEvent`, which is the tab
    // showing a sound that can never be assigned a file.
    expect([...new Set(SOUND_EVENT_IDS)].length).toBe(SOUND_EVENT_IDS.length);
  });

  it('publishes its ids in the order the table declares them', () => {
    // The table is the outline: there is no second list deciding what comes
    // before what, and this is what says so.
    expect([...SOUND_EVENT_IDS]).toEqual(SOUND_EVENTS.map((event) => event.id));
  });

  it('answers for its own ids and refuses every other string', () => {
    for (const id of SOUND_EVENT_IDS) {
      expect(isSoundEventId(id)).toBe(true);
      expect(soundEvent(id)?.id).toBe(id);
    }
    for (const stranger of STRANGERS) {
      expect(isSoundEventId(stranger)).toBe(false);
      expect(soundEvent(stranger)).toBeNull();
    }
  });

  it('has the two answer the same question', () => {
    // Two lookups over one map, and a catalog parser asks one while the engine
    // asks the other -- a guard that says yes to something the lookup returns
    // null for is a crash at the moment a sound plays.
    for (const id of [...SOUND_EVENT_IDS, ...STRANGERS]) {
      expect(isSoundEventId(id)).toBe(soundEvent(id) !== null);
    }
  });

  it('calls every bus something a player can read', () => {
    for (const bus of BUSES) {
      expect(BUS_LABELS[bus].length).toBeGreaterThan(0);
    }
    // And nothing is labelled that is not a bus: the mixer draws one row per
    // label, and a stale one is a slider wired to nothing.
    expect([...Object.keys(BUS_LABELS)].sort()).toEqual([...BUSES].sort());
  });

  it('files every event on a bus that exists', () => {
    const buses = new Set<string>(BUSES);
    for (const event of SOUND_EVENTS) expect(buses.has(event.bus)).toBe(true);
  });
});

describe('the outline the tab draws', () => {
  it('contains every event exactly once', () => {
    const listed = soundEventSections().flatMap((group) => group.events.map((event) => event.id));
    // Length as well as membership: a row that landed in two groups is a file
    // assigned twice and a gap report that cannot add up.
    expect(listed.length).toBe(SOUND_EVENT_IDS.length);
    expect([...listed].sort()).toEqual([...SOUND_EVENT_IDS].sort());
  });

  it('walks the buses in the order BUSES declares them', () => {
    const order: string[] = [];
    for (const group of soundEventSections()) {
      if (order[order.length - 1] !== group.bus) order.push(group.bus);
    }
    // Not "each bus appears somewhere": every bus contiguous and in the mixer's
    // own order, so the tree and the sliders read top to bottom the same way.
    expect(order).toEqual([...BUSES]);
  });

  it('keeps a bus’s sections in first-appearance order', () => {
    for (const bus of BUSES) {
      const declared: string[] = [];
      for (const event of SOUND_EVENTS) {
        if (event.bus === bus && !declared.includes(event.section)) declared.push(event.section);
      }
      const grouped = soundEventSections()
        .filter((group) => group.bus === bus)
        .map((group) => group.section);
      expect(grouped).toEqual(declared);
    }
  });

  it('files a section once even when the table comes back to it', () => {
    // Rows are not required to be contiguous by section, and a grouper that only
    // closed the current run would draw two folders with the same name -- half
    // the sounds in each, and no way to tell from the tree which half.
    const keys = soundEventSections().map((group) => `${group.bus}/${group.section}`);
    expect([...new Set(keys)].length).toBe(keys.length);
  });

  it('keeps the rows of a section in table order', () => {
    for (const group of soundEventSections()) {
      const declared = SOUND_EVENTS.filter(
        (event) => event.bus === group.bus && event.section === group.section,
      ).map((event) => event.id);
      expect(group.events.map((event) => event.id)).toEqual(declared);
    }
  });
});

describe('the loot cues, whose names are not ours to choose', () => {
  const cueNames = [...RARITIES.values()].flatMap((row) => [
    row.cues.spawn,
    row.cues.anticipation,
    row.cues.reveal,
  ]);

  it('has a row for every cue name a rarity actually fires', () => {
    // `playCue` looks the name up and an unknown one is silence -- the same
    // shrug `vfx.system.has(cue)` gives on the picture half, and the reason a
    // rename in loot.ts has to fail here rather than in a playtest.
    const fired = cueNames.filter((name) => name !== '');
    expect(fired.length).toBeGreaterThan(0);
    for (const name of fired) expect(isSoundEventId(name)).toBe(true);
  });

  it('has no loot row that nothing fires', () => {
    // The other direction: a cue authored, assigned a file in the tab, and
    // reached by no tier at all -- which is the state the painted explosion sat
    // in for eighty specs.
    const named = new Set(cueNames);
    for (const id of SOUND_EVENT_IDS) {
      if (id.startsWith('loot.')) expect(named.has(id)).toBe(true);
    }
  });

  it('leaves a tier with no cue name silent rather than falling back', () => {
    // Common has an empty `anticipation` and an empty `reveal`, and empty is not
    // an id: a lookup that treated it as one would put a sound on the tier whose
    // whole design is that nothing happens to it.
    expect(isSoundEventId('')).toBe(false);
    expect(soundEvent('')).toBeNull();
  });
});

describe('the affliction beats', () => {
  it('has one for every affliction the sim can apply', () => {
    for (const dot of ALL_DOTS) {
      expect(isSoundEventId(`affliction.${dot.id}.tick`)).toBe(true);
    }
  });

  it('has none for an affliction that does not exist', () => {
    // The direction a rename breaks: `affliction.rot.tick` keeps working as an
    // id and stops corresponding to anything the sim ever pulses.
    for (const id of SOUND_EVENT_IDS) {
      if (!id.startsWith('affliction.')) continue;
      const dot = id.split('.')[1] ?? '';
      expect(dotById(dot)).not.toBeNull();
    }
  });
});

describe('the interface vocabulary', () => {
  /**
   * Every `UiSoundId` names a row here.
   *
   * `src/ui/` may not import the renderer, so `UiSoundId` (spec 133) and
   * `SoundEventId` (spec 229) are two declarations of an overlapping set -- and
   * the bridge in `view.ts` is a plain hand-off with no mapping table between
   * them. A widget id with no row would emit into the engine and be dropped in
   * silence: the button would work, the sound would not, and nothing anywhere
   * would say so. This is the one place both halves can be imported, so it is
   * the only place the relation can be checked.
   */
  it('is a subset of the game\'s', () => {
    for (const id of UI_SOUNDS) expect(isSoundEventId(id)).toBe(true);
  });

  /**
   * ...and every one of them is on the `ui` bus.
   *
   * Not a tautology: the bus is declared per row here and the id is declared
   * over there, so a `ui.press` filed under `combat` would follow the combat
   * slider. Which is a bug nobody would report as one -- they would say the
   * interface got quiet during fights.
   */
  it('is entirely on the ui bus', () => {
    for (const id of UI_SOUNDS) expect(soundEvent(id)?.bus).toBe('ui');
  });
});
