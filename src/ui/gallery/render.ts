/**
 * Render the gallery to pixels, in Node (spec 123).
 *
 * One function, shared by the golden-image test, the PNG writer and the browser
 * preview, so that all three are looking at the same frame. If the goldens and
 * the browser ever disagree, the difference is the backend and not the scene --
 * which is the only way that comparison is worth making.
 */

import { UiRoot } from '../core/root.js';
import { replay } from '../core/draw-list.js';
import { UNBOUNDED, type Size } from '../core/geom.js';
import { bakeAtlas, type Atlas } from '../render/atlas.js';
import { BODY_FONT } from '../text/font.js';
import { RasterSurface } from '../render/raster.js';
import { THEME, type Theme } from '../theme/theme.js';
import type { Widget } from '../core/widget.js';
import { ScrollView } from '../widgets/scroll-view.js';
import { Anchor } from '../core/containers.js';
import { buildGallery } from './gallery.js';
import { buildWindowsScene } from './windows-scene.js';
import { ContextStack } from '../core/events.js';
import { REDUCED_MOTION } from '../core/motion.js';
import { LayerStack } from '../core/layers.js';
import { WindowManager } from '../core/window-manager.js';
import { InputMap } from '../input/input-map.js';
import { KeybindingsScreen } from '../screens/keybindings.js';
import { InventoryScreen, type ContainerView, type ItemDetail, type ItemView, type SlotRef } from '../screens/inventory.js';
import { HudScreen, type HudView } from '../screens/hud.js';
import {
  CharacterScreen,
  type AttributeRowView,
  type CharacterView,
  type SkillView,
} from '../screens/character.js';
import { ChatScreen, chatInsets, type ChatLineView } from '../screens/chat.js';
import { ActionBarScreen, actionBarInsets, type SlotHighlight } from '../screens/action-bar.js';
import type { AbilityView } from '../widgets/skill-slot.js';
import {
  SelectedUnitScreen,
  selectedUnitInsets,
  type StatusRowView,
} from '../screens/selected-unit.js';
import { ShopScreen, type ShopRow, type ShopView } from '../screens/shop.js';
import { Tooltip } from '../widgets/tooltip.js';
import { UiWindow } from '../widgets/window.js';
import { TradeScreen, type TradeUiView } from '../screens/trade.js';
import { AccountScreen, type AccountDraft, type AccountMode, type AccountView } from '../screens/account.js';
import { Tab } from '../widgets/tabs.js';
import { TextField } from '../widgets/text-field.js';

export interface GalleryFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly atlas: Atlas;
  readonly parts: Readonly<Record<string, Widget>>;
}

/**
 * The viewport the goldens are taken at.
 *
 * A plausible desktop UI viewport -- 400x300 is what a 1200x900 window gives at
 * scale 3, or a 1600x1200 one at scale 4. Deliberately not the theme's
 * `minViewport`: the goldens are there to show the widgets, and the *smallest*
 * viewport is what the layout tests assert against instead.
 */
export const GOLDEN_VIEWPORT: Size = { width: 400, height: 300 };

export interface RenderOptions {
  readonly viewport?: Size;
  readonly theme?: Theme;
  /** Which widget to paint as focused, by `parts` key. */
  readonly focusKey?: string;
  /** Which widget to paint as hovered, by `parts` key. */
  readonly hoverKey?: string;
  /** Which widget to paint as pressed, by `parts` key. */
  readonly pressKey?: string;
  readonly now?: number;
  /** Scroll the gallery down before painting, so the lower half can be checked. */
  readonly scrollTo?: number;
}

/**
 * Build, lay out and rasterise the gallery.
 *
 * The forced states go through `PaintContext` rather than through the router, so
 * a golden of the pressed style needs no synthetic pointer event and cannot be
 * knocked over by a change to the drag threshold.
 */
export function renderGallery(options: RenderOptions = {}): GalleryFrame {
  const theme = options.theme ?? THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const gallery = buildGallery(theme);
  const root = new UiRoot(gallery.root, { theme, atlas, viewport });

  root.update(options.now ?? 0);
  if (options.scrollTo !== undefined) {
    const scroller = gallery.parts['galleryScroll'];
    if (scroller instanceof ScrollView) scroller.scrollTo(options.scrollTo);
    root.update(options.now ?? 0);
  }

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));

  const pick = (key: string | undefined): Widget | null =>
    key === undefined ? null : gallery.parts[key] ?? null;

  const list = root.paint();
  const context = {
    ...root.paintContext(),
    hovered: pick(options.hoverKey),
    pressed: pick(options.pressKey),
    focused: pick(options.focusKey),
  };
  // Repaint with the forced context: `root.paint()` used the live one.
  list.clear();
  gallery.root.paint(list, context);
  replay(surface, list.finish());

  return { surface, root, atlas, parts: gallery.parts };
}

export interface WindowsFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly atlas: Atlas;
  readonly scene: ReturnType<typeof buildWindowsScene>;
}

export interface WindowsRenderOptions {
  readonly viewport?: Size;
  readonly now?: number;
  /** Bring this window to the front before painting. */
  readonly focusWindow?: string;
  /** Select this tab in the character window. */
  readonly tab?: string;
  /** Show a tooltip anchored here, with the delay already elapsed. */
  readonly tooltipAt?: { x: number; y: number };
  readonly tooltipText?: string;
  /** Reopen this window at time 0, so it is caught mid-reveal (spec 133). */
  readonly arriving?: string;
  /** ...and refuse the animation, which must give the settled frame exactly. */
  readonly reduced?: boolean;
}

/**
 * The six-window scene, rasterised.
 *
 * Shares nothing with `renderGallery` except the backend, deliberately: the two
 * scenes answer different questions and a helper that did both would be a helper
 * with a mode flag.
 */
