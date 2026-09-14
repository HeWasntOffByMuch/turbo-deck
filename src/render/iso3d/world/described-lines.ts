/**
 * A Technical Description as lines a tooltip can draw (spec 283).
 *
 * `src/ui/` may not read `server/data/description.ts` -- the fence exists so a
 * widget cannot reach the content tables through the back door -- so something
 * on this side has to turn a `TechnicalDescription` into `TooltipLine`s, and
 * *what a tone looks like* has to be answered there too.
 *
 * Its own module because there are two callers now. It was `hintFor` inside
 * `action-bar-model.ts` while the skill slot was the only thing in the game that
 * described a mechanic unprompted; the unlock notice describes one as well, and
 * a second copy of this table is a second answer to "what colour is a cost"
 * -- free to disagree the first time either is retuned, in two places a player
 * sees within a second of each other. The same argument `src/ui/screens/tones.ts`
 * makes one layer up, for the same reason.
 *
 * Pure. No DOM, no clock, and no colour: a token is a name the theme resolves.
 */

import type { TechnicalDescription, Tone } from '../../../server/data/description.js';
import { ATTRIBUTE_TOKENS } from '../../../ui/theme/theme.js';
import type { TooltipLine } from '../../../ui/widgets/tooltip.js';

/**
 * What each of spec 191's five tones is drawn in.
 *
 * Out of the nineteen that exist, and each already means this somewhere else:
 * `focus` is what the interface says a target in, `text` is a plain statement,
 * `danger` is what something costs you, `accent` is a commitment with a clock
 * on it, and `textDim` is the aside it already draws every quiet thing in.
 */
export const TONE_TOKENS: Readonly<Record<Tone, string>> = {
  target: 'focus',
  effect: 'text',
  cost: 'danger',
  timing: 'accent',
  note: 'textDim',
};

/**
 * The described thing as a tooltip's worth of lines: its name, its rules, and
 * its flavour last and dim.
 *
 * Flavour is kept out of the rules exactly as `technicalText` keeps it out of
 * them -- a caller that wants both puts them in two styles, and one that wants
 * only the mechanics slices this list.
 */
export function describedLines(described: TechnicalDescription): readonly TooltipLine[] {
  return [{ text: described.name }, ...describedBody(described)];
}

/**
 * The same lines without the name on the front.
 *
 * For a surface that draws the name itself. The unlock notice has a title row,
 * and its first golden drew `Crushing Blows` twice, one line under the other --
 * which is the kind of thing only a picture says, since both halves were
 * individually correct.
 */
export function describedBody(described: TechnicalDescription): readonly TooltipLine[] {
  return [
    ...described.lines.map((line) => {
      const colorToken = TONE_TOKENS[line.tone];
      // A spanned line carries its runs through with each one resolved here,
      // which is the same hop the line's own tone makes and the same one
      // `inventory.ts` makes for a weapon's grades (spec 242). One line has
      // them: the `S / - / D` scaling notation, where position is the attribute
      // and each position takes that attribute's hue. `text` rides along as the
      // whole line, because the tooltip's wrap and its repeat-hover key are
      // built from it.
      if (line.spans === undefined) return { text: line.text, colorToken };
      return {
        text: line.text,
        colorToken,
        spans: line.spans.map((span) => ({
          text: span.text,
          colorToken: span.attribute === undefined ? colorToken : ATTRIBUTE_TOKENS[span.attribute],
        })),
      };
    }),
    ...(described.flavor === null ? [] : [{ text: described.flavor, colorToken: 'textDim' }]),
  ];
}
