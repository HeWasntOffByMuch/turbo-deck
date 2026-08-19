/**
 * Who this character is, and where the points went (spec 128).
 *
 * Unlike the HUD this changes only when something is spent, so it is built the
 * way every screen before phase 5 was: rows that are rebuilt when told to.
 *
 * The rule that matters here is a different one. **The screen does not know what
 * a tier gate is.** `canSpend` and `blockedBecause` arrive already decided, from
 * the same `validateSkillSpend` the server would run -- so the button that is
 * greyed out and the server that would refuse cannot disagree, and the "why" a
 * player reads is the server's own words rather than a second guess at them.
 *
 * Pure. No DOM, no clock, no engine imports.
 */

import { Column, Row } from '../core/containers.js';
import { uniformInsets, type Point, type Rect } from '../core/geom.js';
import type { Widget } from '../core/widget.js';
import type { Theme } from '../theme/theme.js';
import { Button, Separator } from '../widgets/button.js';
import { Label } from '../widgets/label.js';
import { Meter } from '../widgets/meter.js';
import { TabPanel } from '../widgets/tabs.js';
import { Tooltip, type TooltipContent, type TooltipLine } from '../widgets/tooltip.js';

export interface SkillView {
  readonly id: string;
  readonly name: string;
  readonly tier: number;
  readonly level: number;
  readonly maxLevel: number;
  readonly description: string;
  /** Whether one more point may go in. Decided by the rules, not by this file. */
  readonly canSpend: boolean;
  /** Why not, in the words a rejection would use. Empty when it can. */
  readonly blockedBecause: string;
}

/**
 * One attribute's column of the attuned tree (spec 147).
 *
 * No `locked` field, and its absence is the design: spec 056's tree had three
 * branches that permanently foreclosed each other, and a system whose whole
 * premise is that unusual combinations should be discoverable cannot also tell
 * you which two thirds of it you may never have. What gates a skill here is the
 * attribute you actually built.
 */
export interface BranchView {
  readonly id: string;
  readonly name: string;
  readonly pointsSpent: number;
  readonly skills: readonly SkillView[];
}

/**
 * One of the six (spec 147).
 *
 * Everything here arrives already decided and already formatted. In particular
 * `canAllocate` and `blockedBecause` come from the server's own
 * `validateAttributeSpend`, exactly as `SkillView.canSpend` does -- so a greyed
 * "+" and a refusal cannot disagree, and the "why" a player reads is the
 * server's own words rather than a second guess at them.
 *
 * `nextEffect` is the brief's answer to opaque tooltip dumps: rather than every
 * number this attribute feeds, one sentence saying what *changes next* and how
 * far away it is.
 */
export interface AttributeRowView {
  readonly key: string;
  readonly name: string;
  readonly abbrev: string;
  /**
   * What this attribute is for, always. "Overpower. Poise damage, stagger
   * duration, hyper-armour, attack damage."
   *
   * Separate from `nextEffect` because the two answer different questions and a
   * character answers only one of them most of the time: `nextEffect` is empty
   * once every milestone in a column is met, and the refusal that used to stand
   * in for both said "no unspent attribute points" -- which is a fact about the
   * budget and tells a player nothing about the attribute they are pointing at.
   */
  readonly description: string;
  /** What has been allocated. What the "+" spends against. */
  readonly allocated: number;
  /** After items and skills. Shown beside it only when the two differ. */
  readonly total: number;
  readonly canAllocate: boolean;
  readonly blockedBecause: string;
  /** "At 35: your wind-ups ignore 60% of incoming poise damage." Empty at the top. */
  readonly nextEffect: string;
  /** Points still needed to reach it. 0 when there is no next one. */
  readonly toNext: number;
  /** What this attribute has already switched on, newest last. */
  readonly active: readonly string[];
}

export interface CharacterView {
  readonly name: string;
  readonly level: number;
  readonly experience: { readonly current: number; readonly toNext: number };
  readonly unspentPoints: number;
  /** Attribute points, which are a separate budget from skill points. */
  readonly unspentAttributePoints: number;
  /**
   * Label, value and one short sentence, already formatted: the screen does no
   * arithmetic and writes no prose. A `hint` that says something is not
   * implemented is the content table's statement, not this file's.
   */
  readonly stats: readonly {
    readonly label: string;
    readonly value: string;
    readonly hint: string;
  }[];
  readonly attributes: readonly AttributeRowView[];
  /** The attuned tree, one tab per attribute. */
  readonly branches: readonly BranchView[];
  /** What a respec costs, and whether this character can have one right now. */
  readonly respec: { readonly cost: number; readonly enabled: boolean };
}

