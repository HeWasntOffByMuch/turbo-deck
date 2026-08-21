import { describe, expect, it } from 'vitest';

import {
  CROSSHAIR_BOX,
  CROSSHAIR_FILL,
  CROSSHAIR_HOTSPOT,
  CROSSHAIR_SCALE,
  CROSSHAIR_SIDE,
  crosshairCursor,
  crosshairPath,
  crosshairRects,
  crosshairSvg,
  worldCursor,
} from './crosshair.js';

/** The art as a grid of booleans, which is what every shape claim below reads. */
function lit(): boolean[][] {
  const grid: boolean[][] = Array.from({ length: CROSSHAIR_SIDE }, () =>
    Array.from({ length: CROSSHAIR_SIDE }, () => false),
  );
  for (const rect of crosshairRects()) {
    const row = grid[rect.y];
    if (row) row[rect.x] = true;
  }
  return grid;
}

describe('the crosshair art', () => {
  it('is square and every rect is inside its own box', () => {
    for (const rect of crosshairRects()) {
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

  it('is symmetric about both axes', () => {
    const grid = lit();
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

describe('the drawn cursor', () => {
  it('fits inside the 32px a cursor image may be', () => {
    // Some engines refuse a cursor image larger than 32px square outright, and a
    // refused image is an arrow -- the exact thing this replaces.
    expect(CROSSHAIR_BOX).toBeLessThanOrEqual(32);
    expect(CROSSHAIR_BOX).toBe((CROSSHAIR_SIDE + 2) * CROSSHAIR_SCALE);
  });

  it('puts the hotspot within half a pixel of the centre pixel s middle', () => {
    // CSS wants a whole number, and the middle of an odd-sided box straddles the
    // half. Half a pixel is invisible; a whole pixel out on every cast is not.
    expect(Math.abs(CROSSHAIR_HOTSPOT - CROSSHAIR_BOX / 2)).toBeLessThanOrEqual(0.5);
    expect(CROSSHAIR_HOTSPOT).toBeGreaterThan(0);
    expect(CROSSHAIR_HOTSPOT).toBeLessThan(CROSSHAIR_BOX);
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

  it('is a url with a hotspot and a keyword behind it', () => {
    const cursor = crosshairCursor();
    expect(cursor).toMatch(
      new RegExp(`^url\\("data:image/svg\\+xml,.+"\\) ${CROSSHAIR_HOTSPOT} ${CROSSHAIR_HOTSPOT}, crosshair$`),
    );
    // An engine that refuses SVG cursors falls through to the keyword, so it
    // still gets a crosshair rather than an arrow.
    expect(cursor.endsWith(', crosshair')).toBe(true);
  });

  it('survives the round trip into a url(), markup and all', () => {
    const cursor = crosshairCursor();
    const encoded = cursor.slice(cursor.indexOf(',') + 1, cursor.indexOf('")'));
    expect(decodeURIComponent(encoded)).toBe(crosshairSvg());
    // The characters that would end the url() early, or the CSS declaration.
    for (const hazard of ['"', '#', '<', '>', ';', ')']) {
      expect(encoded).not.toContain(hazard);
    }
  });
});

describe('which cursor the world wears', () => {
  it('is the crosshair while an aim is pending', () => {
    expect(worldCursor({ aiming: true, overDrop: false })).toBe(crosshairCursor());
  });

  it('is the crosshair even over a drop', () => {
    // A left click places the aim, so a pointing hand would promise a pickup the
    // click is not going to perform.
    expect(worldCursor({ aiming: true, overDrop: true })).toBe(crosshairCursor());
  });

  it('is the pointer over a drop with nothing aimed', () => {
    expect(worldCursor({ aiming: false, overDrop: true })).toBe('pointer');
  });

  it('is whatever the page says otherwise', () => {
    expect(worldCursor({ aiming: false, overDrop: false })).toBe('');
  });
});
