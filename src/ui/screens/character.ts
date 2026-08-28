/**
 * Who this character is, and where the points went (spec 128, 244).
 *
 * Six progression tracks and one pool. It was two tabs -- Attributes and Skills
 * -- spending two currencies, and the split was the interface telling the truth
 * about a model that has since stopped being true: one point, and the decision
 * is whether it goes further along a track or deeper into something the track
 * already unlocked.
 *
 * The shape that decision wants is a **list plus a detail**, not one long tree.
 * Six compact rows answer *where am I* at a glance and stay on screen; the
 * selected track answers *what did I unlock, what can I deepen, what comes next*
 * underneath them. Six expanded tracks at once is ninety rows and answers the
 * first question worse.
 *
 * Two things are drawn differently on purpose, because they are different
 * promises (the quality bar's "milestones and specialization tiers are visually
 * distinct"):
 *
 *  - A **milestone** is automatic. It draws as a threshold and a sentence, with
 *    no control beside it -- there is nothing to press, and a "+" that did
 *    nothing would be the interface lying about what a point buys.
 *  - A **specialization** is bought. It draws tier pips and a "+".
 *
 * `[##-]` rather than filled and hollow circles, and that is not a taste
 * decision: these faces are ASCII (`src/ui/text/glyphs-6x10.ts`), `glyphFor`
 * falls back silently, and spec 227 records a warning that drew `account s
 * character` for a hundred specs because somebody typed a curly apostrophe.
 * `isDrawable` is the predicate and every string this screen composes is ASCII.
 *
 * The rule that matters most here is the one this screen has always had.
 * **The screen does not know what a milestone gate is.** `canSpend` and
 * `blockedBecause` arrive already decided, from the same validators the server
 * would run -- so the button that is greyed out and the server that would refuse
 * cannot disagree, and the "why" a player reads is the server's own words rather
 * than a second guess at them.
 *
 * Pure. No DOM, no clock, no engine imports.
 */

import { Column, Row } from '../core/containers.js';
import type { EventContext } from '../core/events.js';
import { uniformInsets, type Point, type Rect } from '../core/geom.js';
import type { Widget } from '../core/widget.js';
import type { Theme } from '../theme/theme.js';
import { Button, Separator } from '../widgets/button.js';
import { Label } from '../widgets/label.js';
import { Meter } from '../widgets/meter.js';
import { TabPanel } from '../widgets/tabs.js';
import { Tooltip, type TooltipContent, type TooltipLine } from '../widgets/tooltip.js';

/**
 * One mechanic a milestone made available, and how deep into it this character
 * has gone.
 *
 * `unlocked` and `canSpend` are two different facts and both are needed: a
 * specialization whose milestone is not reached is *shown* -- that is what makes
 * a track say what is coming -- and one that is unlocked can still refuse for
 * want of a point or for being at its ceiling.
 */
export interface SpecializationView {
  readonly id: string;
  readonly name: string;
  /** Tiers bought. */
  readonly tier: number;
  readonly maxTier: number;
  /** Progression points the next tier costs. */
  readonly cost: number;
  /** Whether its milestone has been reached. */
  readonly unlocked: boolean;
  readonly description: string;
  /** Whether one more tier may go in. Decided by the rules, not by this file. */
  readonly canSpend: boolean;
  /** Why not, in the words a rejection would use. Empty when it can. */
  readonly blockedBecause: string;
}

/** One threshold on a track, and everything that happens at it. */
export interface TrackNodeView {
  readonly threshold: number;
  readonly reached: boolean;
  /** The automatic grant here, if this threshold carries one. */
  readonly milestone: { readonly name: string; readonly effect: string } | null;
  /** Unlocked here, and bought a tier at a time. */
  readonly specializations: readonly SpecializationView[];
}

