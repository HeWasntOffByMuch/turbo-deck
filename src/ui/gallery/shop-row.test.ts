/**
 * That the shop is photographed wide enough to hold its own grid (spec 269).
 *
 * Six columns is a **fixed** width -- the tab's body scrolls vertically and has
 * nothing to offer horizontally -- so a window narrower than them clips the
 * last column, and a clipped column photographs as though it were the design.
 * The first two bakes of `shop.png` did exactly that: a sixth icon cut in half
 * and a price reading `2` where the row says `27`.
 *
 * A test rather than a careful number, because the sum runs through two
 * paddings and a scroller, and every one of them is free to move.
 */

import { describe, expect, it } from 'vitest';
import { renderShop } from './render.js';
import { SHOP_COLUMNS } from '../screens/shop.js';

describe('the shop golden', () => {
  it('holds a whole row of cells inside the window', () => {
    const frame = renderShop();
    const cells = frame.shop.cellsOf('buy');
    // The fixture has to *have* a full row, or this asserts nothing at all --
    // which is how the clipping survived a bake in the first place.
    expect(cells.length).toBeGreaterThan(SHOP_COLUMNS);

    const last = cells[SHOP_COLUMNS - 1];
    expect(last).toBeDefined();
    if (!last) return;
    const right = last.rect.x + last.rect.width;
    expect(right, `column ${SHOP_COLUMNS} ends at ${right}`).toBeLessThanOrEqual(
      frame.shop.rect.x + frame.shop.rect.width,
    );
  });

  it('wraps past the sixth cell rather than running off the edge', () => {
    const frame = renderShop();
    const cells = frame.shop.cellsOf('buy');
    const first = cells[0];
    const wrapped = cells[SHOP_COLUMNS];
    expect(first).toBeDefined();
    expect(wrapped).toBeDefined();
    if (!first || !wrapped) return;
    expect(wrapped.rect.x).toBe(first.rect.x);
    expect(wrapped.rect.y).toBeGreaterThan(first.rect.y);
  });
});
