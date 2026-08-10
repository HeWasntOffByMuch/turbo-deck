/**
 * Every widget, in every state, on one screen (spec 121).
 *
 * The primary manual QA surface, and the subject of the golden images. Built as
 * a pure function of a theme and an atlas so the exact same tree is what the
 * browser draws and what `npm test` compares byte for byte -- a gallery the
 * tests could not build would be a gallery that proved nothing.
 *
 * States are forced rather than hovered into: `PaintContext` carries `hovered`,
 * `pressed` and `focused`, so a row of five buttons can be photographed in all
 * five states at once by painting the same tree five times with a different
 * context. Which means the disabled style is checked on every run instead of the
 * one time somebody remembers to tab to it.
 */

import { Column, Grid, Row } from '../core/containers.js';
import { uniformInsets } from '../core/geom.js';
import type { Widget } from '../core/widget.js';
import type { Theme } from '../theme/theme.js';
import { Button, Icon, Separator } from '../widgets/button.js';
import { Checkbox } from '../widgets/checkbox.js';
import { Label } from '../widgets/label.js';
import { Panel } from '../widgets/panel.js';
import { ScrollView } from '../widgets/scroll-view.js';
import { Slider } from '../widgets/slider.js';
import { TextField } from '../widgets/text-field.js';

export interface Gallery {
  readonly root: Widget;
  /** Named handles, so tests and the browser page can drive individual widgets. */
  readonly parts: Readonly<Record<string, Widget>>;
}

function heading(text: string): Label {
  const label = new Label(text, 'body');
  label.colorToken = 'accent';
  return label;
}

function group(theme: Theme, title: string, children: readonly Widget[]): Panel {
  const panel = new Panel('column', `group:${title}`);
  panel.padding = uniformInsets(theme.spacing.sm);
  panel.gap = theme.spacing.xs;
  panel.add(heading(title));
  panel.add(new Separator('row'));
  panel.addAll(children);
  return panel;
}