/**
 * One of the six (spec 147, 244).
 *
 * Everything here arrives already decided and already formatted. In particular
 * `canAdvance` and `blockedBecause` come from the server's own
 * `validateAttributeSpend`, exactly as `SpecializationView.canSpend` comes from
 * `validateSpecializationSpend` -- so a greyed "+" and a refusal cannot disagree.
 *
 * No `locked` field anywhere in this file, and its absence is the design: spec
 * 056's tree had three branches that permanently foreclosed each other, and a
 * system whose whole premise is that unusual combinations should be discoverable
 * cannot also tell you which two thirds of it you may never have. What gates a
 * specialization is the attribute you actually built.
 */
export interface TrackView {
  readonly key: string;
  readonly name: string;
  readonly abbrev: string;
  /**
   * What this attribute is for, always. "Overpower. Poise damage, stagger
   * duration, hyper-armour."
   *
   * Separate from `nextEffect` because the two answer different questions and a
   * character answers only one of them most of the time: `nextEffect` is empty
   * once every milestone on a track is met.
   */
  readonly description: string;
  /** Where the track starts: what every character has before spending anything. */
  readonly from: number;
  /** The value points were spent to reach. What a "+" adds to. */
  readonly allocated: number;
  /** After every grant. What the thresholds are measured against. */
  readonly total: number;
  readonly canAdvance: boolean;
  readonly blockedBecause: string;
  /** The next threshold not yet reached, or 0 at the top of the track. */
  readonly nextThreshold: number;
  /** Points of *attribute* still needed to reach it. 0 when there is none. */
  readonly toNext: number;
  /** What reaching it does, in the words beside the grant. Empty at the top. */
  readonly nextEffect: string;
  /** Points sunk into this track's specializations. */
  readonly tiersBought: number;
  readonly nodes: readonly TrackNodeView[];
}

export interface CharacterView {
  readonly name: string;
  readonly level: number;
  readonly experience: { readonly current: number; readonly toNext: number };
  /** The one pool (spec 244). Buys an attribute point or a specialization tier. */
  readonly unspentPoints: number;
  readonly stats: readonly {
    readonly label: string;
    readonly value: string;
    readonly hint: string;
  }[];
  readonly tracks: readonly TrackView[];
  /** What a respec costs, and whether this character can have one right now. */
  readonly respec: { readonly cost: number; readonly enabled: boolean };
}

export interface CharacterOptions {
  readonly theme: Theme;
}

/**
 * Tier investment, compactly: `[##-]`.
 *
 * `#` bought, `-` still available. A specialization with no tiers bought reads
 * `[---]` rather than as nothing, because "three tiers you have not taken" and
 * "nothing here" are different states and the empty branch is one a player is
 * deciding about.
 */
/**
 * Characters the value column is padded to: "60 (99)" is the widest a hard-capped
 * attribute with a grant on it can be.
 */
const VALUE_WIDTH = 7;

export function tierPips(tier: number, maxTier: number): string {
  const held = Math.max(0, Math.min(tier, maxTier));
  return `[${'#'.repeat(held)}${'-'.repeat(Math.max(0, maxTier - held))}]`;
}

/**
 * One track, compact: pick it, see how far along it is, push it one further.
 *
 * The row carries both controls the track itself needs -- select and advance --
 * because they are the two things a player does to a track and separating them
 * would put the "+" somewhere the eye has to go looking for it. The name button
 * is the selector rather than the whole row being pressable: a press is a
 * commitment and a row with a "+" in it has two of them, so which one was meant
 * has to be unambiguous from where the cursor is.
 */
export class TrackRow extends Row {
  readonly selectButton: Button;
  readonly advanceButton: Button;
  readonly progress = new Meter('');
  private readonly valueLabel = new Label('', 'body');
  private view: TrackView | null = null;

