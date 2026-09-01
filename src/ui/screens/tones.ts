/**
 * What a described line is drawn in (specs 185, 269).
 *
 * The one place the vocabulary the view-models speak meets the palette: a model
 * says what *kind* of thing a line is and this says what that looks like, which
 * is what lets `src/render/` describe an item without naming a colour.
 *
 * Its own module since spec 269, because the shop draws item details too. The
 * table lived in `inventory.ts` while the bag was the only screen that had
 * them, and a second copy in the shop would be a second answer to "is a
 * drawback red" -- free to disagree the first time either was retuned, on two
 * windows a player has open at once.
 *
 * `rarity` is absent because it is not one colour -- it is the item's own, and
 * only the item knows which. Every caller resolves that one through
 * `rarityToken` and hands the rest here.
 */

import { ATTRIBUTE_TOKENS } from '../theme/theme.js';
import type { DetailTone } from '../widgets/item-slot.js';

export const TONE_TOKENS: Readonly<Record<Exclude<DetailTone, 'rarity'>, string>> = {
  good: 'success',
  bad: 'danger',
  dim: 'textDim',
  normal: 'text',
  // Attribute identity (specs 216, 242), from the one table that names it --
  // the action bar draws the same three positions on a skill tooltip now, and
  // two copies of "Strength is this colour" is how the two stop matching.
  ...ATTRIBUTE_TOKENS,
};
