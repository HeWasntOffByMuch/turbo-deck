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
import { uniformInsets } from '../core/geom.js';
import type { Theme } from '../theme/theme.js';
import { Button, Separator } from '../widgets/button.js';
import { Label } from '../widgets/label.js';
import { Meter } from '../widgets/meter.js';
import { TabPanel } from '../widgets/tabs.js';

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

export interface BranchView {
  readonly id: string;
  readonly name: string;
  /** Locked out by an earlier commitment: every skill in it is unreachable. */
  readonly locked: boolean;
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

/** A pair whose two halves are both high enough to have done something. */
export interface SynergyRowView {
  readonly id: string;
  readonly name: string;
  readonly effect: string;
  readonly active: boolean;
  /** "STR 25 / CON 25" -- what it wants, for one that is not active yet. */
  readonly requirement: string;
}

export interface CharacterView {
  readonly name: string;
  readonly level: number;
  readonly experience: { readonly current: number; readonly toNext: number };
  readonly unspentPoints: number;
  /** Attribute points, which are a separate budget from skill points. */
  readonly unspentAttributePoints: number;
  /** Label/value pairs, already formatted: the screen does no arithmetic. */
  readonly stats: readonly { readonly label: string; readonly value: string }[];
  readonly attributes: readonly AttributeRowView[];
  readonly synergies: readonly SynergyRowView[];
  readonly branches: readonly BranchView[];
  /** The attuned tree, one tab per attribute. */
  readonly statSkills: readonly BranchView[];
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

  /** What a tooltip over this row should say. The description, or the refusal. */
  tooltip(): string {
    const view = this.view;
    if (!view) return '';
    return view.canSpend || view.blockedBecause.length === 0
      ? view.description
      : `${view.description} -- ${view.blockedBecause}`;
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

  /** The description, or the refusal, or what this attribute does next. */
  tooltip(): string {
    const view = this.view;
    if (!view) return '';
    if (!view.canAllocate && view.blockedBecause.length > 0) return view.blockedBecause;
    return view.nextEffect;
  }
}

export class CharacterScreen extends Column {
  readonly tabs = new TabPanel('characterTabs');
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
  private readonly synergyRows: Label[] = [];
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
      ...view.statSkills.map((branch) => branch.id),
    ];
    if (tabIds.join('|') !== this.branchOrder.join('|')) this.rebuildTabs(view);
    this.branchOrder = tabIds;

    for (const attribute of view.attributes) {
      this.attributeRows.get(attribute.key)?.setAttribute(attribute);
    }
    this.syncSynergies(view.synergies);
    this.nextLabel.setText(nextChangeLine(view.attributes));
    this.respecButton.setLabel(`Respec (${view.respec.cost}c)`);
    this.respecButton.enabled = view.respec.enabled;

    for (const branch of [...view.branches, ...view.statSkills]) {
      for (const skill of branch.skills) this.rows.get(skill.id)?.setSkill(skill);
    }
  }

  get attributeRowList(): readonly AttributeRow[] {
    return [...this.attributeRows.values()];
  }

  attributeRowFor(key: string): AttributeRow | null {
    return this.attributeRows.get(key) ?? null;
  }

  private syncSynergies(synergies: readonly SynergyRowView[]): void {
    while (this.synergyRows.length < synergies.length) {
      const row = new Label('', 'body');
      row.wrap = true;
      this.synergyRows.push(row);
      this.attributeColumn.add(row);
    }
    for (const [index, row] of this.synergyRows.entries()) {
      const entry = synergies[index];
      // Inactive pairs are drawn dim rather than hidden. A player deciding where
      // the next point goes needs to see what is one point away, and a list that
      // only shows what you already have cannot tell them.
      row.visible = entry !== undefined;
      if (!entry) continue;
      row.setText(entry.active ? `${entry.name}: ${entry.effect}` : `${entry.name} — ${entry.requirement}`);
      row.colorToken = entry.active ? 'success' : 'textDim';
    }
  }

  private syncStats(stats: readonly { readonly label: string; readonly value: string }[]): void {
    while (this.statRows.length < stats.length) {
      const row = new Label('', 'body');
      this.statRows.push(row);
      this.statColumn.add(row);
    }
    for (const [index, row] of this.statRows.entries()) {
      const entry = stats[index];
      row.visible = entry !== undefined;
      if (entry) row.setText(`${entry.label}  ${entry.value}`);
    }
  }

  private rebuildTabs(view: CharacterView): void {
    this.rows.clear();
    this.attributeRows.clear();
    const theme = this.options.theme;

    this.tabs.addTab('attributes', 'Attributes', () => this.buildAttributes(view, theme));
    this.tabs.addTab('stats', 'Stats', () => this.statColumn);
    for (const branch of [...view.statSkills, ...view.branches]) {
      this.tabs.addTab(branch.id, branch.name, () => this.buildBranch(branch, theme));
    }
  }

  private buildAttributes(view: CharacterView, theme: Theme): Column {
    this.attributeColumn.clearChildren();
    this.synergyRows.length = 0;
    for (const attribute of view.attributes) {
      const row = new AttributeRow(attribute.key, theme, (key) => this.onAllocate?.(key));
      row.setAttribute(attribute);
      this.attributeRows.set(attribute.key, row);
      this.attributeColumn.add(row);
    }
    this.attributeColumn.add(new Separator('row'));
    this.attributeColumn.add(this.nextLabel);
    this.attributeColumn.add(this.respecButton);
    this.attributeColumn.add(new Separator('row'));
    const heading = new Label('PAIRS', 'body');
    heading.colorToken = 'textDim';
    this.attributeColumn.add(heading);
    this.syncSynergies(view.synergies);
    return this.attributeColumn;
  }

  private buildBranch(branch: BranchView, theme: Theme): Column {
    const column = new Column(`branch:${branch.id}`);
    column.gap = theme.spacing.xs;

    if (branch.locked) {
      // Said in words rather than by greying every button: "locked" and "you
      // cannot afford it yet" look identical when the only signal is a dim
      // button, and only one of them is permanent.
      const notice = new Label('Locked by an earlier commitment', 'body');
      notice.colorToken = 'danger';
      notice.wrap = true;
      column.add(notice);
    }

    let tier = 0;
    for (const skill of branch.skills) {
      if (skill.tier !== tier) {
        tier = skill.tier;
        const heading = new Label(`TIER ${tier}`, 'body');
        heading.colorToken = 'textDim';
        column.add(heading);
      }
      const row = new SkillRow(skill.id, theme, (id) => this.onSpend?.(id));
      row.setSkill(skill);
      this.rows.set(skill.id, row);
      column.add(row);
    }
    return column;
  }

  /** The view as last set, for a caller that wants to re-read what it showed. */
  get shown(): CharacterView | null {
    return this.current;
  }
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
