/**
 * Which devices get the phone frame (spec 141).
 *
 * Written as a table of real devices rather than as a set of boolean cases,
 * because the bug this replaces was not a wrong condition -- it was that no
 * device had ever been written down. One query was asked one way and believed,
 * and the device that disagreed with it could only be found by holding one.
 *
 * The row that matters is `phone in desktop-site mode`: it is the photograph
 * that started spec 141, and it is the only row where the pointer lies.
 */

import { describe, expect, it } from 'vitest';
import { HANDHELD_MAX_SHORT_SIDE, isHandheld, type DeviceFacts } from './device.js';

interface Device extends DeviceFacts {
  readonly name: string;
  readonly handheld: boolean;
}

const DEVICES: readonly Device[] = [
  {
    name: 'desktop with a mouse',
    coarsePointer: false,
    anyCoarsePointer: false,
    maxTouchPoints: 0,
    viewport: { width: 1920, height: 1080 },
    handheld: false,
  },
  {
    name: 'desktop with the window narrowed to a phone shape',
    // The reason rule 1 is a rule: a narrow window is not a phone, and spec 094
    // spent a paragraph on it.
    coarsePointer: false,
    anyCoarsePointer: false,
    maxTouchPoints: 0,
    viewport: { width: 500, height: 900 },
    handheld: false,
  },
  {
    name: 'phone in landscape',
    coarsePointer: true,
    anyCoarsePointer: true,
    maxTouchPoints: 5,
    viewport: { width: 844, height: 390 },
    handheld: true,
  },
  {
    name: 'phone in portrait',
    coarsePointer: true,
    anyCoarsePointer: true,
    maxTouchPoints: 5,
    viewport: { width: 390, height: 844 },
    handheld: true,
  },
  {
    name: 'phone in desktop-site mode',
    // The photograph. Chrome is told to be a desktop and says so: the pointer
    // is reported fine and the layout viewport is inflated to ~980 CSS px. What
    // it does not fake is the touch count, and the short side is still a phone.
    coarsePointer: false,
    anyCoarsePointer: false,
    maxTouchPoints: 5,
    viewport: { width: 980, height: 453 },
    handheld: true,
  },
  {
    name: 'tablet',
    coarsePointer: true,
    anyCoarsePointer: true,
    maxTouchPoints: 5,
    viewport: { width: 1024, height: 768 },
    handheld: true,
  },
  {
    name: 'laptop with a touchscreen',
    // Touch is available but is not what anybody is driving it with, and the
    // frame is nothing like a phone's. This is the row that stops rule 3 from
    // swallowing every machine with a digitiser.
    coarsePointer: false,
    anyCoarsePointer: true,
    maxTouchPoints: 10,
    viewport: { width: 1920, height: 1080 },
    handheld: false,
  },
];

describe('which devices get the phone frame', () => {
  for (const device of DEVICES) {
    it(`${device.name} is ${device.handheld ? '' : 'not '}handheld`, () => {
      expect(isHandheld(device)).toBe(device.handheld);
    });
  }
});

describe('the rules behind the table', () => {
  const phone: DeviceFacts = {
    coarsePointer: false,
    anyCoarsePointer: false,
    maxTouchPoints: 5,
    viewport: { width: 980, height: 453 },
  };

  it('never calls a touchless machine handheld, however small its window', () => {
    for (const side of [1, 320, HANDHELD_MAX_SHORT_SIDE, 2000]) {
      expect(
        isHandheld({
          coarsePointer: false,
          anyCoarsePointer: false,
          maxTouchPoints: 0,
          viewport: { width: side, height: side },
        }),
      ).toBe(false);
    }
  });

  it('trusts a coarse primary pointer at any size', () => {
    expect(
      isHandheld({
        coarsePointer: true,
        anyCoarsePointer: true,
        maxTouchPoints: 5,
        viewport: { width: 4000, height: 3000 },
      }),
    ).toBe(true);
  });

  it('reads the short side, so turning the phone over changes nothing', () => {
    const { width, height } = phone.viewport;
    expect(isHandheld(phone)).toBe(true);
    expect(isHandheld({ ...phone, viewport: { width: height, height: width } })).toBe(true);
  });

  it('is a boundary rather than a slope', () => {
    const at = (short: number): boolean =>
      isHandheld({ ...phone, viewport: { width: 4000, height: short } });
    expect(at(HANDHELD_MAX_SHORT_SIDE)).toBe(true);
    expect(at(HANDHELD_MAX_SHORT_SIDE + 1)).toBe(false);
  });

  it('does not read "not laid out yet" as a phone', () => {
    // A frame is measured before layout in more places than one, and a zero
    // short side would otherwise make every touchless machine handheld once.
    for (const viewport of [
      { width: 0, height: 0 },
      { width: 980, height: 0 },
      { width: -1, height: -1 },
    ]) {
      expect(isHandheld({ ...phone, viewport })).toBe(false);
    }
  });

  it('still answers for a device that reports touch only through any-pointer', () => {
    // `maxTouchPoints` is 0 on a few older browsers that still match
    // `(any-pointer: coarse)`; either fact is enough to be touchable.
    expect(
      isHandheld({
        coarsePointer: false,
        anyCoarsePointer: true,
        maxTouchPoints: 0,
        viewport: { width: 900, height: 420 },
      }),
    ).toBe(true);
  });
});