export function renderWindows(options: WindowsRenderOptions = {}): WindowsFrame {
  const theme = THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const scene = buildWindowsScene(theme, viewport);
  const root = new UiRoot(scene.root, {
    theme,
    atlas,
    viewport,
    windows: scene.manager,
    layers: scene.root,
  });

  const now = options.now ?? 0;
  if (options.reduced === true) root.setMotion(REDUCED_MOTION);
  if (options.arriving !== undefined) {
    // Shut and reopened at zero, so `now` lands partway through the reveal. The
    // scene builds its windows open, and a window that is already there has
    // nothing to animate.
    scene.manager.close(options.arriving);
    scene.manager.open(options.arriving, 0);
  }
  if (options.tab !== undefined) scene.tabs.select(options.tab);
  if (options.focusWindow !== undefined) scene.manager.focus(options.focusWindow);
  if (options.tooltipAt !== undefined) {
    scene.tooltip.point(options.tooltipText ?? 'A tooltip that flips at the edges', options.tooltipAt, 0);
    scene.tooltip.update(theme.input.tooltipDelayMs + 1, theme.input.tooltipDelayMs);
  }
  root.update(now);

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));
  replay(surface, root.paint().finish());

  return { surface, root, atlas, scene };
}

export interface InventoryFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly screen: InventoryScreen;
}

export interface InventoryRenderOptions {
  readonly viewport?: Size;
  /** Pick this cell up, so the ghost is in the frame. */
  readonly pickUp?: SlotRef;
  /**
   * ...and hold it over this cell. A cell that accepts lights up; one that
   * refuses does not, which is how a refusal reads.
   *
   * A cell rather than a coordinate: the grid's gaps are four pixels wide and a
   * hand-written point lands in one of them about a fifth of the time -- which
   * produces a golden of a drag over nothing that looks exactly like a golden of
   * a highlight that stopped working.
   */
  readonly carryToCell?: SlotRef;
  /** Show the tooltip over this cell, with the delay already elapsed. */
  readonly tooltipOver?: SlotRef;
  /**
   * A skill-slot change in flight, so the commitment is in the frame
   * (spec 188).
   *
   * Worth a golden for the reason the drag cases are: whether the two ends of a
   * change read as a *direction* -- one cell losing something, one gaining it --
   * is a fact about pixels, and the whole feature is that a swap is visible
   * while it happens rather than only once it has.
   */
  readonly pendingSwap?: ContainerView['pendingSwap'];
}

/**
 * A demo bag, dense enough that a golden says something.
 *
 * Written here rather than taken from the game's item table: this scene is the
 * *framework's* QA surface, and a golden that moved every time somebody rebalanced
 * a sword would be a golden nobody trusted.
 */
export function demoContainers(): ContainerView {
  const bag: (ItemView | null)[] = new Array<ItemView | null>(24).fill(null);
  const put = (
    index: number,
    defId: string,
    name: string,
    icon: string,
    slot: string | null,
    count = 1,
    rarity = 'common',
    details: readonly ItemDetail[] = [],
  ): void => {
    bag[index] = { defId, name, count, slot, icon: `item:${icon}`, levelRequirement: 1, rarity, details };
  };
  put(0, 'sword', 'Worn Sword', 'sword', 'mainHand');
  put(1, 'bow', 'Hunting Bow', 'bow', 'mainHand');
  put(2, 'star', 'Weighted Stars', 'star', 'mainHand');
  // One of each tier, and the described lines on the one the tooltip golden
  // opens over: what a rarity is *for* is being different from its neighbours,
  // and a picture of three commons could not show that (spec 185).
  put(3, 'staff', 'Emberwood Staff', 'staff', 'mainHand', 1, 'rare', [
    { text: 'Rare  Main Hand', tone: 'rarity' },
    { text: '+3 Intelligence', tone: 'good' },
    { text: '+20% Spell Power', tone: 'good' },
    { text: '-10% Attack Speed', tone: 'bad' },
    { text: 'Worth 95 coins', tone: 'dim' },
  ]);
  put(6, 'shield', 'Oak Shield', 'shield', 'offHand');
  put(7, 'focus', 'Quartz Focus', 'focus', 'offHand', 1, 'rare');
  put(8, 'potion', 'Minor Salve', 'potion', null, 9);
  put(12, 'stone', 'Bloodstone', 'trinket', 'trinket', 1, 'exceptional');
  put(13, 'legs', "Traveller's Greaves", 'legs', 'legs');
  put(19, 'mystery', 'Something Else', 'nope', null);
  // A sigil, so the skill row and the change-in-flight golden have something
  // real to move (spec 188).
  put(4, 'sigil', 'Sigil of Guard Break', 'sigil', 'skill');

  const worn = (
    defId: string,
    name: string,
    slot: string,
    icon: string,
    levelRequirement: number,
    rarity = 'common',
  ): ItemView => ({ defId, name, count: 1, slot, icon: `item:${icon}`, levelRequirement, rarity, details: [] });

  return {
    bag,
    worn: {
      mainHand: worn('maul', 'Iron Maul', 'mainHand', 'sword', 5, 'rare'),
      offHand: null,
      head: worn('helm', 'Leather Cap', 'head', 'helm', 1),
      chest: worn('jerkin', 'Leather Jerkin', 'chest', 'chest', 1),
      legs: null,
      trinket: worn('band', 'Swiftband', 'trinket', 'trinket', 3, 'rare'),
    },
    slots: [
      { id: 'mainHand', label: 'Main' },
      { id: 'offHand', label: 'Off' },
      { id: 'head', label: 'Head' },
      { id: 'chest', label: 'Chest' },
      { id: 'legs', label: 'Legs' },
      { id: 'trinket', label: 'Charm' },
    ],
    // `accepts` is the family, so one sigil fits any of the four (spec 188).
    skillSlots: [
      { id: 'skill1', label: 'Skill 1', accepts: 'skill' },
      { id: 'skill2', label: 'Skill 2', accepts: 'skill' },
      { id: 'skill3', label: 'Skill 3', accepts: 'skill' },
      { id: 'skill4', label: 'Skill 4', accepts: 'skill' },
    ],
    level: 4,
  };
}

