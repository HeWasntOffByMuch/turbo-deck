/**
 * The weapon icons (spec 094).
 *
 * The shapes themselves are a matter of taste and are checked by eye in
 * `.claude/screenshots/touch-landscape.png`. What is checked here is the part
 * that goes wrong silently: an attack the switch offers that has no icon draws
 * the fallback diamond, and looks like a bug nobody filed.
 */

import { describe, expect, it } from 'vitest';
import { FALLBACK_ICON, WEAPON_ICONS, weaponIconSvg } from './icons.js';
import { WEAPON_SWITCH } from './hud.js';

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
