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

export interface CharacterView {
  readonly name: string;
  readonly level: number;
  readonly experience: { readonly current: number; readonly toNext: number };
  readonly unspentPoints: number;
  /** Label/value pairs, already formatted: the screen does no arithmetic. */
  readonly stats: readonly { readonly label: string; readonly value: string }[];
  readonly branches: readonly BranchView[];
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

export class CharacterScreen extends Column {
  readonly tabs = new TabPanel('characterTabs');
  readonly experience = new Meter('character:xp');
  onSpend: ((skillId: string) => void) | null = null;

  private readonly heading = new Label('', 'body');
  /** Public so a test can assert it hides rather than showing "0 points". */
  readonly pointsLabel = new Label('', 'body');
  private readonly statRows: Label[] = [];
  private readonly statColumn: Column;
  private readonly rows = new Map<string, SkillRow>();
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
    this.pointsLabel.setText(
      view.unspentPoints > 0 ? `${view.unspentPoints} point(s) to spend` : 'no points to spend',
    );
    this.pointsLabel.visible = view.unspentPoints > 0;

    this.syncStats(view.stats);

    const ids = view.branches.map((branch) => branch.id);
    if (ids.join('|') !== this.branchOrder.join('|')) this.rebuildTabs(view.branches);
    for (const branch of view.branches) {
      for (const skill of branch.skills) this.rows.get(skill.id)?.setSkill(skill);
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

  private rebuildTabs(branches: readonly BranchView[]): void {
    this.rows.clear();
    this.branchOrder = branches.map((branch) => branch.id);
    const theme = this.options.theme;

    this.tabs.addTab('stats', 'Stats', () => this.statColumn);
    for (const branch of branches) {
      this.tabs.addTab(branch.id, branch.name, () => this.buildBranch(branch, theme));
    }
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