export interface CharacterOptions {
  readonly theme: Theme;
}

/** One skill: its name, what is in it, and the button that adds to it. */
export class SkillRow extends Row {
  readonly spendButton: Button;
  private readonly nameLabel = new Label('', 'body');
  // The body face, not the numeric one: "2/5" has a slash in it and the numeric
  // face is the damage-number font, whose glyph table is digits and signs.
  private readonly levelLabel = new Label('', 'body');
  private view: SkillView | null = null;

  constructor(
    readonly skillId: string,
    theme: Theme,
    onSpend: (id: string) => void,
  ) {
    super(`skill:${skillId}`);
    this.gap = theme.spacing.xs;
    this.nameLabel.layoutGrow = 1;
    this.levelLabel.layoutAlign = 'center';
    this.spendButton = new Button('+', `spend:${skillId}`);
    this.spendButton.onPress = () => onSpend(skillId);
    this.addAll([this.nameLabel, this.levelLabel, this.spendButton]);
  }

  get skill(): SkillView | null {
    return this.view;
  }

  setSkill(next: SkillView): void {
    this.view = next;
    this.nameLabel.setText(next.name);
    this.levelLabel.setText(`${next.level}/${next.maxLevel}`);
    this.nameLabel.colorToken = next.level > 0 ? 'text' : 'textDim';
    this.spendButton.enabled = next.canSpend;
  }

  /**
   * What a tooltip over this row should say. The description, or the refusal.
   *
   * Split into lines rather than handed over as prose (spec 189). A skill's
   * description is now its Technical Description -- a requirement, a trigger and
   * one line per thing it grants -- and `Tooltip` wraps *per line*, so passing
   * the whole thing as one string would run every fact into one paragraph and
   * lose exactly the scannability the standard is for.
   *
   * The refusal stays a line of its own at the bottom, where it reads as the
   * answer to "why can I not spend here" rather than as part of the mechanics.
   */
  tooltip(): readonly TooltipLine[] {
    const view = this.view;
    if (!view) return [];
    const lines: TooltipLine[] = view.description.split('\n').map((text) => ({ text }));
    if (!view.canSpend && view.blockedBecause.length > 0) {
      lines.push({ text: view.blockedBecause, colorToken: 'danger' });
    }
    return lines;
  }
}

/**
 * One attribute: what it is, what is in it, and the button that adds to it.
 *
 * Deliberately the same shape as {@link SkillRow} -- a name, a number, a "+" --
 * because they are the same gesture and a player should not have to learn two.
 */
export class AttributeRow extends Row {
  readonly spendButton: Button;
  private readonly nameLabel = new Label('', 'body');
  private readonly valueLabel = new Label('', 'body');
  private view: AttributeRowView | null = null;

  constructor(
    readonly attributeKey: string,
    theme: Theme,
    onAllocate: (key: string) => void,
  ) {
    super(`attribute:${attributeKey}`);
    this.gap = theme.spacing.xs;
    this.nameLabel.layoutGrow = 1;
    this.valueLabel.layoutAlign = 'center';
    this.spendButton = new Button('+', `allocate:${attributeKey}`);
    this.spendButton.onPress = () => onAllocate(attributeKey);
    this.addAll([this.nameLabel, this.valueLabel, this.spendButton]);
  }

  get attribute(): AttributeRowView | null {
    return this.view;
  }

  setAttribute(next: AttributeRowView): void {
    this.view = next;
    this.nameLabel.setText(next.name);
    // The total only appears when it differs from the allocation, so the common
    // case reads as one number rather than as "24 (24)".
    this.valueLabel.setText(
      next.total === next.allocated ? `${next.allocated}` : `${next.allocated} (${next.total})`,
    );
    this.nameLabel.colorToken = next.total > next.allocated ? 'accent' : 'text';
    this.spendButton.enabled = next.canAllocate;
  }

