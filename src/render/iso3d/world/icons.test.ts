/**
 * The weapon icons (spec 094).
 *
 * The shapes themselves are a matter of taste and are checked by eye in
 * `.claude/screenshots/touch-landscape.png`. What is checked here is the part
 * that goes wrong silently: an attack the switch offers that has no icon draws
 * the fallback diamond, and looks like a bug nobody filed.
 */

import { describe, expect, it } from 'vitest';
import {
  FALLBACK_ICON,
  SLOT_ICONS,
  slotIconSvg,
  SYSTEM_ICONS,
  systemIconSvg,
  WEAPON_ICONS,
  weaponIconSvg,
} from './icons.js';
import { SYSTEM_BUTTONS, WEAPON_SWITCH } from './hud.js';

describe('the action bar’s slot icons (spec 163)', () => {
  it('draws the vial and the empty slot as different things', () => {
    expect(SLOT_ICONS.vial).not.toBe(SLOT_ICONS.empty);
    expect(slotIconSvg('vial')).toContain(SLOT_ICONS.vial);
    expect(slotIconSvg('empty')).toContain(SLOT_ICONS.empty);
  });

  it('paints both in currentColor, so a dimmed slot dims its icon', () => {
    // Same trick the weapon switch relies on: one string serves the lit and the
    // unlit button, and nothing has a second opinion about which is which.
    for (const body of Object.values(SLOT_ICONS)) {
      expect(body).not.toMatch(/(fill|stroke)="#/);
    }
    expect(slotIconSvg('vial')).toContain('stroke="currentColor"');
  });
});

describe('the weapon icons', () => {
  it('draws a distinct icon for every attack the switch offers', () => {
    const drawn = WEAPON_SWITCH.map((weapon) => {
      const icon = WEAPON_ICONS[weapon.abilityId];
      expect(icon, `no icon for ${weapon.abilityId}`).toBeDefined();
      return icon;
    });
    expect(new Set(drawn).size).toBe(WEAPON_SWITCH.length);
  });

  it('falls back to a shape rather than to nothing', () => {
    const unknown = weaponIconSvg('ranged.crossbow');
    expect(unknown).toContain(FALLBACK_ICON);
    expect(unknown.length).toBeGreaterThan(FALLBACK_ICON.length);
  });

  it('draws at the size it is asked for, in a square box', () => {
    const icon = weaponIconSvg('melee.slash', { size: 28 });
    expect(icon).toContain('width="28"');
    expect(icon).toContain('height="28"');
    expect(icon).toContain('viewBox="0 0 24 24"');
  });

  /**
   * The whole reason the switch does not need a second code path for "selected":
   * the icon inherits the colour the update loop writes onto the button.
   */
  it('paints in currentColor unless told otherwise', () => {
    const inherited = weaponIconSvg('ranged.shot');
    expect(inherited).toContain('stroke="currentColor"');
    expect(inherited).not.toContain('color:');
    expect(weaponIconSvg('ranged.shot', { color: '#ffcf6b' })).toContain('color:#ffcf6b;');
  });

  it('returns one well-formed svg element', () => {
    for (const weapon of WEAPON_SWITCH) {
      const icon = weaponIconSvg(weapon.abilityId);
      expect(icon.startsWith('<svg ')).toBe(true);
      expect(icon.endsWith('</svg>')).toBe(true);
      expect(icon.split('<svg').length - 1).toBe(1);
      // Every element the bodies use closes itself; an unclosed tag here would
      // swallow the rest of the button.
      expect(icon.match(/<(path|circle)\b/g)?.length).toBe(icon.match(/\/>/g)?.length);
    }
  });
});

/**
 * The window buttons' icons (spec 140).
 *
 * Same failure to guard against as above, one step earlier: a fourth window
 * button added to `SYSTEM_BUTTONS` with no icon beside it draws the fallback
 * diamond, and three identical diamonds in a corner is a row nobody can use.
 */
describe('the window icons', () => {
  it('draws a distinct icon for every window button', () => {
    const drawn = SYSTEM_BUTTONS.map((button) => {
      const icon = SYSTEM_ICONS[button.icon];
      expect(icon, `no icon for ${button.icon}`).toBeDefined();
      return icon;
    });
    expect(new Set(drawn).size).toBe(SYSTEM_BUTTONS.length);
  });

  it('draws at the size it is asked for, and paints in currentColor', () => {
    const icon = systemIconSvg('inventory', { size: 24 });
    expect(icon).toContain('width="24"');
    expect(icon).toContain('height="24"');
    expect(icon).toContain('stroke="currentColor"');
    expect(icon).not.toContain('color:');
  });

  it('returns one well-formed svg element for each', () => {
    for (const button of SYSTEM_BUTTONS) {
      const icon = systemIconSvg(button.icon);
      expect(icon.startsWith('<svg ')).toBe(true);
      expect(icon.endsWith('</svg>')).toBe(true);
      expect(icon.split('<svg').length - 1).toBe(1);
      expect(icon.match(/<(path|circle)\b/g)?.length).toBe(icon.match(/\/>/g)?.length);
    }
  });
});
