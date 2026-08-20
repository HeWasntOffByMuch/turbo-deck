/**
 * The half of spec 190's content join that lives on this side of the fence.
 *
 * `src/server/data/afflictions-content.test.ts` asserts everything about an
 * affliction that can be answered inside the deterministic core -- the id, the
 * mark, the wire index, the sigil, the derived numbers. The two questions it
 * cannot ask are the two that need the renderer's own tables, and eslint
 * refuses it the import rather than trusting anybody to remember: the sim never
 * imports the renderer.
 *
 * So the joins that cross the fence are asserted from here, pointing the other
 * way, which is the direction the dependency already runs.
 *
 * Both are the same failure in two places. A `StatusVisual.icon` naming a glyph
 * that does not exist draws the fallback diamond, and a row of identical
 * diamonds over a body is a legend that says nothing while looking exactly like
 * a working feature. A skill whose name is one character too wide for its slot
 * is clipped silently, because the bottom band is *drawn* in a 5x7 face rather
 * than typeset -- nothing reflows, nothing wraps, and nothing complains.
 */

import { describe, expect, it } from 'vitest';
import { ALL_ABILITIES, barNameOf } from '../../../server/data/abilities.js';
import { STATUS_VISUALS } from '../../../server/data/status-visuals.js';
import { FALLBACK_ICON, statusIconSvg } from './icons.js';
import { hudLayout } from './hud-layout.js';
import { textWidth } from './pixel-font.js';

describe('the status marks’ glyphs (spec 190)', () => {
  it('draws a real glyph for every status the wire can carry', () => {
    // `statusIconSvg` answers the fallback for an id it has no body for, which
    // is the right runtime behaviour -- an unknown mark costs one glyph rather
    // than the frame -- and is exactly why a missing row is invisible. The seven
    // afflictions are the ones at risk: they were added to the table and to the
    // icon set in two separate files, and only one of those two is imported by
    // anything the server runs.
    for (const visual of STATUS_VISUALS) {
      const drawn = statusIconSvg(visual.icon);
      expect(drawn, `${visual.id} draws the fallback`).not.toContain(FALLBACK_ICON);
      expect(drawn, `${visual.id} draws nothing`).toMatch(/<(path|circle)\b/);
    }
  });

  it('draws a different glyph for every status', () => {
    // Colour is set by `kind` and by nothing else, so an affliction's silhouette
    // is carrying its entire identity. Two rows sharing a body is two conditions
    // a player cannot tell apart, and a copy-paste is how it would happen.
    const drawn = STATUS_VISUALS.map((visual) => statusIconSvg(visual.icon));
    expect(new Set(drawn).size).toBe(STATUS_VISUALS.length);
  });
});

describe('the names the action bar draws (spec 190)', () => {
  it('fits every skill’s drawn name inside a slot, in the game’s own font', () => {
    // Mirrored from `hud-layout.test.ts` rather than restated as "fifteen
    // characters": fifteen is what a 92px slot happens to hold at scale 1 in a
    // 5x7 face, and it is an output of the layout table rather than a rule
    // anybody typed. Widen the slot or change the scale and the limit moves --
    // measuring it here means the constraint follows.
    //
    // The *drawn* name, so a row that already answered this with a `shortName`
    // passes on the string the player actually sees.
    const desktop = hudLayout(false);
    expect(desktop.slotIconOnly, 'a desktop slot draws a name at all').toBe(false);

    const skills = ALL_ABILITIES.filter((ability) => ability.skill === true);
    expect(skills.length).toBeGreaterThan(0);
    for (const ability of skills) {
      const drawn = barNameOf(ability);
      const width = (textWidth(drawn.toUpperCase()) + 2) * desktop.slotNameScale;
      const where = `"${drawn}" (${ability.id}) at scale ${desktop.slotNameScale}`;
      expect(width, where).toBeLessThanOrEqual(desktop.slot.width);
    }
  });
});