  /**
   * What this attribute does, then what it does next, then why not.
   *
   * Appended rather than substituted, and the same shape as {@link SkillRow}'s.
   * The refusal used to *replace* the description, so a character with nothing
   * to spend -- which is every character between two level-ups, i.e. nearly
   * always -- got "no unspent attribute points" on all six rows and could not
   * find out what any of them were for. A budget is not an explanation.
   */
  tooltip(): string {
    const view = this.view;
    if (!view) return '';
    const parts = [view.description];
    if (view.nextEffect.length > 0 && view.toNext > 0) {
      parts.push(`${view.toNext} more: ${view.nextEffect}`);
    }
    if (!view.canAllocate && view.blockedBecause.length > 0) parts.push(view.blockedBecause);
    return parts.filter((part) => part.length > 0).join(' -- ');
  }
}

export class CharacterScreen extends Column {
  readonly tabs = new TabPanel('characterTabs');
  /**
   * What the thing under the cursor does (spec 147).
   *
   * The rows have carried a `tooltip()` since spec 128 and nothing ever asked
   * them: every explanation the sheet had was written and then never shown. This
   * is that wiring, and it uses the same `Tooltip` widget the bag does -- same
   * delay, same edge flip, same replayable timestamps -- rather than a second
   * kind of hover for a player to learn.
   */
  readonly tooltip = new Tooltip('characterTooltip');
  readonly experience = new Meter('character:xp');
  onSpend: ((skillId: string) => void) | null = null;
  /** Ask the server for one more point in this attribute (spec 147). */
  onAllocate: ((key: string) => void) | null = null;
  onRespec: (() => void) | null = null;

  private readonly heading = new Label('', 'body');
  /** Public so a test can assert it hides rather than showing "0 points". */
  readonly pointsLabel = new Label('', 'body');
  private readonly statRows: Label[] = [];
  private readonly statColumn: Column;
  private readonly rows = new Map<string, SkillRow>();
  private readonly attributeRows = new Map<string, AttributeRow>();
  /** One hint per stat row, parallel to `statRows`. What a hover says. */
  private readonly statHints: string[] = [];
  private readonly attributeColumn: Column;
  private readonly nextLabel = new Label('', 'body');
  private readonly respecButton = new Button('', 'character:respec');
  private branchOrder: string[] = [];
  private current: CharacterView | null = null;

  constructor(private readonly options: CharacterOptions) {
    super('character');
    const theme = options.theme;
    this.gap = theme.spacing.xs;
    this.padding = uniformInsets(theme.spacing.xs);

    this.heading.colorToken = 'accent';
    this.pointsLabel.colorToken = 'success';
    this.experience.fillToken = 'success';

    this.statColumn = new Column('character:stats');
    this.statColumn.gap = theme.spacing.xs;

    this.attributeColumn = new Column('character:attributes');
    this.attributeColumn.gap = theme.spacing.xs;
    this.nextLabel.colorToken = 'textDim';
    this.nextLabel.wrap = true;
    this.respecButton.onPress = () => this.onRespec?.();

    // No `layoutGrow` on the tabs: a Linear squashes children it cannot fit, so
    // a growing tab panel inside a short window draws its rows on top of each
    // other. Natural height plus the caller's ScrollView is the honest pairing,
    // and it is the same answer the widget gallery reached.
    this.addAll([this.heading, this.experience, this.pointsLabel, new Separator('row'), this.tabs]);
  }

  get skillRows(): readonly SkillRow[] {
    return [...this.rows.values()];
  }

  rowFor(skillId: string): SkillRow | null {
    return this.rows.get(skillId) ?? null;
  }

  /**
   * Replace everything shown.
   *
   * The tabs are rebuilt only when the *branches* change, which is never in
   * practice -- so spending a point walks the existing rows rather than tearing
   * down a tab and losing whichever one the player was looking at.
   */
  setCharacter(view: CharacterView): void {
    this.current = view;
    this.heading.setText(`${view.name}  LVL ${view.level}`);
    this.experience.setValue(view.experience.current, view.experience.toNext);
    this.experience.caption = `${view.experience.current}/${view.experience.toNext}`;
    // Two budgets, said as two clauses rather than as one number (spec 147):
    // they buy different things and a player who spends one expecting the other
    // has been misled by the interface, not by the rules.
    const parts: string[] = [];
    if (view.unspentAttributePoints > 0) parts.push(`${view.unspentAttributePoints} attribute`);
    if (view.unspentPoints > 0) parts.push(`${view.unspentPoints} skill`);
    this.pointsLabel.setText(parts.length > 0 ? `${parts.join(', ')} point(s) to spend` : 'no points to spend');
    this.pointsLabel.visible = parts.length > 0;

    this.syncStats(view.stats);

    const tabIds = [
      ...view.attributes.map((attribute) => attribute.key),
      ...view.branches.map((branch) => branch.id),
      ...view.branches.flatMap((branch) => branch.skills.map((skill) => skill.id)),
    ];
    if (tabIds.join('|') !== this.branchOrder.join('|')) this.rebuildTabs();
    this.branchOrder = tabIds;

    for (const attribute of view.attributes) {
      this.attributeRows.get(attribute.key)?.setAttribute(attribute);
    }
    this.nextLabel.setText(nextChangeLine(view.attributes));
    this.respecButton.setLabel(`Respec (${view.respec.cost}c)`);
    this.respecButton.enabled = view.respec.enabled;

    for (const branch of view.branches) {
      for (const skill of branch.skills) this.rows.get(skill.id)?.setSkill(skill);
    }
  }