  constructor(
    readonly trackKey: string,
    theme: Theme,
    onSelect: (key: string) => void,
    onAdvance: (key: string) => void,
  ) {
    super(`track:${trackKey}`);
    this.gap = theme.spacing.xs;
    this.selectButton = new Button('', `track:select:${trackKey}`);
    this.selectButton.onPress = () => onSelect(trackKey);
    this.progress.layoutGrow = 1;
    this.progress.fillToken = 'accent';
    this.valueLabel.layoutAlign = 'center';
    this.advanceButton = new Button('+', `track:advance:${trackKey}`);
    this.advanceButton.onPress = () => onAdvance(trackKey);
    this.addAll([this.selectButton, this.progress, this.valueLabel, this.advanceButton]);
  }

  get track(): TrackView | null {
    return this.view;
  }

  setTrack(next: TrackView, selected: boolean): void {
    this.view = next;
    // The abbreviation, because six of these sit in a column at a fixed width and
    // "Intelligence" against "Wisdom" would make the meter start in a different
    // place on every row.
    this.selectButton.setLabel(selected ? `[${next.abbrev}]` : ` ${next.abbrev} `);
    // The total only appears when it differs from the allocation, so the common
    // case reads as one number rather than as "24 (24)".
    //
    // Padded to a constant width, which is worth a line because six of these sit
    // in a column: the meter beside it has `layoutGrow`, so it absorbs whatever
    // the value does not use, and an unpadded column of "8" against "26 (28)"
    // starts every bar in a different place. The face is fixed-width, so padding
    // in characters aligns exactly.
    this.valueLabel.setText(
      (next.total === next.allocated
        ? `${next.allocated}`
        : `${next.allocated} (${next.total})`
      ).padStart(VALUE_WIDTH),
    );
    this.valueLabel.colorToken = next.total > next.allocated ? 'accent' : 'text';
    // The bar is progress *toward the next threshold*, not toward the hard cap:
    // "how close am I to the thing that changes" is the question a track is being
    // asked, and against a cap of 60 every early character's bar is a stub.
    // Filled solid at the top of the track, which is honest -- there is no next.
    //
    // **No caption on it.** A `Meter` draws its caption over the fill, and in a
    // row this narrow "4 to 25" lands on top of the value beside it -- two
    // numbers in one place, neither readable. The distance is said in words in
    // the detail panel and in the row's own tooltip, where there is room for it.
    if (next.nextThreshold > 0) {
      const previous = previousThreshold(next);
      const span = Math.max(1, next.nextThreshold - previous);
      this.progress.setValue(Math.max(0, Math.min(span, next.total - previous)), span);
    } else {
      this.progress.setValue(1, 1);
    }
    this.advanceButton.enabled = next.canAdvance;
  }

  /** What this track is, what it does next, and why the "+" is off. */
  tooltip(): readonly TooltipLine[] {
    const view = this.view;
    if (!view) return [];
    const lines: TooltipLine[] = [
      { text: `${view.name} ${view.total}` },
      { text: view.description },
    ];
    if (view.nextEffect.length > 0) {
      lines.push({ text: `${view.toNext} more: ${view.nextEffect}`, colorToken: 'textDim' });
    }
    if (view.tiersBought > 0) {
      lines.push({ text: `${view.tiersBought} point(s) in specializations`, colorToken: 'textDim' });
    }
    if (!view.canAdvance && view.blockedBecause.length > 0) {
      lines.push({ text: view.blockedBecause, colorToken: 'danger' });
    }
    return lines;
  }
}

/**
 * The highest threshold this track has already passed, or where it starts.
 *
 * `view.from` rather than 0 for the first segment, and that is the difference
 * between a bar that means something and one that does not: every character
 * begins at 5, so measuring the first stretch from zero draws a fresh character
 * half way to their first milestone before they have spent anything.
 */
function previousThreshold(view: TrackView): number {
  let best = view.from;
  for (const node of view.nodes) {
    if (node.threshold <= view.total && node.threshold > best) best = node.threshold;
  }
  return best;
}