/**
 * The inventory window, rasterised (spec 127).
 *
 * Its own scene for the same reason the keybinding one is: the six-window scene
 * exists to measure a frame budget, and a seventh window would quietly change
 * what that number means.
 */
/**
 * What a window costs around its content: two paddings across, and the title bar
 * plus two paddings down. Mirrors `UiWindow.arrangeSelf` -- read once here so the
 * scene asks for a window that fits rather than one that clips by four pixels.
 */
const WINDOW_CHROME = {
  width: THEME.widget('window').padding * 2,
  height: BODY_FONT.height + THEME.widget('window').padding * 3,
};

export function renderInventory(options: InventoryRenderOptions = {}): InventoryFrame {
  const theme = THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const layers = new LayerStack();
  const manager = new WindowManager();
  layers.place('windows', manager);

  const screen = new InventoryScreen({ theme, hitTest: (at) => layers.hitTest(at) });
  screen.setContainers({
    ...demoContainers(),
    ...(options.pendingSwap === undefined ? {} : { pendingSwap: options.pendingSwap }),
  });
  layers.place('dragGhost', screen.ghost);

  const tooltip = new Tooltip();
  tooltip.viewport = viewport;
  layers.place('tooltip', tooltip);

  // Sized to what the screen actually wants, clamped to the viewport. A window
  // stretched to fill would make the goldens mostly empty panel, and the thing
  // being looked at is the arrangement of the cells.
  const natural = screen.measure({ maxWidth: viewport.width - 16, maxHeight: UNBOUNDED }, { theme, atlas });
  // Scrolled rather than squashed, the same answer the widget gallery reaches:
  // a linear container asked for less room than it needs will compress its
  // children, and cells drawn on top of each other misrepresent the screen. At
  // the golden viewport there is room to spare and the bars never appear.
  const scroller = new ScrollView(screen, 'inventoryScroll');
  const window = new UiWindow(scroller, {
    title: 'Inventory',
    at: { x: 8, y: 8 },
    size: {
      width: Math.min(viewport.width - 16, natural.width + WINDOW_CHROME.width),
      height: Math.min(viewport.height - 16, natural.height + WINDOW_CHROME.height),
    },
  });
  manager.register(window, 'inventory');

  const root = new UiRoot(layers, { theme, atlas, viewport, windows: manager, layers });
  manager.setViewport(viewport);
  root.update(0);

  if (options.pickUp !== undefined) {
    const cell = screen.cellAt(options.pickUp);
    if (cell) {
      screen.pickUp(cell, { x: cell.rect.x + 2, y: cell.rect.y + 2 });
      const over = options.carryToCell === undefined ? null : screen.cellAt(options.carryToCell);
      if (over) {
        screen.drag.moveTo({
          x: over.rect.x + Math.floor(over.rect.width / 2),
          y: over.rect.y + Math.floor(over.rect.height / 2),
        });
      }
    }
  }
  if (options.tooltipOver !== undefined) {
    const cell = screen.cellAt(options.tooltipOver);
    if (cell) {
      tooltip.point(screen.tooltipFor(cell), { x: cell.rect.x + 8, y: cell.rect.y + 8 }, 0);
      tooltip.update(theme.input.tooltipDelayMs + 1, theme.input.tooltipDelayMs);
    }
  }
  root.update(0);

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));
  replay(surface, root.paint().finish());

  return { surface, root, screen };
}

export interface PlayFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly hud: HudScreen;
  readonly sheet: CharacterScreen;
}

export interface PlayRenderOptions {
  readonly viewport?: Size;
  /** How far through a cast, or null for nothing winding up. */
  readonly cast?: number;
  /** Slot index -> how much cooldown is left, 0..1. */
  readonly cooldowns?: Readonly<Record<number, number>>;
  /** Drain the pool, so the unaffordable treatment is in the frame. */
  readonly resource?: number;
  /** Which character-sheet tab to show. */
  readonly tab?: string;
  /** Spend these first, so a locked branch and a filled row are in the frame. */
  readonly spend?: readonly string[];
  /**
   * Scroll the open tab's body this far, in UI pixels (spec 198).
   *
   * Clamped by the scroller, so a number past the end is "as far as it goes" --
   * which is the frame worth having, since the claim is about what is still on
   * screen when there is nothing left to scroll.
   */
  readonly scrollBody?: number;
}

// Real ability ids, because the row draws real icons and a made-up id would
// draw the unknown box -- but fake costs, because what is being photographed is
// the widget rather than the table. Repointed at surviving rows by spec 232.
const DEMO_ABILITIES: readonly { readonly id: string; readonly icon: string; readonly cost: number }[] = [
  { id: 'melee.slash', icon: 'ability:slash', cost: 0 },
  { id: 'skill.guardBreak', icon: 'ability:guardBreak', cost: 12 },
  { id: 'skill.stunningBlow', icon: 'ability:stunningBlow', cost: 8 },
  { id: 'skill.whirlwind', icon: 'ability:whirlwind', cost: 14 },
  { id: 'skill.cripplingStrike', icon: 'ability:cripplingStrike', cost: 10 },
  { id: 'skill.poisonDart', icon: 'ability:poisonDart', cost: 22 },
  { id: 'skill.rendingCut', icon: 'ability:rendingCut', cost: 18 },
  { id: 'self.hearthdraught', icon: 'item:potion', cost: 16 },
];