  get attributeRowList(): readonly AttributeRow[] {
    return [...this.attributeRows.values()];
  }

  attributeRowFor(key: string): AttributeRow | null {
    return this.attributeRows.get(key) ?? null;
  }

  /** The stat lines, in the order their hints are, so a test can hover them. */
  get statRowList(): readonly Label[] {
    return this.statRows.filter((row) => row.visible);
  }

  /**
   * What a hover at `at` should say, or empty.
   *
   * Walks the three kinds of row this screen has -- an attribute, a skill, a
   * stat line -- and asks whichever one the cursor is inside. Pure: the hit test
   * is against laid-out rectangles and nothing here reads a clock.
   *
   * `showing` rather than `row.visible`, and that is the whole of the fix. A tab
   * switched away is *hidden*, never destroyed -- that is what makes a tab keep
   * what you left in it (spec 124) -- so every row inside one keeps its own
   * `visible` flag true and keeps the rectangle it was last arranged into. Three
   * tabs of rows therefore stacked on top of each other at the same coordinates,
   * and a hover over an attribute was answered by whichever skill was laid out
   * behind it. Only the ancestor chain knows which tab a row is in.
   */
  hintAt(at: Point): TooltipContent {
    for (const row of this.attributeRows.values()) {
      if (this.showing(row) && contains(row.rect, at)) return row.tooltip();
    }
    for (const row of this.rows.values()) {
      if (this.showing(row) && contains(row.rect, at)) return row.tooltip();
    }
    for (const [index, row] of this.statRows.entries()) {
      if (this.showing(row) && contains(row.rect, at)) return this.statHints[index] ?? '';
    }
    return '';
  }

  /**
   * Whether a row is really on screen: itself visible, and every ancestor up to
   * this screen visible too.
   *
   * Stops at the screen rather than at the root, because a screen's own hosting
   * -- the window, the layer -- is the mount's business and the mount already
   * clears the tooltip when the sheet is shut.
   */
  private showing(row: Widget): boolean {
    let node: Widget | null = row;
    while (node) {
      if (!node.visible) return false;
      if (node === this) return true;
      node = node.parent;
    }
    // Detached: rebuilt out from under us, so it is not on screen either.
    return false;
  }

  /** Point the tooltip at whatever is under the cursor. Driven by the mount. */
  pointerMoved(at: Point, nowMs: number): void {
    const hint = this.hintAt(at);
    // Length reads the same either way -- an empty string and an empty line
    // list both mean "nothing under the cursor" -- which is what lets the
    // attribute rows and the stat lines go on answering with a plain string.
    this.tooltip.point(hint.length > 0 ? hint : null, at, nowMs);
  }

  /** Advance the tooltip's delay. Called once a frame by the mount. */
  updateTooltip(nowMs: number, delayMs: number): void {
    this.tooltip.update(nowMs, delayMs);
  }

  /** Say nothing, whatever the cursor is over -- what closing the sheet does. */
  clearTooltip(): void {
    this.tooltip.point(null, { x: 0, y: 0 }, 0);
  }

  private syncStats(stats: CharacterView['stats']): void {
    while (this.statRows.length < stats.length) {
      const row = new Label('', 'body');
      this.statRows.push(row);
      this.statColumn.add(row);
    }
    this.statHints.length = 0;
    for (const [index, row] of this.statRows.entries()) {
      const entry = stats[index];
      row.visible = entry !== undefined;
      if (!entry) continue;
      row.setText(`${entry.label}  ${entry.value}`);
      this.statHints.push(entry.hint);
    }
  }