/**
 * One specialization: what it is, how deep it goes, and the button that deepens
 * it.
 *
 * Deliberately the same shape as {@link TrackRow} -- a name, a state, a "+" --
 * because they are the same gesture out of the same pool, and a player should
 * not have to learn two.
 */
export class SpecializationRow extends Row {
  readonly spendButton: Button;
  private readonly nameLabel = new Label('', 'body');
  // The body face, not the numeric one: the pips are brackets and dashes and the
  // numeric face's glyph table is digits and signs.
  private readonly pipsLabel = new Label('', 'body');
  private view: SpecializationView | null = null;

  constructor(
    readonly specializationId: string,
    theme: Theme,
    onSpend: (id: string) => void,
  ) {
    super(`spec:${specializationId}`);
    this.gap = theme.spacing.xs;
    this.nameLabel.layoutGrow = 1;
    this.pipsLabel.layoutAlign = 'center';
    this.spendButton = new Button('+', `spec:spend:${specializationId}`);
    this.spendButton.onPress = () => onSpend(specializationId);
    this.addAll([this.nameLabel, this.pipsLabel, this.spendButton]);
  }

  get specialization(): SpecializationView | null {
    return this.view;
  }

  setSpecialization(next: SpecializationView): void {
    this.view = next;
    this.nameLabel.setText(next.name);
    this.pipsLabel.setText(tierPips(next.tier, next.maxTier));
    // Three states, three tones, and no fourth colour invented for it: bought
    // into is ordinary text, maxed is the accent, and everything not yet reached
    // or not yet started is dim.
    const maxed = next.tier >= next.maxTier;
    this.nameLabel.colorToken = maxed ? 'accent' : next.tier > 0 ? 'text' : 'textDim';
    this.pipsLabel.colorToken = this.nameLabel.colorToken;
    this.spendButton.enabled = next.canSpend;
  }

  /**
   * What it does, then what it costs, then why not.
   *
   * Split into lines rather than handed over as prose (spec 191). A
   * specialization's description is its Technical Description -- a requirement, a
   * trigger and one line per thing it grants -- and `Tooltip` wraps *per line*,
   * so passing the whole thing as one string would run every fact into one
   * paragraph and lose exactly the scannability the standard is for.
   */
  tooltip(): readonly TooltipLine[] {
    const view = this.view;
    if (!view) return [];
    const lines: TooltipLine[] = view.description.split('\n').map((text) => ({ text }));
    if (view.tier < view.maxTier) {
      lines.push({
        text: `Next tier: ${view.tier + 1} of ${view.maxTier}, ${view.cost} point(s)`,
        colorToken: 'textDim',
      });
    }
    if (!view.canSpend && view.blockedBecause.length > 0) {
      lines.push({ text: view.blockedBecause, colorToken: 'danger' });
    }
    return lines;
  }
}

/**
 * The sheet: six tracks, and the one that is selected in detail.
 *
 * Unlike the HUD this changes only when something is spent, so it is built the
 * way every screen before phase 5 was: rows that are rebuilt when told to.
 */
export class CharacterScreen extends Column {
  readonly tabs = new TabPanel('character:tabs');
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
  /** Spend one point on a specialization tier (spec 244). */
  onSpend: ((specializationId: string) => void) | null = null;
  /** Spend one point on an attribute track (spec 244). */
  onAdvance: ((key: string) => void) | null = null;
  onRespec: (() => void) | null = null;

  private readonly heading = new Label('', 'body');
  /** Public so a test can assert it hides rather than showing "0 points". */
  readonly pointsLabel = new Label('', 'body');
  private readonly statRows: Label[] = [];
  private readonly statColumn: Column;
  /** One hint per stat row, parallel to `statRows`. What a hover says. */
  private readonly statHints: string[] = [];
  private readonly trackRows = new Map<string, TrackRow>();
  private readonly specializationRows = new Map<string, SpecializationRow>();
  private readonly trackColumn: Column;
  private readonly detailColumn: Column;
  private readonly detailHeading = new Label('', 'body');
  private readonly detailNext = new Label('', 'body');
  /** What the *next point anywhere* would reach. Under the six, above the detail. */
  private readonly nextLabel = new Label('', 'body');
  private readonly respecButton = new Button('', 'character:respec');
  private trackOrder: string[] = [];
  private selectedKey: string | null = null;
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