const DEMO_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8'];

/**
 * A HUD to photograph.
 *
 * Local rather than built from the game's tables, like the inventory's demo bag
 * and for the same reason: a golden that moved when somebody retuned a cooldown
 * would be a golden nobody trusted.
 */
export function demoHud(options: PlayRenderOptions = {}): HudView {
  const resource = options.resource ?? 34;
  return {
    health: { current: 84, max: 138 },
    resource: { current: resource, max: 50 },
    cast: options.cast === undefined ? null : { name: 'Iron Maul', progress: options.cast },
    slots: DEMO_ABILITIES.map((ability, index) => {
      const sweep = options.cooldowns?.[index] ?? 0;
      return {
        id: ability.id,
        name: ability.id,
        icon: ability.icon,
        cost: ability.cost,
        sweep,
        affordable: resource >= ability.cost,
        secondsLeft: sweep * 8,
      };
    }),
    keyLabels: DEMO_KEYS,
  };
}

/**
 * A character sheet to photograph.
 *
 * Written out here rather than run through the game's adapter, for two reasons.
 * `src/ui/` may not import the game's renderer at all -- lint refuses it, and it
 * refused this on the first attempt -- and a golden built from the live skill
 * table would move every time somebody retuned a branch. The *adapter* is tested
 * against the real rules in `character-model.test.ts`; this is a picture.
 */
function attribute(
  key: string,
  name: string,
  abbrev: string,
  allocated: number,
  total: number,
  nextEffect: string,
  toNext: number,
): AttributeRowView {
  return {
    key,
    name,
    abbrev,
    description: `What ${name} is for.`,
    allocated,
    total,
    canAllocate: true,
    blockedBecause: '',
    nextEffect,
    toNext,
    active: [],
  };
}

export function demoCharacter(spend: readonly string[] = []): CharacterView {
  const taken = new Set(spend);
  const points = Math.max(0, 3 - spend.length);
  const skill = (id: string, name: string, tier: number, blocked: string): SkillView => ({
    id,
    name,
    tier,
    level: taken.has(id) ? 1 : 0,
    maxLevel: 3,
    description: `${name}: what it does, in a sentence long enough to wrap.`,
    canSpend: points > 0 && blocked === '',
    blockedBecause: blocked,
  });

  return {
    name: 'Kestrel',
    level: 6,
    experience: { current: 180, toNext: 400 },
    unspentPoints: points,
    unspentAttributePoints: 4,
    stats: [
      { label: 'Health', value: '138', hint: 'what Health does, in one line' },
      { label: 'Damage', value: '12', hint: 'what Damage does, in one line' },
      { label: 'Range', value: '56', hint: 'what Range does, in one line' },
      { label: 'Speed', value: '2.0/s', hint: 'what Speed does, in one line' },
      { label: 'Armour', value: '12%', hint: 'what Armour does, in one line' },
      { label: 'Crit', value: '5%', hint: 'what Crit does, in one line' },
      { label: 'Guard', value: '84', hint: 'what Guard does, in one line' },
      { label: 'Stagger', value: '22', hint: 'what Stagger does, in one line' },
    ],
    // The gallery is a picture, not a fixture (spec 147): a plausible spread,
    // and no pair list, because the sheet does not have one.
    attributes: [
      attribute('strength', 'Strength', 'STR', 21, 21, 'Committed Swing — while winding up an attack you ignore 60% of incoming poise damage.', 14),
      attribute('agility', 'Agility', 'AGI', 26, 28, 'Mobile Offense — each Flow stack also cuts 6% off your follow-through.', 9),
      attribute('intelligence', 'Intelligence', 'INT', 8, 8, 'Spell Shaping — your abilities gain radius and range with Intelligence.', 12),
      attribute('constitution', 'Constitution', 'CON', 25, 25, 'Hard to Kill — below 30% health you cannot be staggered and take 20% less damage.', 10),
      attribute('perception', 'Perception', 'PER', 24, 24, 'Opening Read — an enemy that has just committed an attack is Vulnerable for 0.75s.', 11),
      attribute('wisdom', 'Wisdom', 'WIS', 5, 5, 'Resource Discipline — an ability that connects grants Attuned.', 15),
    ],
    respec: { cost: 40, enabled: true },
    branches: [
      {
        id: 'attr:strength',
        name: 'STR',
        pointsSpent: spend.filter((id) => id.startsWith('str.')).length,
        skills: [
          skill('str.crushingBlows', 'Crushing Blows', 1, ''),
          skill('str.unstoppable', 'Unstoppable', 3, 'Unstoppable needs 40 Strength, you have 21'),
        ],
      },
      {
        id: 'attr:agility',
        name: 'AGI',
        pointsSpent: 0,
        skills: [skill('agi.quickRecovery', 'Quick Recovery', 1, '')],
      },
      {
        id: 'attr:wisdom',
        name: 'WIS',
        pointsSpent: 0,
        skills: [skill('wis.discipline', 'Resource Discipline', 1, 'Resource Discipline needs 10 Wisdom, you have 5')],
      },
    ],
  };
}


/**
 * The HUD over a window with the character sheet in it (spec 128).
 *
 * Both in one frame because that is how they are actually seen -- a sheet open
 * over a fight -- and because it puts a `hud` layer and a `windows` layer in the
 * same picture, which is the arrangement the layer order exists for.
 */