  /**
   * Register the three tabs.
   *
   * The factories read {@link current} rather than closing over the view this
   * was called with, and that is the whole of a bug rather than a style
   * preference. A tab is built lazily on first selection and then kept (spec
   * 124), so the view a tab is built *from* is the newest one only for whichever
   * tab happens to be selected at registration -- and this runs once, on the
   * first `setCharacter`. The Skills factory therefore held the sheet's opening
   * view forever: a player who allocated an attribute and only then looked at
   * the tree got a tree gated on the attributes they had before they spent, with
   * every newly-met skill still greyed out and still saying it needed the number
   * they now had. `setCharacter` walks the rows afterwards and would have
   * corrected it, but there was nothing to walk -- `this.rows` is empty until the
   * factory has run -- and the next `Stats` message is what it took to notice.
   */
  private rebuildTabs(): void {
    this.rows.clear();
    this.attributeRows.clear();
    const theme = this.options.theme;

    // Three tabs, not eight. Six attribute columns as six tabs overflowed the
    // strip on a window this narrow and pushed the last two off the edge, and
    // the six are one tree rather than six trees anyway -- so they are one tab
    // with a heading per attribute.
    this.tabs.addTab('attributes', 'Attributes', () => this.buildAttributes(theme));
    this.tabs.addTab('stats', 'Stats', () => this.statColumn);
    this.tabs.addTab('skills', 'Skills', () => this.buildSkills(theme));
  }

  private buildAttributes(theme: Theme): Column {
    this.attributeColumn.clearChildren();
    for (const attribute of this.current?.attributes ?? []) {
      const row = new AttributeRow(attribute.key, theme, (key) => this.onAllocate?.(key));
      row.setAttribute(attribute);
      this.attributeRows.set(attribute.key, row);
      this.attributeColumn.add(row);
    }
    this.attributeColumn.add(new Separator('row'));
    this.attributeColumn.add(this.nextLabel);
    this.attributeColumn.add(this.respecButton);
    // Nothing below this line. There is deliberately no list of two-attribute
    // pairs (spec 147): naming them would turn fifteen things to *discover* into
    // fifteen things to build toward, and the question this screen is supposed
    // to ask is "how do I want to solve problems", not "which of the fifteen".
    return this.attributeColumn;
  }

  /**
   * The whole tree, one headed section per attribute.
   *
   * No tier headings inside a section. The old tree gated a tier on points
   * already spent in the same column, so "TIER 2" was information; here the gate
   * is the attribute, and each row's own tooltip says which number it wants --
   * so a tier label would be a heading that repeats what is under it.
   */
  private buildSkills(theme: Theme): Column {
    const column = new Column('character:skills');
    column.gap = theme.spacing.xs;
    for (const branch of this.current?.branches ?? []) {
      const heading = new Label(branch.name, 'body');
      heading.colorToken = 'accent';
      column.add(heading);
      for (const skill of branch.skills) {
        const row = new SkillRow(skill.id, theme, (id) => this.onSpend?.(id));
        row.setSkill(skill);
        this.rows.set(skill.id, row);
        column.add(row);
      }
    }
    return column;
  }

  /** The view as last set, for a caller that wants to re-read what it showed. */
  get shown(): CharacterView | null {
    return this.current;
  }
}

/** Whether a laid-out rectangle contains a point. */
function contains(rect: Rect, at: Point): boolean {
  return (
    at.x >= rect.x && at.y >= rect.y && at.x < rect.x + rect.width && at.y < rect.y + rect.height
  );
}

/**
 * The one line under the attribute rows: what changes next, and how close it is.
 *
 * Picks the *nearest* milestone across all six rather than listing every one,
 * which is the brief's "surface what mechanically changes next" taken literally.
 * A player with 18 Strength is two points from something, and that is the only
 * sentence worth the space; the other five are a menu nobody reads.
 */
export function nextChangeLine(attributes: readonly AttributeRowView[]): string {
  let best: AttributeRowView | null = null;
  for (const attribute of attributes) {
    if (attribute.nextEffect.length === 0 || attribute.toNext <= 0) continue;
    if (!best || attribute.toNext < best.toNext) best = attribute;
  }
  if (!best) return '';
  return `${best.toNext} more ${best.abbrev}: ${best.nextEffect}`;
}