    this.trackColumn = new Column('character:tracks');
    this.trackColumn.gap = theme.spacing.xs;
    this.detailColumn = new Column('character:detail');
    this.detailColumn.gap = theme.spacing.xs;
    this.detailHeading.colorToken = 'accent';
    this.detailNext.colorToken = 'textDim';
    this.detailNext.wrap = true;
    this.nextLabel.colorToken = 'textDim';
    this.nextLabel.wrap = true;
    this.respecButton.onPress = () => this.onRespec?.();

    // The tabs take whatever is left after the pinned band, and that is spec
    // 198 undoing a note that had been copied into three screens: "no
    // `layoutGrow` on the tabs, a Linear squashes children it cannot fit".
    // True for as long as the panel could not scroll -- and the reason the
    // whole sheet had to live in the mount's ScrollView, which is what scrolled
    // the tab headers off the top of the window. A panel that can be squeezed
    // *and* scrolls its own body is what a window wants; the four widgets above
    // it stay put, which is the point.
    this.tabs.layoutGrow = 1;
    this.addAll([this.heading, this.experience, this.pointsLabel, new Separator('row'), this.tabs]);
  }

  /** Which track's detail is shown. Null until the first view arrives. */
  get selectedTrack(): string | null {
    return this.selectedKey;
  }

  /**
   * Show a track's detail.
   *
   * Public because it is the one piece of screen state the mount and a test both
   * want to drive, and because selection is deliberately *not* replicated: which
   * track somebody is looking at is not a fact about their character.
   */
  selectTrack(key: string): void {
    if (this.selectedKey === key) return;
    this.selectedKey = key;
    if (this.current) this.syncTracks(this.current);
  }

  get trackRowList(): readonly TrackRow[] {
    return [...this.trackRows.values()];
  }

  trackRowFor(key: string): TrackRow | null {
    return this.trackRows.get(key) ?? null;
  }

  get specializationRowList(): readonly SpecializationRow[] {
    return [...this.specializationRows.values()];
  }

  rowFor(specializationId: string): SpecializationRow | null {
    return this.specializationRows.get(specializationId) ?? null;
  }

  /** Replace everything shown. */
  setCharacter(view: CharacterView): void {
    this.current = view;
    this.heading.setText(`${view.name}  LVL ${view.level}`);
    this.experience.setValue(view.experience.current, view.experience.toNext);
    this.experience.caption = `${view.experience.current}/${view.experience.toNext}`;
    // One number, because there is one pool (spec 244). It used to be two
    // clauses -- "3 attribute, 1 skill point(s)" -- which was the right way to
    // say two budgets and would now be the interface inventing a distinction the
    // rules no longer make.
    // Short, because the sheet's smallest supported width is 300px and this line
    // sits above the tab strip: "N attribute, M skill point(s) to spend" was the
    // old two-budget wording and was clipped there.
    this.pointsLabel.setText(
      view.unspentPoints === 1 ? '1 progression point' : `${view.unspentPoints} progression points`,
    );
    this.pointsLabel.visible = view.unspentPoints > 0;

    this.syncStats(view.stats);

    const tabIds = view.tracks.map((track) => track.key);
    if (tabIds.join('|') !== this.trackOrder.join('|')) this.rebuildTabs();
    this.trackOrder = tabIds;

    // Default to the first track rather than to nothing: an empty detail panel
    // under six rows reads as a screen that failed to load, and there is no
    // state in which no track is worth looking at.
    if (this.selectedKey === null || !tabIds.includes(this.selectedKey)) {
      this.selectedKey = tabIds[0] ?? null;
    }

    this.nextLabel.setText(nextChangeLine(view.tracks));
    this.nextLabel.visible = this.nextLabel.text.length > 0;
    this.syncTracks(view);
    this.respecButton.setLabel(`Respec (${view.respec.cost}c)`);
    this.respecButton.enabled = view.respec.enabled;
  }

  /**
   * Walk the six rows and rebuild the detail for whichever is selected.
   *
   * The detail is torn down and rebuilt rather than walked, because switching
   * track changes *which* rows exist -- unlike the six above it, which are the
   * same six forever. Rebuilding drops the `SpecializationRow`s the tooltip may
   * be pointing at, so `specializationRows` is cleared with them and `hintAt`
   * finds nothing rather than a stale rectangle.
   */
  private syncTracks(view: CharacterView): void {
    for (const track of view.tracks) {
      this.trackRows.get(track.key)?.setTrack(track, track.key === this.selectedKey);
    }
    const selected = view.tracks.find((track) => track.key === this.selectedKey);
    this.buildDetail(selected ?? null);
  }

  private buildDetail(track: TrackView | null): void {
    const theme = this.options.theme;
    this.detailColumn.clearChildren();
    this.specializationRows.clear();
    if (!track) return;

    this.detailHeading.setText(`${track.name} ${track.total}`);
    this.detailNext.setText(
      track.nextThreshold > 0
        ? `Next milestone: ${track.nextThreshold} ${track.abbrev}, ${track.toNext} point(s) away`
        : 'Every milestone on this track is reached',
    );
    this.detailColumn.addAll([this.detailHeading, this.detailNext]);

    for (const node of track.nodes) {
      // The threshold line. `--` marks a node whose milestone fires on its own,
      // and the accent says it has been reached: a milestone and a purchase are
      // different promises and this is where a player can see which is which.
      const heading = new Label(
        node.milestone === null
          ? `${node.threshold} ${track.abbrev}`
          : `${node.threshold} ${track.abbrev} -- ${node.milestone.name}`,
        'body',
      );
      heading.colorToken = node.reached ? 'accent' : 'textDim';
      this.detailColumn.add(heading);

      if (node.milestone !== null) {
        const effect = new Label(node.milestone.effect, 'body');
        effect.colorToken = 'textDim';
        effect.wrap = true;
        this.detailColumn.add(effect);
      }

      for (const specialization of node.specializations) {
        const row = new SpecializationRow(specialization.id, theme, (id) => this.onSpend?.(id));
        row.setSpecialization(specialization);
        this.specializationRows.set(specialization.id, row);
        this.detailColumn.add(row);
      }
    }

    this.detailColumn.add(new Separator('row'));
    this.detailColumn.add(this.respecButton);
    // Nothing below this line. There is deliberately no list of two-attribute
    // pairs and no synergy panel (spec 244): the fifteen authored pair bonuses
    // are gone from the game, and a screen that still had a place for them would
    // be an interface promising content the rules do not have.
  }

  /** The stat lines, in the order their hints are, so a test can hover them. */
  get statRowList(): readonly Label[] {
    return this.statRows.filter((row) => row.visible);
  }

  /**
   * What a hover at `at` should say, or empty.
   *
   * Walks the three kinds of row this screen has -- a track, a specialization, a
   * stat line -- and asks whichever one the cursor is inside. Pure: the hit test
   * is against laid-out rectangles and nothing here reads a clock.
   *
   * `showing` rather than `row.visible`, and that is the whole of the fix. A tab
   * switched away is *hidden*, never destroyed -- that is what makes a tab keep
   * what you left in it (spec 124) -- so every row inside one keeps its own
   * `visible` flag true and keeps the rectangle it was last arranged into. Tabs
   * of rows therefore stacked on top of each other at the same coordinates, and
   * a hover over a track was answered by whichever stat line was laid out behind
   * it. Only the ancestor chain knows which tab a row is in.
   */
  hintAt(at: Point): TooltipContent {
    // Every row this screen has lives inside a tab, and a tab's body is a
    // viewport now (spec 198) -- so a row scrolled out of it keeps the rectangle
    // it was last arranged into, above the strip and under the pinned heading.
    // `showing` cannot see that: the row is visible, and so is every ancestor.
    // It is the same class of bug the ancestor walk was written for, one level
    // out: a rect that is still correct for a widget nobody can see.
    if (!contains(this.tabs.bodyViewport(), at)) return '';
    for (const row of this.trackRows.values()) {
      if (this.showing(row) && contains(row.rect, at)) return row.tooltip();
    }
    for (const row of this.specializationRows.values()) {
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

  /**
   * A wheel over the pinned band scrolls the tab under it.
   *
   * The heading, the meter and the points line are outside the panel, so a notch
   * over them bubbles straight past it to the window and dies there -- which is
   * a window that scrolls everywhere except its own top inch, and reads as a
   * broken wheel rather than as a pinned header. A notch over the rows or over
   * the strip never gets this far: the tab's own scroller took it.
   */
  onEvent(context: EventContext): void {
    if (context.event.kind !== 'wheel') return;
    if (this.tabs.wheelBody(context.event.delta)) context.stopPropagation();
  }

  /** Point the tooltip at whatever is under the cursor. Driven by the mount. */
  pointerMoved(at: Point, nowMs: number): void {
    const hint = this.hintAt(at);
    // Length reads the same either way -- an empty string and an empty line
    // list both mean "nothing under the cursor" -- which is what lets the stat
    // lines go on answering with a plain string.
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
   * Register the two tabs.
   *
   * Two, not three: Attributes and Skills were the two halves of a split that no
   * longer exists, and Progression is both of them. Stats stays, because a
   * derived readout is a different kind of information from an investment -- it
   * is what the build *came to*, and merging it into the tracks would put forty
   * numbers between a player and the decision they opened this to make.
   *
   * The factories read {@link current} rather than closing over the view this was
   * called with, and that is a bug rather than a style preference. A tab is built
   * lazily on first selection and then kept (spec 124), so the view a tab is
   * built *from* is the newest one only for whichever tab happens to be selected
   * at registration -- and this runs once, on the first `setCharacter`.
   */
  private rebuildTabs(): void {
    this.trackRows.clear();
    this.specializationRows.clear();
    const theme = this.options.theme;

    this.tabs.addTab('progression', 'Progression', () => this.buildProgression(theme));
    this.tabs.addTab('stats', 'Stats', () => this.statColumn);
  }

  private buildProgression(theme: Theme): Column {
    const column = new Column('character:progression');
    column.gap = theme.spacing.xs;
    this.trackColumn.clearChildren();
    for (const track of this.current?.tracks ?? []) {
      const row = new TrackRow(
        track.key,
        theme,
        (key) => this.selectTrack(key),
        (key) => this.onAdvance?.(key),
      );
      row.setTrack(track, track.key === this.selectedKey);
      this.trackRows.set(track.key, row);
      this.trackColumn.add(row);
    }
    column.addAll([
      this.trackColumn,
      this.nextLabel,
      new Separator('row'),
      this.detailColumn,
    ]);
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
 * The one line under the tracks: what changes next, and how close it is.
 *
 * Picks the *nearest* threshold across all six rather than listing every one,
 * which is the brief's "surface what mechanically changes next" taken literally.
 * A player with 18 Strength is two points from something, and that is the only
 * sentence worth the space; the other five are a menu nobody reads.
 */
export function nextChangeLine(tracks: readonly TrackView[]): string {
  let best: TrackView | null = null;
  for (const track of tracks) {
    if (track.nextEffect.length === 0 || track.toNext <= 0) continue;
    if (!best || track.toNext < best.toNext) best = track;
  }
  if (!best) return '';
  return `${best.toNext} more ${best.abbrev}: ${best.nextEffect}`;
}