export function renderPlay(options: PlayRenderOptions = {}): PlayFrame {
  const theme = THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const layers = new LayerStack();
  const manager = new WindowManager();
  layers.place('windows', manager);

  const hud = new HudScreen({ theme });
  hud.setView(demoHud(options));
  // Anchored bottom-left, where a HUD lives. The layer fills the viewport and a
  // screen dropped straight into it would sit in the top-left corner under the
  // first window somebody opened.
  const hudFrame = new Anchor('hudFrame');
  hudFrame.pointerTransparent = true;
  hudFrame.place(hud, 'bottomLeft');
  layers.place('hud', hudFrame);

  const sheet = new CharacterScreen({ theme });
  sheet.setCharacter(demoCharacter(options.spend ?? []));
  // Not in a `ScrollView`: the sheet pins its heading and its tab strip and
  // scrolls the tab's own body (spec 198), which it can only do when it is
  // handed the window's real height.
  const window = new UiWindow(sheet, {
    title: 'Character',
    at: { x: 150, y: 8 },
    size: {
      width: Math.max(120, Math.min(viewport.width - 158, 200)),
      height: Math.max(80, Math.min(viewport.height - 16, 220)),
    },
  });
  manager.register(window, 'character');

  const root = new UiRoot(layers, { theme, atlas, viewport, windows: manager, layers });
  manager.setViewport(viewport);
  root.update(0);
  if (options.tab !== undefined) sheet.tabs.select(options.tab);
  // Re-set after the tab is open: a tab's content is built on first selection
  // (spec 124), so its rows have never been told what is in them.
  sheet.setCharacter(demoCharacter(options.spend ?? []));
  root.update(0);
  if (options.scrollBody !== undefined) {
    sheet.tabs.bodyScroller?.scrollTo(options.scrollBody);
    root.update(0);
  }

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));
  replay(surface, root.paint().finish());

  return { surface, root, hud, sheet };
}

export interface ChatFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly chat: ChatScreen;
}

export interface ChatRenderOptions {
  readonly viewport?: Size;
  /** Leave the input line closed, as it is while somebody is just reading. */
  readonly closed?: boolean;
  /** Catch it partway out, so the wipe is in the frame (spec 189). */
  readonly reveal?: number;
  /** Something half-typed, so the field has a caret in it and content behind it. */
  readonly typing?: string;
  /** Nothing said yet, which is what a fresh session opens on. */
  readonly empty?: boolean;
}

/**
 * The chat, open, with one line per channel (spec 189).
 *
 * One of each on purpose: the three channels differ only in colour, so a frame
 * holding one of them says nothing about whether the other two are right -- and
 * "a channel drawn in the wrong tone" is precisely the failure that no assertion
 * about a draw list would notice and a person reading a diff would.
 */
export function renderChat(options: ChatRenderOptions = {}): ChatFrame {
  const theme = THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const layers = new LayerStack();

  const chat = new ChatScreen({ theme });
  // Docked the way the mount docks it: bottom-left, inside an anchor that fills
  // the frame. See `renderPlay` above for why the anchor is not optional.
  const dock = new Anchor('chatDock');
  dock.pointerTransparent = true;
  dock.padding = chatInsets(theme, 0);
  dock.place(chat, 'bottomLeft');
  layers.place('hud', dock);

  const root = new UiRoot(layers, { theme, atlas, viewport, layers });
  const focus = {
    focus: (widget: Widget | null): boolean => root.focus.focus(widget),
    push: (id: 'textEntry'): void => {
      root.pushContext(id);
    },
    pop: (id: 'textEntry'): void => {
      root.popContext(id);
    },
  };
  if (options.closed !== true) {
    chat.open(focus);
    if (options.typing !== undefined) chat.setInputText(options.typing);
  }
  chat.setView({ lines: options.empty === true ? [] : DEMO_CHAT, reveal: options.reveal ?? 1 });
  root.update(0);
  chat.settle();
  root.update(0);

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));
  replay(surface, root.paint().finish());

  return { surface, root, chat };
}

/**
 * The two things the Play tab draws over the world with no window open
 * (spec 196): the action bar along the bottom and the mini HUD in the corner.
 *
 * One frame rather than two, because what a person reading a diff needs to see
 * is the *band* -- five slots at the framework's own size, a panel in the
 * opposite corner, and neither of them touching the other. Two frames would
 * halve the ink and hide exactly the thing a golden is for.
 */
export interface WorldHudFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly bar: ActionBarScreen;
  readonly selected: SelectedUnitScreen;
}

export interface WorldHudRenderOptions {
  readonly viewport?: Size;
  /** Nothing selected, which is what most of a session looks like. */
  readonly noSelection?: boolean;
  /** A body at the end of its life, so the bar says the word rather than 0/60. */
  readonly dead?: boolean;
  /** Slot index -> fraction of its cooldown still to run. */
  readonly cooldowns?: Readonly<Record<number, number>>;
  /** Resource left, so the unaffordable frame is in the picture. */
  readonly poor?: boolean;
  /** Which slot is lit, and why. */
  readonly highlight?: { readonly slot: number; readonly kind: SlotHighlight };
  /** A skill-slot change in flight over a slot (spec 188). */
  readonly change?: { readonly slot: number; readonly progress: number };
}

/**
 * The four skills and the vial, as a character with two sigils has them.
 *
 * The sprite names are written out rather than resolved, because `src/ui/` may
 * not read the game's renderer and `abilityIconFor` lives there. What that
 * costs is exactly the failure this frame was blind to on its first outing --
 * every one of these drew `item:unknown` in the shipped bar, the icon table
 * having no row for a skill or for the flask -- so the *mapping* is asserted in
 * `action-bar-model.test.ts` instead, where the table can be read.
 */