export function buildGallery(theme: Theme): Gallery {
  const parts: Record<string, Widget> = {};

  // --- buttons, one per state ------------------------------------------------
  // Two rows rather than three across: the left column is about 150 UI pixels at
  // the smallest scale the gallery is driven at, and three labelled buttons are
  // 165. They would clip -- correctly, but a QA surface that looks broken is one
  // nobody trusts.
  const buttonRow = new Column('buttons');
  buttonRow.gap = theme.spacing.xs;
  const topButtons = new Row('buttons:top');
  topButtons.gap = theme.spacing.xs;
  const normalButton = new Button('Normal', 'button:normal');
  const disabledButton = new Button('Off', 'button:disabled');
  disabledButton.enabled = false;
  const iconButton = new Button('Close', 'button:icon');
  iconButton.iconName = 'close';
  topButtons.addAll([normalButton, disabledButton]);
  buttonRow.addAll([topButtons, iconButton]);
  parts['button'] = normalButton;
  parts['buttonDisabled'] = disabledButton;
  parts['buttonIcon'] = iconButton;

  // --- checkboxes ------------------------------------------------------------
  // A column, not a row: three labelled checkboxes are about 230 pixels of text
  // and the left column is half of a 400-wide viewport. Stacking them is the
  // honest layout rather than relying on the clip to hide the overlap.
  const checkRow = new Column('checks');
  checkRow.gap = theme.spacing.xs;
  const checkedBox = new Checkbox('Checked', 'check:on');
  checkedBox.setChecked(true);
  const uncheckedBox = new Checkbox('Unchecked', 'check:off');
  const disabledBox = new Checkbox('Disabled', 'check:disabled');
  disabledBox.enabled = false;
  disabledBox.setChecked(true);
  checkRow.addAll([checkedBox, uncheckedBox, disabledBox]);
  parts['checkbox'] = checkedBox;
  parts['checkboxOff'] = uncheckedBox;

  // --- sliders ---------------------------------------------------------------
  const sliderColumn = new Column('sliders');
  sliderColumn.gap = theme.spacing.xs;
  const slider = new Slider(0, 100, 40, 5, 'slider:main');
  const sliderDisabled = new Slider(0, 100, 75, 5, 'slider:disabled');
  sliderDisabled.enabled = false;
  sliderColumn.addAll([slider, sliderDisabled]);
  parts['slider'] = slider;

  // --- text fields -----------------------------------------------------------
  const fieldColumn = new Column('fields');
  fieldColumn.gap = theme.spacing.xs;
  const field = new TextField('Kestrel', 'field:filled');
  const emptyField = new TextField('', 'field:empty');
  emptyField.placeholder = 'Search...';
  fieldColumn.addAll([field, emptyField]);
  parts['textField'] = field;
  parts['textFieldEmpty'] = emptyField;

  // --- icons -----------------------------------------------------------------
  const iconRow = new Row('icons');
  iconRow.gap = theme.spacing.sm;
  for (const name of ['check', 'close', 'chevronUp', 'chevronDown', 'dot']) {
    const icon = new Icon(name, `icon:${name}`);
    icon.layoutAlign = 'center';
    iconRow.add(icon);
  }

  // --- a scroll view over more rows than fit --------------------------------
  const listContent = new Column('listContent');
  listContent.gap = theme.spacing.xs;
  listContent.padding = uniformInsets(theme.spacing.xs);
  for (let i = 1; i <= 12; i++) {
    listContent.add(new Label(`Item ${i}`, 'body'));
  }
  const scroll = new ScrollView(listContent, 'scroll');
  scroll.layoutGrow = 1;
  parts['scroll'] = scroll;

  // --- a uniform grid, which is what an inventory will be ------------------
  const grid = new Grid(6, 16, 16, 'grid');
  grid.gap = theme.spacing.xs;
  for (let i = 0; i < 12; i++) {
    const cell = new Panel('column', `cell:${i}`);
    cell.styleKey = 'button';
    grid.add(cell);
  }
  parts['grid'] = grid;

  // --- wrapped body text, the thing 5x7 could not do -----------------------
  const prose = new Label(
    'The quick brown fox jumps over the lazy dog, and pays for it with a cooldown.',
    'body',
  );
  prose.wrap = true;

  const numerals = new Label('0123456789 +12 -7 !', 'numeric');

  const left = new Column('left');
  left.gap = theme.spacing.sm;
  left.layoutGrow = 1;
  left.addAll([
    group(theme, 'Buttons', [buttonRow]),
    group(theme, 'Checkboxes', [checkRow]),
    group(theme, 'Sliders', [sliderColumn]),
    group(theme, 'Fields', [fieldColumn]),
  ]);

  const right = new Column('right');
  right.gap = theme.spacing.sm;
  right.layoutGrow = 1;
  right.addAll([
    group(theme, 'Icons', [iconRow]),
    group(theme, 'Grid', [grid]),
    group(theme, 'Text', [prose, numerals]),
  ]);

  const columns = new Row('columns');
  columns.gap = theme.spacing.sm;
  columns.addAll([left, right]);

  const scrollGroup = group(theme, 'Scroll', [scroll]);
  scrollGroup.layoutGrow = 1;

  const content = new Column('galleryContent');
  content.padding = uniformInsets(theme.spacing.sm);
  content.gap = theme.spacing.sm;
  content.addAll([heading('UI GALLERY'), columns, scrollGroup]);

  // The whole gallery scrolls. It is 500-odd pixels tall and the theme's
  // `minViewport` is 300x140, so anything else would either not fit on the
  // smallest supported viewport or would quietly squash its groups into each
  // other -- and a QA surface that misrepresents the widgets is worse than none.
  // It also puts a scroll view inside a scroll view, which is a case worth
  // having on screen.
  const root = new ScrollView(content, 'galleryScroll');
  parts['galleryScroll'] = root;

  return { root, parts };
}
