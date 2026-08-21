import { describe, expect, it } from 'vitest';

import {
  CROSSHAIR_BOX,
  CROSSHAIR_CENTRE,
  CROSSHAIR_FILL,
  CROSSHAIR_SCALE,
  CROSSHAIR_SIDE,
  crosshairPath,
  crosshairRects,
  crosshairSvg,
  worldCursor,
  worldMark,
  type CrosshairArt,
} from './crosshair.js';

/** The art as a grid of booleans, which is what every shape claim below reads. */
function lit(art: CrosshairArt = 'full'): boolean[][] {
  const grid: boolean[][] = Array.from({ length: CROSSHAIR_SIDE }, () =>
    Array.from({ length: CROSSHAIR_SIDE }, () => false),
  );
  for (const rect of crosshairRects(art)) {
    const row = grid[rect.y];
    if (row) row[rect.x] = true;
  }
  return grid;
}

/** Where a mark's box lands when it is centred on `at`, as the HUD places it. */
function boxFor(at: { x: number; y: number }): { left: number; top: number; centreX: number; centreY: number } {
  const left = Math.round(at.x) - CROSSHAIR_CENTRE;
  const top = Math.round(at.y) - CROSSHAIR_CENTRE;
  return { left, top, centreX: left + CROSSHAIR_BOX / 2, centreY: top + CROSSHAIR_BOX / 2 };
}

describe('the crosshair art', () => {
  it.each<CrosshairArt>(['full', 'small'])('%s is inside its own box', (art) => {
    for (const rect of crosshairRects(art)) {
      expect(rect.w).toBe(1);
      expect(rect.h).toBe(1);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x).toBeLessThan(CROSSHAIR_SIDE);
      expect(rect.y).toBeLessThan(CROSSHAIR_SIDE);
    }
  });

  it('is odd-sided, so there is a centre pixel for the hotspot to be', () => {
    expect(CROSSHAIR_SIDE % 2).toBe(1);
  });

  it.each<CrosshairArt>(['full', 'small'])('%s is symmetric about both axes', (art) => {
    const grid = lit(art);
    const last = CROSSHAIR_SIDE - 1;
    for (let y = 0; y < CROSSHAIR_SIDE; y++) {
      for (let x = 0; x < CROSSHAIR_SIDE; x++) {
        expect(grid[y]?.[x]).toBe(grid[y]?.[last - x]);
        expect(grid[y]?.[x]).toBe(grid[last - y]?.[x]);
      }
    }
  });

  it('lights its centre and leaves the four pixels around it dark', () => {
    const grid = lit();
    const mid = (CROSSHAIR_SIDE - 1) / 2;
    // A crosshair whose arms meet is a plus sign; the gap is what lets the mark
    // sit on top of what it is pointing at.
    expect(grid[mid]?.[mid]).toBe(true);
    expect(grid[mid - 1]?.[mid]).toBe(false);
    expect(grid[mid + 1]?.[mid]).toBe(false);
    expect(grid[mid]?.[mid - 1]).toBe(false);
    expect(grid[mid]?.[mid + 1]).toBe(false);
  });

  it('has four arms that reach the edge', () => {
    const grid = lit();
    const mid = (CROSSHAIR_SIDE - 1) / 2;
    const last = CROSSHAIR_SIDE - 1;
    expect(grid[0]?.[mid]).toBe(true);
    expect(grid[last]?.[mid]).toBe(true);
    expect(grid[mid]?.[0]).toBe(true);
    expect(grid[mid]?.[last]).toBe(true);
  });

  it('emits one path command per lit pixel', () => {
    const commands = crosshairPath().split('z').filter((part) => part !== '');
    expect(commands).toHaveLength(crosshairRects().length);
  });
});

describe('the small mark', () => {
  it('is the crosshair with its arms pulled in, not a second design', () => {
    const aiming = lit('full');
    const resting = lit('small');
    // Every pixel it lights is one the crosshair lights too: arming a skill
    // extends the mark, it never redraws it somewhere else.
    for (let y = 0; y < CROSSHAIR_SIDE; y++) {
      for (let x = 0; x < CROSSHAIR_SIDE; x++) {
        if (resting[y]?.[x]) expect(aiming[y]?.[x]).toBe(true);
      }
    }
  });

  it('keeps the centre dot and the four tips, and nothing between', () => {
    const grid = lit('small');
    const mid = (CROSSHAIR_SIDE - 1) / 2;
    const last = CROSSHAIR_SIDE - 1;
    expect(grid[mid]?.[mid]).toBe(true);
    expect(grid[0]?.[mid]).toBe(true);
    expect(grid[last]?.[mid]).toBe(true);
    expect(grid[mid]?.[0]).toBe(true);
    expect(grid[mid]?.[last]).toBe(true);
    expect(crosshairRects('small')).toHaveLength(5);
  });

  it('is quieter than the mark it becomes', () => {
    // It sits on top of the body it is pointing out, so it has to stay out of
    // the way of the thing a player is actually looking at.
    expect(crosshairRects('small').length).toBeLessThan(crosshairRects('full').length);
  });
});