const DEMO_BAR: readonly (AbilityView | null)[] = [
  { id: 'skill.guardBreak', name: 'Guard Break', icon: 'ability:guardBreak', cost: 12, sweep: 0, affordable: true, secondsLeft: 0 },
  null,
  { id: 'skill.whirlwind', name: 'Whirlwind', icon: 'ability:whirlwind', cost: 22, sweep: 0, affordable: true, secondsLeft: 0 },
  { id: 'skill.stunningBlow', name: 'Stunning Blow', icon: 'ability:stunningBlow', cost: 18, sweep: 0, affordable: true, secondsLeft: 0 },
  { id: 'self.hearthdraught', name: 'Draught', icon: 'item:potion', cost: 0, sweep: 0, affordable: true, secondsLeft: 0 },
];

/** A grazer with one of each kind on it, so both tones are in the frame. */
const DEMO_STATUSES: readonly StatusRowView[] = [
  { id: 'flow', label: 'Flow x2', remaining: '1.2s', tone: 'boon', fading: false },
  { id: 'exposed', label: 'Exposed', remaining: '4.0s', tone: 'affliction', fading: false },
  { id: 'sundered', label: 'Sundered', remaining: '0.1s', tone: 'affliction', fading: true },
];

export function renderWorldHud(options: WorldHudRenderOptions = {}): WorldHudFrame {
  const theme = THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const layers = new LayerStack();

  // The size the mount converts `ACTION_SLOT_CSS` into on a desktop, which is
  // where a person reading a diff is: a golden of a slot at the widget's bare
  // default would be a picture of a size the game never draws.
  const bar = new ActionBarScreen({ theme, slotCount: DEMO_BAR.length, slotSide: 46 });
  const barDock = new Anchor('barDock');
  barDock.pointerTransparent = true;
  barDock.padding = actionBarInsets(theme, 0);
  barDock.place(bar, 'bottom');
  layers.place('hud', barDock);

  const selected = new SelectedUnitScreen({ theme });
  const selectedDock = new Anchor('selectedDock');
  selectedDock.pointerTransparent = true;
  selectedDock.padding = selectedUnitInsets(theme, 0);
  selectedDock.place(selected, 'topRight');
  layers.place('hud', selectedDock);

  const root = new UiRoot(layers, { theme, atlas, viewport, layers });

  bar.setView({
    slots: DEMO_BAR.map((entry, index) => ({
      ability:
        entry === null
          ? null
          : {
              ...entry,
              sweep: options.cooldowns?.[index] ?? 0,
              secondsLeft: (options.cooldowns?.[index] ?? 0) * 8,
              affordable: options.poor !== true || entry.cost === 0,
            },
      keyLabel: String(index + 1),
      hint: entry === null ? [] : [{ text: entry.name }],
      badge: index === DEMO_BAR.length - 1 ? '2/3' : '',
      highlight: options.highlight?.slot === index ? options.highlight.kind : null,
      change:
        options.change?.slot === index ? { label: 'EQUIP', progress: options.change.progress } : null,
    })),
  });

  selected.setView(
    options.noSelection === true
      ? null
      : {
          name: 'Grazer',
          detail: 'Lv 3',
          health: options.dead === true ? { current: 0, max: 60 } : { current: 41, max: 60 },
          dead: options.dead === true,
          statuses: DEMO_STATUSES,
        },
  );

  root.update(0);

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));
  replay(surface, root.paint().finish());

  return { surface, root, bar, selected };
}

/**
 * One line per channel, plus a long one so the wrap is in the picture.
 *
 * The wrapped line is a say, because a say is the one whose first row is drawn
 * in two colours -- so a golden of it is also the check that the speaker's
 * colour stops where the speaker's name does.
 */
export const DEMO_CHAT: readonly ChatLineView[] = [
  { id: 1, channel: 1, from: '', text: 'Grazer was slain by Bru' },
  { id: 2, channel: 0, from: 'Ada', text: 'watch the ravager on the left, it has not been pulled yet' },
  { id: 3, channel: 2, from: '', text: 'restarting in five minutes' },
  { id: 4, channel: 0, from: 'Bru', text: 'on my way' },
];

export interface ShopFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly shop: ShopScreen;
}

export interface ShopRenderOptions {
  readonly viewport?: Size;
  /** Open the sell confirmation on this row, so the modal is in the frame. */
  readonly confirmRow?: number;
  /** Show the buyback list with something in it. */
  readonly buyback?: boolean;
  /** A thinner purse, so the greyed-out treatment is in the frame. */
  readonly coins?: number;
  /** Catch the dialog partway through arriving, at this time (spec 133). */
  readonly confirmArrivingAt?: number;
}

/**
 * A shop to photograph.
 *
 * Written out here rather than run through the game's adapter, for the reason
 * `demoCharacter` gives: `src/ui/` may not import the game's renderer, and a
 * golden built from the live tables would move every time somebody retuned a
 * price.
 */
export function demoShop(options: ShopRenderOptions = {}): ShopView {
  const coins = options.coins ?? 60;
  // `affordable` is a *purchase* rule. Selling does not depend on the purse, and
  // the first bake of these goldens greyed out a Hunting Bow because the player
  // had eight coins -- which is nonsense, and which nothing but the picture was
  // ever going to say.
  const line = (defId: string, name: string, price: number, count = 1, affordable = true): ShopRow => ({
    defId,
    name,
    icon: `item:${defId}`,
    count,
    price,
    enabled: affordable,
    blockedBecause: affordable ? '' : `${price} coins, and you have ${coins}`,
  });
  const forSale = (defId: string, name: string, price: number, count = 1): ShopRow =>
    line(defId, name, price, count, price <= coins);

  return {
    name: 'Quartermaster',
    coins,
    stock: [
      forSale('potion', 'Minor Salve', 9),
      forSale('sword', 'Worn Sword', 18),
      forSale('shield', 'Oak Shield', 60),
      forSale('chest', 'Scalemail', 240),
    ],
    sellable: [
      { ...line('bow', 'Hunting Bow', 12), index: 3 },
      { ...line('helm', 'Leather Cap', 6), index: 5 },
      { ...line('potion', 'Minor Salve', 6, 3), index: 9 },
    ],
    buyback: options.buyback ? [forSale('legs', "Traveller's Greaves", 7)] : [],
  };
}