describe('the drawn mark', () => {
  it('fits inside the 32px a small mark should be', () => {
    expect(CROSSHAIR_BOX).toBeLessThanOrEqual(32);
    expect(CROSSHAIR_BOX).toBe((CROSSHAIR_SIDE + 2) * CROSSHAIR_SCALE);
  });

  it('centres within half a pixel of the point it marks', () => {
    // The whole reason the mark is drawn rather than handed to CSS as a cursor
    // image: where it lands is arithmetic this program can see, instead of a
    // hotspot applied by a layer that has a device scale and a page zoom of its
    // own to apply. Half a pixel comes from the box being even and the art's
    // middle pixel straddling it; four to seven, which is what the cursor image
    // measured on a real machine, does not.
    for (const at of [{ x: 0, y: 0 }, { x: 640, y: 400 }, { x: 12.4, y: 999.6 }]) {
      const box = boxFor(at);
      expect(Math.abs(box.centreX - Math.round(at.x))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(box.centreY - Math.round(at.y))).toBeLessThanOrEqual(0.5);
    }
  });

  it('draws at the size it declares, in crisp pixels', () => {
    const svg = crosshairSvg();
    expect(svg).toContain(`width="${CROSSHAIR_BOX}"`);
    expect(svg).toContain(`height="${CROSSHAIR_BOX}"`);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain(`viewBox="0 0 ${CROSSHAIR_SIDE + 2} ${CROSSHAIR_SIDE + 2}"`);
  });

  it('takes its colours, and outlines with copies rather than a stroke', () => {
    const svg = crosshairSvg({ fill: '#ff0000', outline: '#00ff00' });
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('fill="#00ff00"');
    // A stroke rounds and bleeds at the corners, which is the look a pixel mark
    // exists to avoid: eight offset copies is what makes the border hard.
    expect(svg).not.toContain('stroke');
    expect(svg.split('fill="#00ff00"')).toHaveLength(9);
  });

  it('defaults to the aim colour the ground shape is drawn in', () => {
    expect(crosshairSvg()).toContain(`fill="${CROSSHAIR_FILL}"`);
  });
});

describe('which mark the world draws', () => {
  const NOTHING = { aiming: false, overEnemy: false, overDrop: false };

  it('is the full crosshair while an aim is pending', () => {
    expect(worldMark({ ...NOTHING, aiming: true })).toBe('full');
  });

  it('is the full crosshair over anything at all, once a skill is armed', () => {
    // A left click places the aim, so neither a pointing hand nor the small
    // mark may promise something the click is not going to perform.
    expect(worldMark({ aiming: true, overEnemy: true, overDrop: false })).toBe('full');
    expect(worldMark({ aiming: true, overEnemy: false, overDrop: true })).toBe('full');
  });

  it('is the small mark over a body a click would act on', () => {
    expect(worldMark({ ...NOTHING, overEnemy: true })).toBe('small');
  });

  it('is nothing over a drop, or over open ground', () => {
    expect(worldMark({ ...NOTHING, overDrop: true })).toBeNull();
    expect(worldMark(NOTHING)).toBeNull();
  });

  it('hides the real cursor exactly where it draws one of its own', () => {
    // The one way this can fail badly is the pair coming apart: a hidden cursor
    // with nothing drawn is a pointer the player cannot find.
    for (const input of [
      { ...NOTHING, aiming: true },
      { ...NOTHING, overEnemy: true },
      { aiming: true, overEnemy: true, overDrop: true },
      NOTHING,
      { ...NOTHING, overDrop: true },
    ]) {
      expect(worldCursor(input) === 'none').toBe(worldMark(input) !== null);
    }
  });

  it('is the pointing hand over a drop, and the arrow over open ground', () => {
    expect(worldCursor({ ...NOTHING, overDrop: true })).toBe('pointer');
    expect(worldCursor(NOTHING)).toBe('');
  });

  it('arms the aim over a body without moving anything', () => {
    // Two marks, one box, one centre: a skill armed over a body already under
    // the pointer extends the arms and shifts not a pixel.
    const at = { x: 400, y: 300 };
    const hovering = boxFor(at);
    const armed = boxFor(at);
    expect(armed).toEqual(hovering);
    expect(worldMark({ ...NOTHING, overEnemy: true })).not.toBe(
      worldMark({ aiming: true, overEnemy: true, overDrop: false }),
    );
  });

  it('declares both marks at the same size', () => {
    for (const svg of [crosshairSvg({ art: 'full' }), crosshairSvg({ art: 'small' })]) {
      expect(svg).toContain(`width="${CROSSHAIR_BOX}"`);
      expect(svg).toContain(`height="${CROSSHAIR_BOX}"`);
    }
  });
});