/**
 * The shop, rasterised, with its confirmation optionally up (spec 130).
 *
 * The modal case is the one that could not be checked any other way: whether the
 * dialog is drawn *over* the shop rather than behind it is a fact about the
 * layer order, and the layer order is only visible in pixels.
 */
export function renderShop(options: ShopRenderOptions = {}): ShopFrame {
  const theme = THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const layers = new LayerStack();
  const manager = new WindowManager();
  layers.place('windows', manager);

  const contexts = new ContextStack();
  const root = new UiRoot(layers, { theme, atlas, viewport, windows: manager, layers });
  const shop = new ShopScreen({ theme, contexts, focus: root.focus });
  shop.setShop(demoShop(options));
  layers.place('modal', shop.dialog);

  manager.register(
    new UiWindow(new ScrollView(shop, 'shopScroll'), {
      title: 'Shop',
      at: { x: 8, y: 8 },
      size: { width: Math.min(viewport.width - 16, 220), height: Math.min(viewport.height - 16, 260) },
    }),
    'shop',
  );
  manager.setViewport(viewport);
  root.update(0);

  if (options.confirmRow !== undefined) {
    // With a time it arrives, without one it is already there -- and it has to
    // be one or the other, because a dialog that is open ignores a second ask.
    shop.askToSell(options.confirmRow, options.confirmArrivingAt === undefined ? undefined : 0);
    root.update(options.confirmArrivingAt ?? 0);
  }

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));
  replay(surface, root.paint().finish());

  return { surface, root, shop };
}

export interface KeybindingsFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly screen: KeybindingsScreen;
  readonly map: InputMap;
}

export interface KeybindingsRenderOptions {
  readonly viewport?: Size;
  /** Which category tab to show. */
  readonly tab?: string;
  /** Type into the filter field. */
  readonly filter?: string;
  /** Show the row waiting for a key. */
  readonly capture?: { readonly actionId: string; readonly slot: 'primary' | 'secondary' };
  /** Rebind this action to this chord first, so a conflict notice is in the frame. */
  readonly rebind?: { readonly actionId: string; readonly code: string };
  /** Unbind this action, so the flagged state is in the frame. */
  readonly unbind?: string;
}

/**
 * The keybinding window, rasterised (spec 125).
 *
 * Its own scene rather than a seventh window in the six-window one, so the frame
 * budget that scene exists to measure keeps meaning what it says.
 */
export function renderKeybindings(options: KeybindingsRenderOptions = {}): KeybindingsFrame {
  const theme = THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const map = new InputMap();
  const contexts = new ContextStack();
  const screen = new KeybindingsScreen({ theme, map, contexts });
  screen.buildAllTabs();

  if (options.unbind !== undefined) {
    map.bind(options.unbind, 'primary', null);
    map.bind(options.unbind, 'secondary', null);
  }
  if (options.rebind !== undefined) {
    screen.beginCapture(options.rebind.actionId, 'primary');
    screen.captureKey(options.rebind.code, { shift: false, ctrl: false, alt: false, meta: false });
  }
  if (options.tab !== undefined) screen.tabs.select(options.tab);
  if (options.filter !== undefined) screen.filter.setText(options.filter);
  if (options.capture !== undefined) screen.beginCapture(options.capture.actionId, options.capture.slot);
  screen.refresh();

  const window = new UiWindow(screen, {
    title: 'Keybindings',
    at: { x: 8, y: 8 },
    size: { width: viewport.width - 16, height: viewport.height - 16 },
  });
  const manager = new WindowManager();
  const layers = new LayerStack();
  layers.place('windows', manager);
  manager.register(window, 'keybindings');

  const root = new UiRoot(layers, { theme, atlas, viewport, windows: manager, layers });
  manager.setViewport(viewport);
  root.update(0);

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));
  replay(surface, root.paint().finish());

  return { surface, root, screen, map };
}

/**
 * Rules good enough to exercise the account screen, and deliberately not the
 * real ones.
 *
 * The genuine rule is `draftProblem` in `world/account-model.ts`, and it is out
 * of reach from here on purpose: it imports the server's own
 * `validateLogin`/`validatePassword`, and this directory may not import
 * `src/render/` -- the same fence that makes `AccountScreen.options.validate`
 * an injected capability rather than something the screen reads off a
 * singleton. So the gallery states its own version, close enough to produce a
 * refused draft for `account-refused` and openly not the rule a real client
 * runs -- the same standing `demoShop`'s stock has against `data/items.ts`.
 */
function accountDraftProblem(draft: AccountDraft): string {
  if (draft.mode === 'signIn') {
    if (draft.login.trim().length === 0) return 'enter your login';
    if (draft.password.length === 0) return 'enter your password';
    return '';
  }
  if (draft.login.trim().length < 3) return 'login must be at least 3 characters';
  if (draft.password.length < 8) return 'password must be at least 8 characters';
  if (draft.confirm !== draft.password) return 'the two passwords do not match';
  return '';
}

/** Find a widget by name inside the screen, the way `account.test.ts` does. */
function findInAccount<T>(screen: AccountScreen, name: string, kind: new (...args: never[]) => T): T | null {
  for (const found of screen.walk()) {
    if (found.name === name && found instanceof (kind as never)) return found as T;
  }
  return null;
}

/** Type into a named field, firing `onChange` the way a keystroke does. */
function typeIntoAccount(screen: AccountScreen, name: string, value: string): void {
  const input = findInAccount(screen, name, TextField);
  if (input === null) return;
  input.setText(value);
  input.onChange?.(value);
}

export interface AccountFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly screen: AccountScreen;
}

export interface AccountRenderOptions {
  readonly viewport?: Size;
  /** Which tab is selected. The screen itself opens on Register. */
  readonly mode?: AccountMode;
  /** Type these into the form's fields before the frame is drawn. */
  readonly draft?: {
    readonly login?: string;
    readonly password?: string;
    readonly confirm?: string;
    readonly displayName?: string;
  };
  /** What the server says this session is, pushed through `setAccount`. */
  readonly account?: AccountView;
}

/**
 * The account window, rasterised (spec 227).
 *
 * Its own scene rather than a seventh window in the six-window one, for the
 * reason `renderKeybindings` states: the frame budget that scene exists to
 * measure keeps meaning what it says.
 */
export function renderAccount(options: AccountRenderOptions = {}): AccountFrame {
  const theme = THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const contexts = new ContextStack();
  const screen = new AccountScreen({ theme, contexts, validate: accountDraftProblem });

  // The mode is driven through the tab's own `onSelect`, the way a click would
  // reach it, rather than by reaching into the screen's private `modes` field.
  if (options.mode !== undefined) {
    const tabName = options.mode === 'signIn' ? 'tab:account:modeSignIn' : 'tab:account:modeRegister';
    findInAccount(screen, tabName, Tab)?.onSelect?.();
  }
  if (options.draft?.login !== undefined) typeIntoAccount(screen, 'account:login', options.draft.login);
  if (options.draft?.password !== undefined) typeIntoAccount(screen, 'account:password', options.draft.password);
  if (options.draft?.confirm !== undefined) typeIntoAccount(screen, 'account:confirm', options.draft.confirm);
  if (options.draft?.displayName !== undefined) typeIntoAccount(screen, 'account:name', options.draft.displayName);
  if (options.account !== undefined) screen.setAccount(options.account);

  const window = new UiWindow(screen, {
    title: 'Account',
    at: { x: 8, y: 8 },
    size: { width: viewport.width - 16, height: viewport.height - 16 },
  });
  const manager = new WindowManager();
  const layers = new LayerStack();
  layers.place('windows', manager);
  manager.register(window, 'account');

  const root = new UiRoot(layers, { theme, atlas, viewport, windows: manager, layers });
  manager.setViewport(viewport);
  root.update(0);

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));
  replay(surface, root.paint().finish());

  return { surface, root, screen };
}

export interface TradeFrame {
  readonly surface: RasterSurface;
  readonly root: UiRoot;
  readonly screen: TradeScreen;
}

export interface TradeRenderOptions {
  readonly viewport?: Size;
  /** Show the ending instead of a live table. */
  readonly over?: boolean;
}

/**
 * A trade to photograph (spec 134).
 *
 * Written out here rather than run through the game's adapter, for the reason
 * `demoShop` gives: `src/ui/` may not import the game's renderer, and a golden
 * built from the live tables would move every time somebody renamed an item.
 */
export function demoTrade(options: TradeRenderOptions = {}): TradeUiView {
  const bag: (ItemView | null)[] = [
    { defId: 'bow', name: 'Hunting Bow', count: 1, slot: 'mainHand', icon: 'item:bow', levelRequirement: 1, rarity: 'common', details: [] },
    { defId: 'potion', name: 'Minor Salve', count: 3, slot: null, icon: 'item:potion', levelRequirement: 1, rarity: 'common', details: [] },
    { defId: 'helm', name: 'Leather Cap', count: 1, slot: 'head', icon: 'item:helm', levelRequirement: 1, rarity: 'common', details: [] },
    null,
    null,
    null,
  ];
  return {
    stage: options.over === true ? 'over' : 'open',
    // The golden's ending is a cancellation -- the reason below says so -- so it
    // is drawn in the refusal colour, which is what it was before there was a
    // second kind of ending to tell it apart from.
    succeeded: false,
    // The golden is a table in progress rather than an invitation, so neither
    // the role split nor the warning is in the picture.
    invited: false,
    warning: '',
    you: { name: 'You', rows: [{ name: 'Hunting Bow', count: 1 }], coins: 20, accepted: false },
    them: { name: 'Kestrel', rows: [{ name: 'Oak Shield', count: 1 }], coins: 0, accepted: true },
    bag,
    offered: [0],
    coins: 20,
    purse: 60,
    revision: 3,
    reason: options.over === true ? 'cancelled -- you walked too far apart' : '',
  };
}

/** The trade window, rasterised. Its own scene, like every screen since 127. */
export function renderTrade(options: TradeRenderOptions = {}): TradeFrame {
  const theme = THEME;
  const viewport = options.viewport ?? GOLDEN_VIEWPORT;
  const atlas = bakeAtlas(theme);
  const layers = new LayerStack();
  const manager = new WindowManager();
  layers.place('windows', manager);

  const screen = new TradeScreen({ theme });
  screen.setTrade(demoTrade(options));
  const scroller = new ScrollView(screen, 'tradeScroll');
  manager.register(
    new UiWindow(scroller, {
      title: 'Trade',
      at: { x: 8, y: 8 },
      size: { width: Math.min(viewport.width - 16, 200), height: Math.min(viewport.height - 16, 280) },
    }),
    'trade',
  );

  const root = new UiRoot(layers, { theme, atlas, viewport, windows: manager, layers });
  manager.setViewport(viewport);
  root.update(0);

  const surface = new RasterSurface(atlas, viewport.width, viewport.height);
  surface.clear(theme.color('ink'));
  replay(surface, root.paint().finish());
  return { surface, root, screen };
}
