/**
 * The overlay over the world view (spec 063): health bars, cast bars, damage
 * numbers, the hotbar and a status line.
 *
 * DOM rather than geometry, and positioned by projecting each body to a canvas
 * pixel (`WorldScene.screenAnchors`) -- except the damage numbers, which are
 * projected from a world point of their own (spec 096), because they belong to
 * the ground a blow landed on rather than to a body that may be walking away
 * from it or gone.
 *
 * The scene renders into a low-resolution buffer and puts the result through
 * the dither pass (spec 038), which is exactly right for the world and exactly
 * wrong for a number you are supposed to read -- text through that filter comes
 * out as chewed pixels. Floating it over the canvas keeps the world chunky and
 * the readout crisp.
 *
 * Everything here is a function of what the server said. The bars are drawn from
 * replicated health and from `CastState`; the hotbar's lit/unlit is whether a
 * cast is in progress, not whether a key is down. No `if` in this file changes
 * an outcome -- the buttons ask, and the server answers.
 */

import type { ClientView } from '../../../server/client/game-client.js';
import type { ScreenAnchor } from './scene.js';
import {
  abilityById,
  BASIC_ATTACK_ID,
  type AbilityDefinition,
} from '../../../server/data/abilities.js';
import { ALL_ITEMS } from '../../../server/data/items.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { SERVER_TICK_RATE } from '../../../server/config.js';
import { castBar } from './cast.js';
import { aimGesture } from './aim.js';
import { appearanceOf, displayName } from './appearance.js';
import { pixelTextSvg } from './pixel-font.js';
import type { RarityId } from '../../../server/data/items.js';

/** How far above the drop the name floats, in world units. */
const DROP_LABEL_LIFT = 34;

/**
 * The tier's colour in *text* (spec 158).
 *
 * Separate values from `drop-rig.ts`'s mesh colours and deliberately so: those
 * are lit and go through the retro pass, and these are 12px type on a dark
 * plate that has to stay readable. Same three tiers, two different jobs.
 */
const DROP_LABEL_COLOR: Record<RarityId, string> = {
  common: '#cfd6e0',
  rare: '#8ec5ff',
  exceptional: '#ffd489',
};
import { isHandheldDevice } from '../device.js';
import { DamagePopups, type Projector, type WorldAnchor } from './damage-popup.js';
import { ErrorLog } from './error-log.js';
import { HealthFlashes } from './health-bar.js';
import {
  ACTION_SLOT_CSS,
  bottomEdge,
  bottomGroupWidth,
  NO_ACTION_BAR,
  poolReserve,
  type ActionBarBox,
  errorStackBottom,
  hudLayout,
  poolBottom,
  readoutShown,
} from './hud-layout.js';
import {
  statusIconSvg,
  stunIconSvg,
  systemIconSvg,
  weaponIconSvg,
  type SystemIconId,
} from './icons.js';
import { stunMark } from './stun-icon.js';
import { statusMarks } from './status-marks.js';
import { MAX_VISIBLE_STATUSES, visualFor } from '../../../server/data/status-visuals.js';
import { describeAbility, describeStatus, technicalText } from '../../../server/data/description.js';
import { BAR_SLOT_COUNT } from './action-bar.js';
import {
  swapOverhead,
} from './skill-swap-view.js';
import { deathOverlay } from './death.js';
import { poolBars } from './pool-bars.js';
import { xpBar, XP_SUBDIVISIONS } from './xp-bar.js';
import type { WindowId } from './control-actions.js';

/** The slot being aimed (spec 080). The aim indicator's colour, in the DOM. */

/**
 * The refusal stack's ink (spec 143, the wind-up warnings).
 *
 * Bright rather than blood-coloured: it is drawn over a world that already has
 * dark reds in it -- the health bars, the blood -- and a warning has to be the
 * most saturated thing in its corner or it reads as scenery.
 */
const ERROR_RED = '#ff3b3b';

/**
 * The drawn tick as milliseconds, for the effects on a floating bar (specs
 * 145/146).
 *
 * `update` is handed a frame timestamp too, and this is deliberately not it: a
 * refusal decays in real seconds because a player is reading it, while the white
 * chunk and the flinch belong to the *bodies*, and are timed by the same drawn
 * tick those bodies are interpolated by. One clock each, for two different
 * things.
 */
const TICK_MS = 1000 / SERVER_TICK_RATE;

/**
 * One main-hand weapon per distinct auto-attack (spec 079).
 *
 * Derived from the item table rather than listed, so a crossbow added there
 * turns up here without this file being told. The *attack* is what the switch
 * is really choosing -- two swords that both slash are one entry, because
 * picking between them would change numbers and not the motion.
 */
export const WEAPON_SWITCH: readonly {
  readonly itemId: string;
  readonly name: string;
  readonly abilityId: string;
}[] = (() => {
  const byAttack = new Map<string, { itemId: string; name: string; abilityId: string }>();
  for (const item of ALL_ITEMS) {
    if (item.slot !== 'mainHand') continue;
    const abilityId = item.basicAttackId ?? BASIC_ATTACK_ID;
    if (byAttack.has(abilityId)) continue;
    byAttack.set(abilityId, { itemId: item.id, name: item.name, abilityId });
  }
  return [...byAttack.values()];
})();

/**
 * The windows a player can decide to open, as buttons (spec 140).
 *
 * Three, and not the shop or the trade table: those two are opened by something
 * *happening* -- a vendor within reach, another player's invitation -- rather
 * than by a player deciding to go and look, so a permanent button for either
 * would be a button that is usually a refusal.
 *
 * The keyboard opens the same windows through the same `ui.toggle`; a button
 * here carries an id and nothing else, so a button and a key cannot come to
 * mean different things.
 */
export const SYSTEM_BUTTONS: readonly {
  readonly id: WindowId;
  readonly name: string;
  readonly icon: SystemIconId;
}[] = [
  { id: 'inventory', name: 'Bag', icon: 'inventory' },
  { id: 'character', name: 'Gear', icon: 'character' },
  { id: 'options', name: 'Options', icon: 'options' },
];

interface Bar {
  readonly root: HTMLElement;
  /** Another player's name, over their body (spec 145). Empty for everything else. */
  readonly name: HTMLElement;
  readonly health: HTMLElement;
  /** The white band behind the fill: the ground a blow just took (spec 145). */
  readonly ghost: HTMLElement;
  /**
   * Guard, under the health bar (spec 147).
   *
   * Poise is the one resource in the game a player spends *somebody else's* of,
   * and until now it was replicated to every client and drawn nowhere -- so the
   * mechanic Strength exists to use was invisible on the body it was being used
   * against. `entity.poise` is a fraction, which is all a bar needs.
   */
  readonly guard: HTMLElement;
  readonly guardFill: HTMLElement;
  readonly cast: HTMLElement;
  readonly castFill: HTMLElement;
  /**
   * Changing a skill (spec 188).
   *
   * The third timed commitment a body can be in and the only one with nothing
   * else on screen saying so: a cast has its bar, a stagger has the swirl, and
   * a swap used to be a second and a half in which the player simply stood
   * there. Driven off `activity` and `activityUntilTick`, both already
   * replicated, so every observer sees it and nothing new rides the wire.
   */
  readonly swap: HTMLElement;
  readonly swapFill: HTMLElement;
  /**
   * The swirl over a stunned body (spec 173).
   *
   * Above the name, so it is the topmost thing in the stack and cannot be
   * confused with anything the body *has* -- health, guard and the cast bar are
   * all quantities, and this is a state. It sits in the same bottom-anchored
   * holder as the rest, so it rides the body without a second projection.
   */
  readonly stun: HTMLElement;
  /**
   * The row of status marks (spec 186).
   *
   * Above the swirl, so the stack reads downward as state, then what is
   * happening, then who this is, then how it is doing. Safe to hide with
   * `display` -- unlike the guard bar, which has to keep its box -- because the
   * holder is anchored by its *bottom*, so a row appearing at the top grows the
   * holder upward and moves nothing a player is reading. The swirl above it has
   * always relied on the same thing.
   */
  readonly statusRow: HTMLElement;
  readonly statusSlots: readonly StatusSlot[];
}

/** One reusable mark in the row: its box, its glyph and its stack count. */
interface StatusSlot {
  readonly root: HTMLElement;
  readonly glyph: HTMLElement;
  readonly count: HTMLElement;
  /** What is currently drawn, so an unchanged mark rewrites no markup. */
  drawn: string;
}

/**
 * The three flat colours of a floating bar (spec 145): what a body still has,
 * what it lost a moment ago, and empty.
 *
 * Empty is black rather than the old translucent wash, because the white chunk
 * is only legible against something that is not the world showing through it --
 * and "black is gone" is one less thing to learn than "darker is gone".
 */
const BAR_EMPTY = '#08090b';
const BAR_ENEMY = '#e0362a';
const BAR_SELF = '#7fd08a';
const BAR_LOST = '#f4f2ee';
/**
 * Guard (spec 147). Deliberately not a red and not the cast amber: health is
 * what a blow takes off you, guard is what it takes off your *footing*, and a
 * player has to be able to tell at a glance which bar just moved.
 */
const BAR_GUARD = '#8fa6c8';
/**
 * The two status colours (spec 186), and there are deliberately only two.
 *
 * A boon takes the guard blue the bar under it already uses for "this body is
 * holding"; an affliction takes the debuff rust from the VFX palette, which is
 * the colour a body already gets ringed in when something is wrong with it. One
 * colour per status would be a legend a player has to learn before a fight
 * tells them anything, and the question they actually ask -- is that good for
 * them or bad for them -- has two answers.
 */
const STATUS_BOON = BAR_GUARD;
const STATUS_AFFLICTION = '#d0796f';
/** Small enough that eight fit over a body, big enough to tell apart. */
const STATUS_ICON_PX = 13;

/**
 * What hovering an ability says (spec 191).
 *
 * The name, then its Technical Description, then the flavour -- separated by a
 * blank line, because the standard's §2.6 is that flavour is never mixed into
 * the mechanical block.
 *
 * One function for the action bar, the vial and the weapon switch, which used
 * to hold three different formulations of it and all three showed only
 * `ability.description`. That string is flavour and only flavour now, so before
 * this the bar's hover said "Both hands, and everything you weigh, put behind
 * one swing" and nothing about 42 damage, 1.1s or a 3s cooldown.
 */
function abilityTitle(ability: AbilityDefinition): string {
  const described = describeAbility(ability);
  const body = technicalText(described);
  const flavour = described.flavor === null ? '' : `\n\n${described.flavor}`;
  return `${ability.name}\n${body}${flavour}`;
}
/**
 * The resource pool (spec 164). Blue, and the one bar on screen that is *spent*
 * rather than lost -- health and guard are both taken off you by somebody else.
 */
const POOL_RESOURCE = '#4f9fe0';

/**
 * Experience (specs 164, 184). One palette, because experience now has two
 * places it is shown -- the number that floats off a kill and the strip along
 * the bottom edge -- and they are the same fact: what that body was worth, and
 * how far it moved you. A player who learns the colour from one reads the other
 * for free, which is only true if there is one colour to learn.
 *
 * Purple rather than the gold this strip opened with, and the swap is what
 * makes the pair possible: gold is already a cast that can still be called off,
 * and a floating gold number is a critical hit. Both of those are over a body,
 * which is exactly where the reward now floats too -- the strip could get away
 * with sharing a hue from the frame's own edge and a number cannot.
 *
 * Light on dark in both places. `XP_PURPLE_LIT` is the strip's inset highlight
 * along the top, which is what stops six pixels of flat fill reading as a
 * coloured border; `XP_PURPLE_DARK` is the number's outline and the empty half
 * of the strip, so what the fill is drawn against and what the digits are cut
 * out of are the same colour.
 */
const XP_PURPLE = '#a878e8';
const XP_PURPLE_LIT = '#d3b6ff';
const XP_PURPLE_DARK = '#200d36';

/**
 * The death banner (spec 164). Brighter than `BAR_ENEMY` and than the blood: it
 * is drawn over a world with dark reds already in it, and outlined in black, so
 * anything less saturated reads as part of the scene.
 */
const DEATH_RED = '#ff2b2b';

export interface HudHandle {
  readonly element: HTMLElement;
  /** Called once per frame, after the scene has drawn and anchors are current. */
  update(
    view: ClientView,
    anchors: readonly ScreenAnchor[],
    tick: number,
    corrections: number,
    /** The body being attacked, or null (spec 070). Shown as a one-line readout. */
    targetId: number | null,
    /**
     * The skill being aimed and whether it is still a question (spec 080).
     * Lights the slot it came from and says what the next click will do.
     */
    aiming: { readonly abilityId: string | null; readonly pending: boolean },
    /**
     * The entity under the cursor, or null (spec 158).
     *
     * Only a drop does anything with it today: the name of a *revealed* drop is
     * shown while it is hovered. It comes in as a parameter rather than off the
     * view because hovering is a render-local pick and has no business being
     * replicated.
     */
    hoveredId: number | null,
    /**
     * The frame's timestamp, straight from `requestAnimationFrame` (spec 143).
     *
     * The refusal stack decays in seconds rather than in frames, and it is the
     * frame loop that already holds a clock -- passing it in keeps the HUD to
     * one, shared with everything else the frame does.
     */
    nowMs: number,
  ): void;
  /**
   * A hit landed on `entityId`, at the world point `at` (spec 096).
   * Presentation of something already resolved.
   *
   * The point is taken once and kept: the number marks the ground the blow
   * landed on, so it neither walks off with a victim that survived nor follows
   * the camera once one that did not has despawned. `entityId` is only there to
   * fan a burst out into lanes.
   */
  addDamage(entityId: number, at: WorldAnchor, damage: number, crit: boolean): void;
  /**
   * `amount` experience was earned, at the world point `at` (spec 184).
   *
   * The same field and the same rules as {@link addDamage} -- a world point
   * taken once and re-projected, so the reward for a kill stays on the ground
   * the body fell on. What differs is the path and the colour, and both are
   * about the one number this shares a frame with: the killing blow's, spawned
   * on the same tick from the same anchor.
   *
   * `group` is the body that died, for the same reason a blow's is the body it
   * landed on -- it is never resolved to anything, and here it is what lets the
   * field sweep the reward away from the lane that blow's number took.
   */
  addExperience(group: number, at: WorldAnchor, amount: number): void;
  /**
   * Something was refused, and this is what to say about it (spec 143).
   *
   * Takes a finished line rather than an ability and a reason: the wording lives
   * in `error-log.ts` where it can be tested against every code the server can
   * send, and this end places elements.
   */
  error(text: string): void;
  /**
   * Draw the spawner overlay, or clear it (spec 076).
   *
   * Handed already-projected pixels and already-worded strings: what a spawner
   * is called and where it is on screen are both decided elsewhere, so this is
   * placement and nothing else.
   */
  showSpawners(
    marks: readonly {
      readonly id: string;
      readonly text: string;
      readonly waiting: boolean;
      readonly x: number;
      readonly y: number;
      readonly onScreen: boolean;
    }[],
  ): void;
  /**
   * Which windows are open, so the button that opens one can be lit (spec 140).
   *
   * Pushed in rather than read, for the same reason the weapon switch reads
   * `equipment.mainHand` back rather than remembering what was clicked: the
   * window is the state, and a button that lit itself would be a second opinion
   * about whether it is open.
   */
  showOpenWindows(open: readonly WindowId[]): void;
  /**
   * How big the action bar is, in CSS pixels (spec 190).
   *
   * The bar moved to the interface canvas, so its box is a fact about the UI
   * scale rather than about this file's table -- and everything left along that
   * edge is placed *relative to it*: the pool block sits immediately left of it
   * and centred on it, and the aim hint sits above it. Told rather than derived,
   * because a second description of somebody else's layout is the mistake that
   * put the chat log on the weapon switch.
   *
   * A box that has not changed costs a comparison.
   */
  setActionBar(box: ActionBarBox): void;
  /**
   * How much of the frame's floor is spoken for, in CSS pixels (spec 190).
   *
   * The experience strip spans the whole width and is pinned to the bottom, so
   * everything else along that edge has to clear it -- including the action bar,
   * which is drawn on the other surface and therefore has to be *told*. Constant
   * for the life of the HUD: it is a fact about which layout is in force, and
   * that is decided once (spec 094).
   */
  readonly floorCss: number;
  /**
   * How big one action-bar slot should be drawn, in CSS pixels (spec 190).
   *
   * Beside {@link floorCss} and told for the same reason: the bar is on the
   * other surface, and how big a thing a finger has to hit is a physical fact
   * this file's table has always been the one to state.
   */
  readonly slotSideCss: number;
  /**
   * Whether a slot names the key that fires it (specs 094, 190).
   *
   * False on a finger, which has no keyboard: see `HudLayout.showsKeyNumber`.
   * Told rather than asked, because the half of the mount that builds the bar's
   * rows is pure and `isHandheldDevice` reads the platform.
   */
  readonly showsSlotKeys: boolean;
  /**
   * What the bar has to leave clear on its left, in CSS pixels (spec 190).
   *
   * The pool block and its gap: they are part of the same group, so the bar is
   * centred with room for them rather than centred on its own. One number, both
   * surfaces, each offset by its own half of it.
   */
  readonly leftReserveCss: number;
  /**
   * What to call when a window button is pressed (spec 140). It hands back a
   * window id and nothing else -- the mount calls the same `ui.toggle` a key
   * binding calls, so nothing in this file decides what a button means.
   */
  onOpen(handler: (id: WindowId) => void): void;
  /**
   * What to call when a weapon is picked out of the switch (spec 079). It hands
   * back an item id and nothing else: the server equips it, recomputes the stat
   * block and sends it back, and the lit button follows *that* rather than the
   * click.
   */
  onEquip(handler: (itemId: string) => void): void;
  /**
   * What to call when the respawn button is pressed (spec 164).
   *
   * It hands back nothing, for the same reason the request carries nothing: the
   * server decides where a respawn puts you and what it restores. This end asks.
   */
  onRespawn(handler: () => void): void;
  /**
   * Show or hide the diagnostic readout (spec 183). Returns whether it is now
   * shown, which on a compact layout is always false -- see `readoutShown`.
   *
   * Hidden, never silenced: the text is written every frame either way.
   */
  toggleReadout(): boolean;
}

/**
 * @param project How to turn a world point into a canvas pixel --
 * `WorldScene.projectPoint`. Taken once at construction rather than per frame,
 * because it is the same function every frame; it reads the camera as it stands
 * when it is called, which is why `update` must run after the scene has drawn.
 */
export function createHud(project: Projector): HudHandle {
  // The one device question, asked once (spec 094). Everything below reads sizes
  // out of the table rather than deciding them, so what "compact" means is
  // asserted in Node instead of measured on a phone.
  const layout = hudLayout(isHandheldDevice());

  const root = document.createElement('div');
  root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';

  const status = document.createElement('div');
  status.style.cssText =
    'position:absolute;left:12px;top:52px;font:12px ui-monospace,Menlo,monospace;color:#cfd6e0;' +
    'background:rgba(10,14,20,.72);padding:8px 10px;border-radius:6px;line-height:1.6;white-space:pre;';
  /**
   * Whether the player has asked for the readout (spec 183). Shown to begin
   * with, because that is what every session before the toggle existed did, and
   * nothing about it is persisted -- the *binding* outlives a session, where the
   * switch does not.
   */
  let readoutWanted = true;

  /**
   * Hidden, not removed, and still written every frame. It is developer
   * instrumentation and has no business on a 390px frame -- but it is also the
   * only clock `scripts/preview-touch.ts` has: it reads the tick and the target
   * line out of `document.body.textContent`, which includes a `display:none`
   * subtree. Deleting it would leave the touch harness unable to tell "the tap
   * did nothing" from "the frame had not run yet", which is the confusion
   * spec 093 was debugged out of.
   *
   * So the toggle moves these two properties and nothing else: the readout is
   * hidden, never silenced.
   */
  const applyReadout = (): boolean => {
    const shown = readoutShown(layout, readoutWanted);
    status.style.display = shown ? 'block' : 'none';
    if (shown) status.removeAttribute('aria-hidden');
    else status.setAttribute('aria-hidden', 'true');
    // Published on the readout itself, because "the key did nothing" and "the
    // key hid a box that was already hidden" are the same screenshot -- and
    // because a probe wanting the box's text wants the same element.
    status.dataset['statsReadout'] = shown ? 'on' : 'off';
    return shown;
  };
  applyReadout();
  root.append(status);

  // The refusal stack (spec 143). Its *bottom* is pinned and it has no height of
  // its own, which is the whole trick: appending a line makes the box taller and
  // it grows upward, so the newest message is always the bottom one and every
  // older one is pushed toward the top of the screen. Sat above the window
  // buttons, the one thing already in this corner.
  const errors = document.createElement('div');
  errors.style.cssText =
    `position:absolute;right:calc(${layout.edge}px + env(safe-area-inset-right));` +
    `bottom:calc(${errorStackBottom(layout, SYSTEM_BUTTONS.length)}px + env(safe-area-inset-bottom));` +
    `display:flex;flex-direction:column;align-items:flex-end;gap:${layout.errorGap}px;` +
    'pointer-events:none;';
  // Invisible handles, like `data-entity` on a health bar: the column and each
  // line's text, so `scripts/preview-refusals.ts` can read what is actually on
  // screen instead of re-deriving it. Nothing in the game reads them.
  errors.dataset['errorStack'] = 'true';
  root.append(errors);

  /**
   * The name of the drop under the cursor (spec 158).
   *
   * **One element, not one per drop**, because there is only ever one hovered
   * thing -- and because a name over every drop in a field is a loot feed with
   * extra steps, which `docs/reward-philosophy.md` §10 rules out. It is the
   * whole of the reveal's payoff on screen: before the reveal there is no name
   * to show, and asking for one gets nothing rather than a placeholder.
   *
   * DOM for the reason the health bars are: text through the low-res buffer and
   * the dither pass comes out as chewed pixels.
   */
  const dropLabel = document.createElement('div');
  dropLabel.style.cssText =
    'position:absolute;transform:translate(-50%,-100%);white-space:nowrap;display:none;' +
    'font:12px ui-monospace,Menlo,monospace;padding:2px 6px;border-radius:4px;' +
    'background:rgba(10,14,20,.78);pointer-events:none;';
  // Read by `scripts/probe-loot.ts`, like every other invisible handle here.
  dropLabel.dataset['dropLabel'] = 'true';
  root.append(dropLabel);

  // The spawner overlay lives in its own layer so clearing it is one truncation
  // rather than a walk looking for which children were spawners.
  const spawnerLayer = document.createElement('div');
  spawnerLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  root.append(spawnerLayer);
  const spawnerMarks = new Map<string, HTMLElement>();

  // Bottom edge insets are `env()` rather than a number: in landscape the home
  // indicator runs along the bottom and the notch along a side, which is exactly
  // where the hotbar and the weapon switch sit (spec 093).
  //
  // `bottomEdge` rather than `edge` since spec 164: the experience strip is
  // pinned to the frame's bottom and spans its whole width, so every other
  // group has to clear it rather than sit beside it.
  const bottom = `calc(${bottomEdge(layout)}px + env(safe-area-inset-bottom))`;

  /**
   * Where the action bar is, in CSS pixels, told by the mount (spec 190).
   *
   * The bar itself is drawn on the interface canvas now. What is left here is
   * everything placed *against* it -- the pool block, which sits immediately to
   * its left and centred on it, and the aim hint above it -- so this file needs
   * its box and nothing else about it.
   */
  let actionBar: ActionBarBox = NO_ACTION_BAR;

  /**
   * What the next tap does, while a skill is aimed (spec 080).
   *
   * Only built on the compact HUD, and only ever shows the aim: that line used
   * to ride along at the bottom of the readout, and the readout is the one thing
   * spec 094 takes away. It is not debug output -- it is the question on screen
   * -- so it gets its own place above the hotbar rather than going with the
   * panel. Idle, it says nothing; the world is the hint.
   */
  const aimHint = document.createElement('div');
  if (layout.compact) {
    aimHint.style.cssText =
      `position:absolute;left:50%;transform:translateX(-50%);white-space:nowrap;` +
      'font:11px ui-monospace,Menlo,monospace;color:#dbe3ee;background:rgba(10,14,20,.72);' +
      'padding:3px 8px;border-radius:5px;pointer-events:none;';
    root.append(aimHint);
  }

  /**
   * The two pools, immediately left of the slots (spec 164).
   *
   * Placed off the *bar's* half-width rather than from the frame's left edge,
   * because the bar is centred: pinning the pool to the left would leave a gap
   * between them that grew with the window, and the two are one group.
   *
   * Sat at `poolBottom` rather than at the same floor as the slots, so the two
   * are centred on one another. The first cut shared the floor, which put a
   * 40px block against the bottom of a 46px row: all the daylight above it and
   * none below, which reads as a mistake because everything else along that edge
   * lines up.
   */
  const poolBlock = document.createElement('div');
  // Bottom furniture too. See the weapon switch below.
  poolBlock.dataset['hudBottom'] = 'pools';
  poolBlock.style.cssText =
    `position:absolute;left:50%;` +
    `display:flex;flex-direction:column;` +
    `gap:${layout.poolGap}px;width:${layout.pool.width}px;pointer-events:none;`;
  root.append(poolBlock);

  /**
   * The player's own statuses, above their own health bar (spec 191).
   *
   * A second row, and the reason it is not simply the floating one is that the
   * two answer different questions. A mark over a body is 13px and moving with
   * it: it says *that* something is on that body, at a glance, and it is not a
   * thing anybody can point at -- a 13px hit target over every body in interest
   * range that swallowed a click would break the movement order this whole game
   * is driven by. A row anchored to the frame can be pointed at, so this is
   * where the countdown and the Technical Description live.
   *
   * First child of `poolBlock`, which is anchored by its **bottom**: the block
   * grows upward when a status appears and the two bars underneath do not move.
   * The same property the floating holder's `translate(-50%,-100%)` gives it,
   * and the reason the cast bar had to be taken out of flow in the first place.
   */
  const selfStatusRow = document.createElement('div');
  selfStatusRow.dataset['bar'] = 'selfStatuses';
  selfStatusRow.style.cssText = [
    'display:none',
    'align-items:flex-end',
    `gap:${String(layout.poolGap)}px`,
    `margin-bottom:${String(layout.poolGap)}px`,
    // The row itself takes no pointer: only the marks in it do, so the gaps
    // between them stay world.
    'pointer-events:none',
  ].join(';');
  poolBlock.append(selfStatusRow);

  interface SelfStatusSlot {
    readonly root: HTMLElement;
    readonly glyph: HTMLElement;
    readonly count: HTMLElement;
    readonly timer: HTMLElement;
    /** What is currently drawn, so an unchanged mark costs no innerHTML parse. */
    drawn: string;
  }

  /**
   * Bigger than the 13px floating mark, because this one is read rather than
   * noticed -- and it is the thing being hovered, so it has to be a target a
   * pointer can find without care.
   */
  const SELF_STATUS_PX = 20;

  const selfStatusSlots: SelfStatusSlot[] = [];
  for (let index = 0; index < MAX_VISIBLE_STATUSES; index += 1) {
    const slot = document.createElement('div');
    slot.style.cssText = [
      'display:none',
      'flex:0 0 auto',
      'flex-direction:column',
      'align-items:center',
      'gap:1px',
      // The one place in this band that takes a pointer, so the tooltip has
      // something to hang off.
      'pointer-events:auto',
      'cursor:help',
    ].join(';');
    const glyph = document.createElement('div');
    glyph.style.cssText =
      `position:relative;width:${String(SELF_STATUS_PX)}px;height:${String(SELF_STATUS_PX)}px;` +
      'filter:drop-shadow(0 1px 2px rgba(0,0,0,.9));';
    const count = document.createElement('div');
    count.style.cssText = [
      'position:absolute',
      'right:0',
      'bottom:0',
      'font:8px/1 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#f2f6fb',
      'text-shadow:0 0 2px rgba(0,0,0,1),0 1px 2px rgba(0,0,0,.95)',
    ].join(';');
    // Under the glyph rather than over it: a countdown moves every frame, and a
    // moving number on top of a picture makes the picture unreadable.
    const timer = document.createElement('div');
    timer.style.cssText = [
      'font:9px/1 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#d7deea',
      'text-shadow:0 1px 2px rgba(0,0,0,.95)',
      // Held even when empty, so an indefinite status does not make the marks
      // beside it jump up by a line.
      'min-height:9px',
    ].join(';');
    glyph.append(count);
    slot.append(glyph, timer);
    selfStatusRow.append(slot);
    selfStatusSlots.push({ root: slot, glyph, count, timer, drawn: '' });
  }

  /**
* Place everything that hangs off the action bar, in one go (spec 190).
   *
   * Called when the box changes rather than per frame: the bar's size follows
   * the interface scale, which moves when the window is resized or the player
   * chooses a different one, and not otherwise. A box of zero is what the frames
   * before the interface has laid itself out look like, and it puts the pool
   * block in the middle for one of them -- which is honest, and is why the
   * number is told rather than guessed at with a constant that would be wrong
   * forever.
   */
  const placeAgainstBar = (): void => {
    poolBlock.style.bottom = `calc(${poolBottom(layout, actionBar)}px + env(safe-area-inset-bottom))`;
    // Half the *group's* width, which is what centring the group amounts to:
    // the pools are the first thing in it and the bar reserves the same number
    // on its own side (spec 190). Pinning the pools a whole bar-half plus their
    // own width to the left of centre -- which is what this was -- centres the
    // bar and leaves the pair sitting off to one side of the screen.
    poolBlock.style.marginLeft = `${-bottomGroupWidth(layout, actionBar) / 2}px`;
    if (layout.compact) {
      aimHint.style.bottom =
        `calc(${bottomEdge(layout) + actionBar.height + 6}px + env(safe-area-inset-bottom))`;
    }
  };
  placeAgainstBar();

  interface Pool {
    readonly fill: HTMLElement;
    /**
     * The white band behind the fill, or null on a bar that has none.
     *
     * Only health has one: the chunk is what a *blow* took, and nothing takes
     * resource off you -- you spend it, and a white chunk marking your own cast
     * would be the bar objecting to being used.
     */
    readonly ghost: HTMLElement | null;
    readonly label: HTMLElement;
  }

  function makePool(fillColor: string, name: string, ghosted: boolean): Pool {
    const track = document.createElement('div');
    track.dataset['pool'] = name;
    track.style.cssText =
      `position:relative;height:${layout.pool.height}px;background:${BAR_EMPTY};border-radius:3px;` +
      'overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.7);';
    // Two bands in one track, the white underneath -- laid out exactly as the
    // floating bar's are (spec 145), so the fill's width is still just health
    // and the chunk is whatever the white is left showing past it. Stacked
    // rather than end to end, so the two can never disagree about where the
    // fill ends.
    const ghost = ghosted ? document.createElement('div') : null;
    if (ghost) {
      ghost.style.cssText =
        `position:absolute;left:0;top:0;height:100%;width:0;background:${BAR_LOST};`;
      track.append(ghost);
    }
    const fill = document.createElement('div');
    fill.style.cssText = `position:absolute;left:0;top:0;height:100%;width:0;background:${fillColor};`;
    // Over the bar rather than beside it: the numbers are what you read when you
    // want to know, and the length is what you read when you are fighting. Two
    // rows for that would double the height of a block that has to stay under
    // one slot. In the game's own face, like everything else in this band.
    const label = document.createElement('div');
    label.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
      'pointer-events:none;';
    track.append(fill, label);
    poolBlock.append(track);
    return { fill, ghost, label };
  }

  // Green for health, matching the player's own floating bar (spec 145), because
  // "green is you" is already true in this game and a second colour for the same
  // quantity would be a second thing to learn. Blue for the pool, which is the
  // one thing on screen that is spent rather than lost.
  const healthPool = makePool(BAR_SELF, 'health', true);
  const resourcePool = makePool(POOL_RESOURCE, 'resource', false);

  /**
   * The white chunk and the flinch, for the pool bar (specs 145/146, 163).
   *
   * The *same* class the floating bars are read through, on an instance of its
   * own: one bar is placed by an anchor over a body and the other is pinned to
   * the frame, and the floating one is only read on frames the body is on
   * screen. Sharing one instance would make the chunk on the pool bar depend on
   * whether the camera happened to be looking at the player -- which is exactly
   * the frames a hit is most worth marking.
   */
  const poolFlashes = new HealthFlashes();

  /**
   * A pool bar's numbers, in the game's own face.
   *
   * Rewritten only when the string changes. Health moves on almost every frame
   * of a fight and resource regenerates continuously, so this is the one label
   * in the band that would genuinely be rebuilt sixty times a second -- and the
   * *rounded* string changes far less often than the number behind it does.
   */
  function writePoolLabel(element: HTMLElement, text: string): void {
    if (element.dataset['text'] === text) return;
    element.dataset['text'] = text;
    element.innerHTML = pixelTextSvg(text, {
      scale: layout.poolScale,
      fill: '#f2f6fb',
      outline: '#0a0d14',
    });
  }

  /**
   * The experience strip (spec 164), pinned to the very bottom, full width.
   *
   * Not inset by `layout.edge`: it is the frame's own bottom edge, the way a
   * progress bar at the foot of a window is, and an inset one would read as a
   * floating widget rather than as the boundary of the screen.
   *
   * Ten subdivisions as a repeating gradient over one element, rather than ten
   * elements. A subdivision has no state -- it is a mark on the bar, and ten
   * boxes would be ten things that could get out of step with the fill under
   * them.
   */
  const xpStrip = document.createElement('div');
  xpStrip.dataset['xpBar'] = 'true';
  xpStrip.style.cssText =
    `position:absolute;left:0;right:0;bottom:0;height:${layout.xpBarHeight}px;` +
    `background:${XP_PURPLE_DARK};border-top:1px solid #000;box-sizing:content-box;` +
    // Auto, so it can be hovered: it is the only thing in the HUD whose detail
    // is *only* available on hover, and a strip that ignored the pointer would
    // have no way to be asked.
    'pointer-events:auto;overflow:hidden;';
  const xpFill = document.createElement('div');
  xpFill.style.cssText =
    `position:absolute;left:0;top:0;bottom:0;width:0;background:${XP_PURPLE};` +
    `box-shadow:inset 0 1px 0 ${XP_PURPLE_LIT};`;
  const xpTicks = document.createElement('div');
  xpTicks.style.cssText =
    'position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(' +
    `to right,transparent 0,transparent calc(${100 / XP_SUBDIVISIONS}% - 1px),` +
    `#000 calc(${100 / XP_SUBDIVISIONS}% - 1px),#000 ${100 / XP_SUBDIVISIONS}%);`;
  xpStrip.append(xpFill, xpTicks);
  root.append(xpStrip);

  /**
   * The exact percentage, on hover.
   *
   * Ten marks is what a player can read off the strip at a glance; a number to
   * one decimal is what they came to it for. Built once and shown by the two
   * pointer handlers, which are the only listeners in this file that are not on
   * a button -- there is nothing to press here, only something to ask.
   */
  const xpDetail = document.createElement('div');
  xpDetail.style.cssText =
    `position:absolute;left:8px;bottom:${layout.xpBarHeight + 4}px;display:none;` +
    'background:rgba(10,14,20,.85);padding:4px 8px;border-radius:4px;border:1px solid #000;' +
    'pointer-events:none;white-space:nowrap;';
  xpDetail.dataset['xpDetail'] = 'true';
  root.append(xpDetail);
  xpStrip.addEventListener('pointerenter', () => {
    xpDetail.style.display = 'block';
  });
  xpStrip.addEventListener('pointerleave', () => {
    xpDetail.style.display = 'none';
  });

  let respawnHandler: () => void = () => undefined;

  /**
   * "YOU ARE DEAD", and the way back (spec 164).
   *
   * Over everything, and the only part of the HUD that takes the pointer across
   * the whole frame -- deliberately: while it is up, clicking the world would be
   * ordering a corpse to walk, and every one of those orders is a refusal.
   *
   * The words are `pixelTextSvg` rather than DOM text with a text-shadow. The
   * damage numbers and the refusal stack are already drawn that way (specs
   * 065/143), so this is the vocabulary the game has for shouting rather than a
   * second one invented for one screen -- and the outline it draws is a real
   * outline on every side rather than four stacked shadows.
   */
  const deathLayer = document.createElement('div');
  deathLayer.style.cssText =
    'position:absolute;inset:0;display:none;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:18px;background:rgba(20,2,4,.42);pointer-events:auto;' +
    // The one z-index in this file. Everything else here is `position:absolute`
    // with no stacking of its own, so DOM order decides -- and this layer is
    // built before the weapon switch and the window buttons, which would
    // otherwise sit on top of the thing that is supposed to be covering them.
    'z-index:5;';
  deathLayer.dataset['death'] = 'true';
  const deathBanner = document.createElement('div');
  const respawnButton = document.createElement('button');
  respawnButton.style.cssText =
    'padding:10px 26px;border-radius:6px;border:1px solid #000;background:#7a1a1a;' +
    'cursor:pointer;box-shadow:0 2px 0 #000;display:flex;align-items:center;';
  respawnButton.innerHTML = pixelTextSvg('RESPAWN', {
    scale: layout.respawnScale,
    fill: '#ffe2e2',
    outline: '#000000',
  });
  // The word is a glyph path, so the button has no text of its own to be found
  // or read out by.
  respawnButton.setAttribute('aria-label', 'Respawn');
  respawnButton.dataset['respawn'] = 'true';
  respawnButton.addEventListener('click', () => respawnHandler());
  deathLayer.append(deathBanner, respawnButton);
  root.append(deathLayer);

  // The weapon switch (spec 079), bottom left and out of the hotbar's way.
  // Which one is lit is read back off `stats.basicAttackId` -- the server's
  // answer -- so a refused equip simply leaves the old one lit.
  //
  // Not built at all on a phone (spec 141): three permanent buttons is a lot of
  // corner for a choice made rarely, and the bag and the sheet both make it and
  // are both one tap away. Built or not, the element is created and simply never
  // appended when the layout says no -- the update loop below styles these
  // buttons every frame and a conditional `weaponSlots` would put a branch in it.
  const weapons = document.createElement('div');
  // Furniture along the bottom that the canvas interface must not cover
  // (spec 189). The chat is docked bottom-left, which is exactly here, and it
  // is drawn on a canvas stacked over this element -- so how far up the frame
  // this reaches has to be *measured* rather than derived: the switch is a
  // column whose height depends on how many weapons there are and on whether
  // the layout is the compact one.
  weapons.dataset['hudBottom'] = 'weapons';
  weapons.style.cssText =
    `position:absolute;left:calc(${layout.edge}px + env(safe-area-inset-left));bottom:${bottom};` +
    `display:flex;flex-direction:${layout.weaponDirection};gap:${layout.weaponGap}px;` +
    'font:11px ui-monospace,Menlo,monospace;pointer-events:auto;' +
    // Backed like the status readout: the caption is small grey text and the
    // world behind it is a bright green field, so unbacked it disappears over
    // half the map. Icons carry their own backing, so the compact row drops the
    // panel and the padding with the caption.
    (layout.weaponIconOnly ? '' : 'background:rgba(10,14,20,.72);padding:8px;border-radius:6px;');
  if (layout.showsWeaponSwitch) root.append(weapons);

  if (!layout.weaponIconOnly) {
    const weaponCaption = document.createElement('div');
    weaponCaption.style.cssText = 'padding-left:2px;';
    weaponCaption.innerHTML = pixelTextSvg('WEAPON', {
      scale: layout.captionScale,
      fill: '#8b97a8',
      outline: '#0a0d14',
    });
    weapons.append(weaponCaption);
  }

  let equipHandler: (itemId: string) => void = () => undefined;

  const weaponSlots = WEAPON_SWITCH.map((weapon) => {
    const ability = abilityById(weapon.abilityId);
    const button = document.createElement('button');
    button.style.cssText =
      // Fixed height on a finger, because the target is the point; a floor on
      // desktop, because a long name that wraps should push the button open
      // rather than spill out of it.
      `width:${layout.weapon.width}px;border-radius:6px;` +
      `${layout.weaponIconOnly ? 'height' : 'min-height'}:${layout.weapon.height}px;` +
      'border:1px solid #33405a;background:#182130;color:#cfd6e0;cursor:pointer;font:inherit;' +
      `display:flex;align-items:center;gap:6px;line-height:1.4;` +
      (layout.weaponIconOnly ? 'justify-content:center;padding:0;' : 'padding:5px 8px;');
    // The icon is the whole button on a phone, so the name has to survive as a
    // label rather than as text: it is what a screen reader reads out, and what
    // the harness reports when it says which weapon is lit.
    button.innerHTML = weaponIconSvg(weapon.abilityId, { size: layout.weaponIconPx });
    button.setAttribute('aria-label', weapon.name);
    // Says which weapon this button is, for the same reason a health bar says
    // which body it belongs to: `scripts/preview-world.ts` has to find the lit
    // one, and it used to find it by `text-align:left` -- a style, which stopped
    // being true the moment the compact switch centred its icons. A named handle
    // is the honest version of that, and it survives the button having no text.
    button.dataset['weapon'] = weapon.itemId;
    if (!layout.weaponIconOnly) {
      // In the game's own face like the rest of the band (spec 164). The button
      // still carries the name as an `aria-label` above, which is what a screen
      // reader reads and what `preview-touch.ts` finds it by -- a drawn glyph
      // path is not text and cannot be either.
      const name = document.createElement('span');
      name.innerHTML = pixelTextSvg(weapon.name.toUpperCase(), {
        scale: layout.captionScale,
        fill: '#cfd6e0',
        outline: '#0a0d14',
      });
      button.append(name);
    }
    button.title = ability ? abilityTitle(ability) : weapon.itemId;
    button.addEventListener('click', () => equipHandler(weapon.itemId));
    weapons.append(button);
    return { ...weapon, button };
  });

  // The window buttons (spec 140), bottom right and mirroring the weapon switch.
  // They exist because `I` and `C` are undiscoverable -- on a desktop as much as
  // on a phone, which is why the row is drawn on both and only its size changes.
  const systemRow = document.createElement('div');
  systemRow.style.cssText =
    `position:absolute;right:calc(${layout.edge}px + env(safe-area-inset-right));bottom:${bottom};` +
    `display:flex;flex-direction:${layout.systemIconOnly ? 'row' : 'column'};` +
    `gap:${layout.systemGap}px;font:11px ui-monospace,Menlo,monospace;pointer-events:auto;`;
  root.append(systemRow);

  let openHandler: (id: WindowId) => void = () => undefined;

  const systemSlots = SYSTEM_BUTTONS.map((entry) => {
    const button = document.createElement('button');
    button.style.cssText =
      `width:${layout.systemButton.width}px;height:${layout.systemButton.height}px;border-radius:6px;` +
      'border:1px solid #33405a;background:#182130;color:#cfd6e0;cursor:pointer;font:inherit;' +
      'display:flex;align-items:center;gap:6px;line-height:1.4;' +
      (layout.systemIconOnly ? 'justify-content:center;padding:0;' : 'padding:5px 8px;');
    button.innerHTML = systemIconSvg(entry.icon, { size: layout.systemIconPx });
    // The name survives the button having no text: it is what a screen reader
    // reads out, and what `scripts/preview-touch.ts` finds the button by.
    button.setAttribute('aria-label', entry.name);
    button.title = entry.name;
    button.dataset['window'] = entry.id;
    if (!layout.systemIconOnly) {
      const name = document.createElement('span');
      name.innerHTML = pixelTextSvg(entry.name.toUpperCase(), {
        scale: layout.captionScale,
        fill: '#cfd6e0',
        outline: '#0a0d14',
      });
      button.append(name);
    }
    button.addEventListener('click', () => openHandler(entry.id));
    systemRow.append(button);
    return { ...entry, button };
  });

  const bars = new Map<number, Bar>();
  /** Same division as the numbers: the judgement is pure, this holds elements. */
  const flashes = new HealthFlashes();
  /** The numbers' whole life lives in the pure field; this holds their elements. */
  const popups = new DamagePopups();
  const popupElements = new Map<number, HTMLElement>();
  /** Same division as the numbers: the field decides, this holds the elements. */
  const errorLog = new ErrorLog();
  const errorElements = new Map<number, HTMLElement>();

  function barFor(id: number): Bar {
    const existing = bars.get(id);
    if (existing) return existing;

    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;transform:translate(-50%,-100%);width:52px;';
    // Says which body this bar belongs to. Nothing in the game reads it; it is
    // how `scripts/preview-world.ts` finds a real unit on screen to click,
    // instead of re-deriving the camera projection and testing its own copy.
    holder.dataset['entity'] = String(id);

    // Above the health track, so the holder's translate(-50%,-100%) puts the
    // name over the body rather than through it. Hidden unless there is a name
    // to draw, which is another player and nobody else.
    const name = document.createElement('div');
    name.style.cssText = [
      'display:none',
      'margin-bottom:2px',
      'text-align:center',
      'font:10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#e8e8ea',
      'text-shadow:0 1px 2px rgba(0,0,0,.9)',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
    ].join(';');

    const healthTrack = document.createElement('div');
    // Named, for the same reason the holder carries `data-entity`: a probe has
    // to find this track without counting children. Counting is what the bars
    // were read by, and spec 145's name element silently shifted every index by
    // one -- `probe-health-flash.ts` has been resolving `firstElementChild` to
    // the name ever since, finding no fill inside it, and sampling nothing.
    healthTrack.dataset['bar'] = 'health';
    healthTrack.style.cssText =
      `position:relative;height:5px;background:${BAR_EMPTY};border-radius:2px;overflow:hidden;` +
      'box-shadow:0 0 0 1px rgba(0,0,0,.55);';
    // Two bands in one track, the white underneath (spec 145). Stacked rather
    // than laid end to end, so the fill's width is still just health -- the
    // chunk is whatever the white is left showing past it, and the two can
    // never disagree about where the fill ends.
    const ghost = document.createElement('div');
    ghost.style.cssText = `position:absolute;left:0;top:0;height:100%;width:100%;background:${BAR_LOST};`;
    const health = document.createElement('div');
    health.style.cssText = `position:absolute;left:0;top:0;height:100%;width:100%;background:${BAR_ENEMY};`;
    healthTrack.append(ghost, health);

    // Guard, immediately under health and *in flow* -- so it is part of the
    // holder's height on every bar, every frame, whether or not it is showing.
    //
    // Hidden with `visibility` rather than `display`, and that is the whole
    // reason it can sit in flow at all: the holder is bottom-anchored, so
    // anything that leaves and rejoins the layout moves the health bar above it
    // (the cast bar is out of flow for exactly this reason). `visibility` keeps
    // the box and drops the ink, so a guard that fills up vanishes without
    // shifting the thing a player is actually reading.
    const guard = document.createElement('div');
    guard.dataset['bar'] = 'guard';
    guard.style.cssText =
      `position:relative;margin-top:1px;height:3px;background:${BAR_EMPTY};border-radius:2px;` +
      'overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.55);visibility:hidden;';
    const guardFill = document.createElement('div');
    guardFill.style.cssText = `height:100%;width:100%;background:${BAR_GUARD};`;
    guard.append(guardFill);

    // Hung off the health track rather than stacked under it in flow.
    //
    // The holder is anchored by its *bottom* -- `translate(-50%,-100%)` puts its
    // last row over the head -- so a cast bar that took part in layout made the
    // holder taller the instant a wind-up began, and the health bar above it
    // jumped up by its height and dropped back when the swing landed. Every
    // wind-up in the game twitched the thing a player is reading. Out of flow it
    // cannot change the holder's height, so the health bar holds still and the
    // cast bar hangs below it.
    const cast = document.createElement('div');
    cast.dataset['bar'] = 'cast';
    cast.style.cssText =
      'position:absolute;left:0;right:0;top:calc(100% + 2px);height:4px;' +
      'background:rgba(0,0,0,.65);border-radius:2px;overflow:hidden;display:none;';
    const castFill = document.createElement('div');
    castFill.style.cssText = 'height:100%;width:0;background:#ffcf6b;';
    cast.append(castFill);

    // The stun swirl (spec 173). Built once and hidden, like the name: a body
    // is stunned for well under a second at a time and creating an element per
    // break would churn the DOM on every blow that lands.
    const stun = document.createElement('div');
    stun.style.cssText = [
      'display:none',
      'margin:0 auto 2px',
      'width:18px',
      'height:18px',
      // Amber, the cast bar's colour, because both mean "this body is committed
      // to something it cannot get out of" -- and deliberately not the guard
      // blue, which marks the bar that ran out rather than what happened next.
      'color:#ffcf6b',
      'filter:drop-shadow(0 1px 2px rgba(0,0,0,.9))',
      // The glyph is turned by writing a transform each frame; naming the origin
      // here means that write is one property rather than two.
      'transform-origin:50% 50%',
    ].join(';');
    stun.innerHTML = stunIconSvg({ size: 18 });

    // The status row (spec 186). Built once at full width and hidden, like the
    // swirl and the name: a body picks statuses up and drops them several times
    // a fight, and creating elements per application would churn the DOM on
    // every blow that lands.
    //
    // A fixed pool of slots rather than one element per status, so the row never
    // allocates while a fight is running and a mark that goes away is a
    // `display` write rather than a removal.
    const statusRow = document.createElement('div');
    statusRow.dataset['bar'] = 'statuses';
    statusRow.style.cssText = [
      'display:none',
      'justify-content:center',
      'align-items:center',
      // Four rather than two. Each glyph's ink fills most of its own box -- the
      // paths run nearly the full 24-unit viewBox -- so at two the row read as
      // one continuous ribbon rather than as several marks, which is the one
      // thing a row of marks must not do.
      'gap:4px',
      'margin-bottom:2px',
      'pointer-events:none',
      // Allowed to be wider than the holder, and centred on it.
      //
      // The holder is a fixed 52px -- the width of the health bar -- and four
      // marks already need more than that. Left in flow the slots are flex items
      // in a box too small for them, so they *shrink*: eight of them came out
      // 3px wide each, which is a row of specks that passes every check about
      // what is drawn and shows a player nothing. `max-content` takes the row
      // out of that negotiation, and the half-shifts re-centre it over the body.
      'width:max-content',
      'position:relative',
      'left:50%',
      'transform:translateX(-50%)',
    ].join(';');

    const statusSlots: StatusSlot[] = [];
    for (let index = 0; index < MAX_VISIBLE_STATUSES; index += 1) {
      const slot = document.createElement('div');
      slot.style.cssText = [
        'display:none',
        'position:relative',
        `width:${STATUS_ICON_PX}px`,
        `height:${STATUS_ICON_PX}px`,
        // Belt and braces with the row's `max-content` above: a mark is a fixed
        // size and must never be negotiated down to fit.
        'flex:0 0 auto',
        'filter:drop-shadow(0 1px 2px rgba(0,0,0,.9))',
      ].join(';');
      const glyph = document.createElement('div');
      glyph.style.cssText = 'position:absolute;inset:0;';
      // Bottom-right, outside the glyph's own weight, so a two-stack Flow reads
      // as a marked glyph rather than as a different glyph.
      const count = document.createElement('div');
      count.style.cssText = [
        'position:absolute',
        // Inside the box, not hanging off it. Outside, the digit sat in the gap
        // and collided with the next mark's glyph, so a stacking status made the
        // one after it unreadable.
        'right:0',
        'bottom:0',
        'font:7px/1 ui-monospace,SFMono-Regular,Menlo,monospace',
        'color:#f2f6fb',
        'text-shadow:0 0 2px rgba(0,0,0,1),0 1px 2px rgba(0,0,0,.95)',
      ].join(';');
      slot.append(glyph, count);
      statusRow.append(slot);
      statusSlots.push({ root: slot, glyph, count, drawn: '' });
    }

    // Changing a skill (spec 188). The cast bar's shape in a different colour,
    // because it means the same kind of thing -- this body is committed to
    // something with a clock on it -- and a fourth vocabulary for the fourth
    // timed thing would be three too many. Below the cast bar rather than in
    // place of it: the two cannot both be running (committing to a cast gives
    // up the swap), but stacking them keeps either from moving when the other
    // appears.
    const swap = document.createElement('div');
    swap.dataset['bar'] = 'swap';
    swap.style.cssText =
      'position:absolute;left:0;right:0;top:calc(100% + 2px);height:4px;' +
      'background:rgba(0,0,0,.65);border-radius:2px;overflow:hidden;display:none;';
    const swapFill = document.createElement('div');
    // Teal: not the cast bar's amber, not the guard's blue, not the health
    // reds. A body changing a skill has to be distinguishable at a glance from
    // one winding up a blow, because the answer to the two is different.
    swapFill.style.cssText = 'height:100%;width:0;background:#6bd7cf;';
    swap.append(swapFill);

    holder.append(statusRow, stun, name, healthTrack, guard, cast, swap);
    root.append(holder);
    const made: Bar = {
      root: holder,
      name,
      health,
      ghost,
      guard,
      guardFill,
      cast,
      castFill,
      stun,
      statusRow,
      statusSlots,
      swap,
      swapFill,
    };
    bars.set(id, made);
    return made;
  }

  function dropPopup(id: number): void {
    popupElements.get(id)?.remove();
    popupElements.delete(id);
  }

  /**
   * Name the hovered drop, once it has one (spec 158).
   *
   * Three ways to show nothing and they are all the same branch: nothing is
   * hovered, the hovered thing is not a drop, or the drop has not revealed and
   * therefore has no name. That last one is the feature -- `label` is null
   * rather than "???", so there is nothing here that could put a placeholder on
   * screen.
   */
  function showDropLabel(
    view: ClientView,
    byId: ReadonlyMap<number, ClientView['entities'][number]>,
    hoveredId: number | null,
  ): void {
    const drop = hoveredId === null ? undefined : view.drops.find((d) => d.entityId === hoveredId);
    const entity = hoveredId === null ? undefined : byId.get(hoveredId);
    const name = drop?.name ?? null;
    if (!drop || !entity || name === null) {
      dropLabel.style.display = 'none';
      delete dropLabel.dataset['name'];
      return;
    }
    const at = project(entity.x, entity.y, DROP_LABEL_LIFT);
    if (!at.onScreen) {
      dropLabel.style.display = 'none';
      return;
    }
    // The count is on the label because a stack of three potions and one potion
    // are different objects, and the drop draws identically either way.
    const text = drop.count > 1 ? `${name} x${drop.count}` : name;
    dropLabel.style.display = 'block';
    dropLabel.style.left = `${at.x}px`;
    dropLabel.style.top = `${at.y}px`;
    dropLabel.style.color = DROP_LABEL_COLOR[drop.rarity] ?? DROP_LABEL_COLOR.common;
    dropLabel.textContent = text;
    dropLabel.dataset['name'] = text;
  }

  function dropError(id: number): void {
    errorElements.get(id)?.remove();
    errorElements.delete(id);
  }

  function update(
    view: ClientView,
    anchors: readonly ScreenAnchor[],
    tick: number,
    corrections: number,
    targetId: number | null,
    aiming: { readonly abilityId: string | null; readonly pending: boolean },
    hoveredId: number | null,
    nowMs: number,
  ): void {
    const byId = new Map(view.entities.map((entity) => [entity.id, entity]));
    showDropLabel(view, byId, hoveredId);
    const casts = new Map(view.casts.map((cast) => [cast.entityId, cast]));
    const live = new Set<number>();

    for (const anchor of anchors) {
      const entity = byId.get(anchor.id);
      if (!entity) continue;
      const look = appearanceOf(entity);
      const cast = casts.get(anchor.id);
      const wantsBar = (look.showsHealth && entity.health > 0) || cast !== undefined;
      if (!wantsBar || !anchor.onScreen) continue;

      live.add(anchor.id);
      const element = barFor(anchor.id);
      // Says whether this bar is the local player's. Nothing in the game reads
      // it either; it is how `scripts/preview-world.ts` avoids aiming a click at
      // a monster its own body is standing in front of, which since spec 095 is
      // a miss rather than a forgiven near-miss.
      if (anchor.id === view.selfEntityId) element.root.dataset['self'] = '';
      else delete element.root.dataset['self'];

      // Another player's name over their body (spec 145, the multiplayer one).
      // Not our own -- you know who you are, and a label on your own head is
      // one more thing between you and the fight.
      const label =
        entity.kind === EntityKind.Player && entity.id !== view.selfEntityId
          ? displayName(entity)
          : '';
      if (label === '') {
        element.name.style.display = 'none';
        element.name.textContent = '';
        delete element.name.dataset['name'];
      } else {
        element.name.style.display = 'block';
        element.name.textContent = label;
        // Read by `scripts/preview-multiplayer.ts`, for the same reason the
        // health bar carries `data-entity`: so a probe can assert on the name
        // without re-deriving the camera projection.
        element.name.dataset['name'] = label;
      }

      // The fill is replicated health and nothing here delays it; the white
      // band behind it is the chunk the last blow took, decided in the pure
      // field off the same presentation clock the bars are placed by.
      // The stun swirl (spec 173). Stateless, so unlike the flash above there is
      // nothing per-body to retain or prune: a body that is stunned right now is
      // stunned whether or not this client watched the blow, which is exactly
      // what a *state* mark should say and the opposite of the flinch's rule.
      const stun = stunMark(entity.activity, entity.activityUntilTick, tick);
      element.stun.style.display = stun.visible ? 'block' : 'none';
      if (stun.visible) {
        element.stun.style.transform = `rotate(${stun.spin.toFixed(1)}deg)`;
        element.stun.style.opacity = stun.opacity.toFixed(2);
      }

      // The status marks (spec 186), on the same terms as the swirl above: a
      // pure function of what was replicated and the tick being drawn, with
      // nothing kept between frames. A status whose window has passed is refused
      // by `statusMarks` rather than by anything here, so a delta that has not
      // arrived yet cannot leave a mark up.
      // `?? []` for the same reason the guard above reads `entity.poise ?? 1`:
      // several harnesses fabricate a view by hand (`hud-probe.ts`, the bot
      // client) and a field added to `ReplicatedEntity` is not a field they
      // know to set. The type says it is always there; the rigs say otherwise,
      // and a HUD that throws on a missing field takes the whole frame.
      const marks = statusMarks(entity.statuses ?? [], tick);
      element.statusRow.style.display = marks.length > 0 ? 'flex' : 'none';
      for (let index = 0; index < element.statusSlots.length; index += 1) {
        const slot = element.statusSlots[index];
        if (!slot) continue;
        const mark = marks[index];
        if (!mark) {
          slot.root.style.display = 'none';
          continue;
        }
        slot.root.style.display = 'block';
        slot.root.style.opacity = mark.opacity.toFixed(2);
        // The markup is rewritten only when the glyph in this position actually
        // changes. A mark that merely fades or re-counts costs two style writes
        // rather than an innerHTML parse, which matters because this runs for
        // every body in interest range every frame.
        const wanted = `${mark.icon}:${mark.kind}`;
        if (slot.drawn !== wanted) {
          slot.drawn = wanted;
          // Colour by `kind` and by nothing else: eight colours over a head is a
          // legend rather than a picture, and "is that good or bad for them"
          // is the question a player asks first and answers fastest.
          slot.glyph.innerHTML = statusIconSvg(mark.icon, {
            size: STATUS_ICON_PX,
            color: mark.kind === 'boon' ? STATUS_BOON : STATUS_AFFLICTION,
          });
        }
        const count = mark.showsCount && mark.stacks > 1 ? String(mark.stacks) : '';
        if (slot.count.textContent !== count) slot.count.textContent = count;
        // Read by `scripts/probe-status-marks.ts`, for the same reason the health
        // bar carries `data-entity`: so a probe can assert what is on a body
        // without re-deriving the camera projection or reading SVG paths.
        slot.root.dataset['status'] = mark.id;
      }

      // Changing a skill (spec 188). Stateless like the swirl above and for the
      // same reason: a body that is busy right now is busy whether or not this
      // client watched it start, so there is nothing per-body to retain.
      const changing = swapOverhead(entity.activity, entity.activityUntilTick, tick);
      element.swap.style.display = changing.visible ? 'block' : 'none';
      if (changing.visible) {
        element.swapFill.style.width = `${changing.progress * 100}%`;
      }

      const fill = flashes.read(anchor.id, entity.health, entity.maxHealth, tick * TICK_MS);
      // The flinch moves the *bar*, not the body: it is added to the anchor
      // here rather than being a transform of its own, because the holder's
      // transform is what centres it over the head and a second one would have
      // to know about the first.
      element.root.style.left = `${anchor.x + fill.shakeX}px`;
      element.root.style.top = `${anchor.y + fill.shakeY}px`;
      element.health.style.width = `${fill.health * 100}%`;
      element.ghost.style.width = `${fill.ghost * 100}%`;
      element.health.style.background = entity.id === view.selfEntityId ? BAR_SELF : BAR_ENEMY;

      // Shown only once the guard is dented, because a full guard is the
      // resting state of every body in the world and a bar that is always full
      // is a bar nobody reads. It refills whole on a break (spec 147), so it
      // also *leaves* at the moment the stagger lands -- which is the same
      // information from the other side.
      const guard = Math.min(1, Math.max(0, entity.poise ?? 1));
      element.guard.style.visibility = guard < 1 ? 'visible' : 'hidden';
      element.guardFill.style.width = `${guard * 100}%`;
      element.root.style.display = look.showsHealth ? 'block' : 'none';

      if (cast) {
        const progress = castBar(cast, tick);
        element.cast.style.display = 'block';
        element.castFill.style.width = `${progress.progress * 100}%`;
        // Amber while it can still be called off, blue once it cannot -- the
        // one distinction the whole wind-up design rests on. A turn shows as an
        // empty track in its own colour: committed, but not yet swinging.
        element.cast.style.background = progress.turning
          ? 'rgba(120,170,220,.55)'
          : 'rgba(0,0,0,.65)';
        element.castFill.style.background = progress.cancellable ? '#ffcf6b' : '#7fd0ff';
        element.root.style.display = 'block';
      } else {
        element.cast.style.display = 'none';
      }
    }

    for (const [id, element] of bars) {
      if (live.has(id)) continue;
      element.root.remove();
      bars.delete(id);
    }
    // The flashes go with the bars, by the same set on the same frame.
    flashes.retain(live);

    // Damage numbers stay on the ground the blow landed on (spec 096): the
    // field holds a world point each and re-projects it, so nothing here needs
    // the body -- or needs it to still exist.
    const step = popups.step(project);
    for (const id of step.expired) dropPopup(id);
    for (const placement of step.live) {
      const element = popupElements.get(placement.id);
      if (!element) continue;
      element.style.display = placement.onScreen ? 'block' : 'none';
      element.style.left = `${placement.left}px`;
      element.style.top = `${placement.top}px`;
      element.style.opacity = placement.opacity.toFixed(3);
    }

    // The refusal stack (spec 143). Elements are only ever appended, and the
    // field only ever expires from the front, so DOM order stays the field's
    // order without anything here sorting: oldest at the top, newest at the
    // bottom edge the column is pinned to.
    const errorStep = errorLog.step(nowMs);
    for (const id of errorStep.expired) dropError(id);
    for (const line of errorStep.live) {
      const element = errorElements.get(line.id);
      if (!element) continue;
      // Only when it changes: a repeat rewrites the line to carry its count, and
      // every other frame this is the same string it already holds.
      if (element.dataset['text'] !== line.text) {
        element.dataset['text'] = line.text;
        element.innerHTML = pixelTextSvg(line.text, {
          scale: layout.errorScale,
          fill: ERROR_RED,
          outline: '#1a0406',
        });
      }
      const opacity = line.opacity.toFixed(3);
      if (element.style.opacity !== opacity) element.style.opacity = opacity;
    }

    // Lit from what the server says is *worn*, never from the last click and no
    // longer from the stat block (spec 126). Inferring the weapon from
    // `basicAttackId` was a guess with a wrong answer in it -- every melee item
    // in the table names the same swing, so the switch lit whichever one it
    // happened to list first and reported "clicked Hunting Bow, lit Worn Sword".
    // A refused equip still leaves the old one lit, because the equipment that
    // arrives is the server's and not this client's hope.
    const held = view.equipment.mainHand;
    for (const weapon of weaponSlots) {
      const current = weapon.itemId === held;
      weapon.button.style.borderColor = current ? '#ffcf6b' : '#33405a';
      weapon.button.style.background = current ? '#243044' : '#182130';
      weapon.button.style.color = current ? '#f2f6fb' : '#98a4b4';
    }

    // The two pools, left of the slots (spec 164). Both numbers have been on the
    // wire since spec 069 and both were text in a hidden readout.
    //
    // Health goes through `HealthFlashes` -- the same reading the bar over a
    // body gets (specs 145/146), so the white chunk a blow leaves and the kick
    // it lands with are the ones already on screen rather than a second
    // implementation of them. Absolute health rather than the fraction, because
    // that is what stops a changing maximum reading as a blow.
    //
    // Only once the maximum is known: reading 0-of-0 for the opening frames
    // would put a track at zero and draw the first `Stats` message as a heal,
    // which is harmless but is a state worth not creating.
    const pools = poolBars(view);
    if (pools.health.known) {
      const fill = poolFlashes.read(
        view.selfEntityId,
        pools.health.current,
        pools.health.max,
        tick * TICK_MS,
      );
      healthPool.fill.style.width = `${fill.health * 100}%`;
      if (healthPool.ghost) healthPool.ghost.style.width = `${fill.ghost * 100}%`;
      // The kick moves the whole block rather than one bar: the two pools are one
      // group and half of it flinching would read as a layout bug.
      poolBlock.style.transform = `translate(${fill.shakeX.toFixed(2)}px,${fill.shakeY.toFixed(2)}px)`;
    } else {
      healthPool.fill.style.width = '0';
      if (healthPool.ghost) healthPool.ghost.style.width = '0';
    }
    // Only ever the local body, and only the current one: an id changes on a
    // reconnect, and a map that only grew would be a leak with one entry a
    // session in it.
    poolFlashes.retain(new Set([view.selfEntityId]));
    resourcePool.fill.style.width = `${pools.resource.fraction * 100}%`;
    writePoolLabel(healthPool.label, pools.health.text);
    writePoolLabel(resourcePool.label, pools.resource.text);

    // The player's own status row (spec 191). Same pure function the floating
    // marks are drawn from, so the two can never disagree about what is on the
    // body; what this one adds is the countdown and the description.
    const selfBody = view.entities.find((entity) => entity.id === view.selfEntityId);
    const selfMarks = statusMarks(selfBody?.statuses ?? [], tick);
    selfStatusRow.style.display = selfMarks.length > 0 ? 'flex' : 'none';
    for (let index = 0; index < selfStatusSlots.length; index += 1) {
      const slot = selfStatusSlots[index];
      if (!slot) continue;
      const mark = selfMarks[index];
      if (!mark) {
        slot.root.style.display = 'none';
        continue;
      }
      slot.root.style.display = 'flex';
      slot.root.style.opacity = mark.opacity.toFixed(2);
      if (slot.drawn !== mark.id) {
        slot.drawn = mark.id;
        slot.glyph.innerHTML = statusIconSvg(mark.icon, {
          size: SELF_STATUS_PX,
          color: mark.kind === 'boon' ? STATUS_BOON : STATUS_AFFLICTION,
        });
        // `innerHTML` replaces the count element, so it goes back afterwards.
        slot.glyph.append(slot.count);
        // The Technical Description, from the one writer (spec 191). Set with
        // the glyph rather than per frame: it is a property of *which* status
        // this is and nothing about it changes as the clock runs down.
        const visual = visualFor(mark.id);
        slot.root.title =
          visual === null ? mark.name : `${mark.name}\n${technicalText(describeStatus(visual))}`;
        // Read by `scripts/probe-status-marks.ts`, like the floating row's.
        slot.root.dataset['selfStatus'] = mark.id;
      }
      const count = mark.showsCount && mark.stacks > 1 ? String(mark.stacks) : '';
      if (slot.count.textContent !== count) slot.count.textContent = count;
      // Null timer draws nothing at all -- not a dash and not a zero. An
      // indefinite status showing a clock is the one thing this must not do.
      const timer = mark.timer ?? '';
      if (slot.timer.textContent !== timer) slot.timer.textContent = timer;
    }

    // The experience strip along the very bottom (spec 164). Written only when
    // it moves: a per-frame style write is a per-frame layout, and experience
    // changes a handful of times a session.
    const xp = xpBar(view.level, view.experience);
    if (xpFill.dataset['detail'] !== xp.detail) {
      xpFill.dataset['detail'] = xp.detail;
      xpFill.style.width = `${xp.fraction * 100}%`;
      xpStrip.title = xp.detail;
      xpDetail.innerHTML = pixelTextSvg(xp.detail, {
        scale: layout.xpDetailScale,
        fill: '#ffe6a8',
        outline: '#0a0d14',
      });
      // What `scripts/probe-bottom-hud.ts` reads: the line is a path now and has
      // no text content to ask for.
      xpDetail.dataset['text'] = xp.detail;
    }

    // "YOU ARE DEAD", and the way back up (spec 164). The overlay is derived
    // from replicated health, and the button asks the server -- nothing here
    // decides that a player is alive again.
    const death = deathOverlay(view);
    if (death) {
      if (deathBanner.dataset['text'] !== death.text) {
        deathBanner.dataset['text'] = death.text;
        deathBanner.innerHTML = pixelTextSvg(death.text, {
          scale: layout.compact ? 5 : 8,
          fill: DEATH_RED,
          outline: '#000000',
        });
      }
      deathLayer.style.display = 'flex';
    } else {
      deathLayer.style.display = 'none';
    }

    const self = view.entities.find((entity) => entity.id === view.selfEntityId);
    const stats = view.stats;
    const monsters = view.entities.filter((entity) => entity.kind === EntityKind.Monster).length;
    status.textContent =
      // The client's own clock first, and the last delta beside it. They used to
      // be one number -- `view.tick` -- which was fine only because something was
      // always moving: deltas are suppressed when nothing changed, and since
      // spec 076 a field of monsters that nobody has hit is genuinely still, so
      // the readout sat at 3 while the game ran perfectly well underneath it.
      `tick ${Math.floor(tick)}   delta ${view.tick}   seed ${view.worldSeed ?? '-'}\n` +
      `hp ${Math.round(self?.health ?? 0)}/${Math.round(stats?.maxHealth ?? 0)}   ` +
      // Guard beside health, in the same absolute units (spec 147). The wire
      // carries a *fraction* -- one byte, and the ceiling is already known from
      // the stats message -- so the whole number is reconstructed here. The
      // floating bar can live on the fraction; a readout compared against
      // somebody's `staggerPower` cannot.
      `guard ${Math.round((self?.poise ?? 0) * (stats?.traits.maxPoise ?? 0))}/` +
      `${Math.round(stats?.traits.maxPoise ?? 0)}   ` +
      `lvl ${view.level}   xp ${view.experience}\n` +
      // The health economy, in the readout rather than as a bar (spec 156). The
      // meter arrives as a fraction and is shown as one: the absolute progress
      // and the threshold behind it are server tuning, and a client that knew
      // both could work out exactly which kill produces the next mote.
      `motes ${Math.round(view.restoration.meter * 100)}%   ` +
      `flask ${view.restoration.charges}/${view.restoration.maxCharges}\n` +
      `monsters ${monsters}   corrections ${corrections}` +
      (view.connected ? '' : '   (disconnected)') +
      `\n${targetLine(view, targetId)}` +
      `\n${aimLine(aiming)}`;

    // The compact HUD shows the aim line and nothing else from that block, and
    // only while there is an aim to answer -- an empty box floating over the
    // grass would be the panel back by another name.
    if (layout.compact) {
      const hint = aiming.abilityId === null ? '' : aimLine(aiming);
      aimHint.textContent = hint;
      aimHint.style.display = hint === '' ? 'none' : 'block';
    }
  }

  return {
    element: root,
    update,
    showSpawners(marks) {
      const seen = new Set<string>();
      for (const mark of marks) {
        if (!mark.onScreen) continue;
        seen.add(mark.id);
        let element = spawnerMarks.get(mark.id);
        if (!element) {
          element = document.createElement('div');
          element.style.cssText =
            'position:absolute;transform:translate(-50%,-100%);white-space:nowrap;' +
            'font:11px ui-monospace,Menlo,monospace;padding:2px 6px;border-radius:5px;' +
            'background:rgba(10,14,20,.72);border:1px solid rgba(224,96,92,.7);';
          // Which spawner this is, for the same reason a bar says which body it
          // belongs to: `scripts/preview-world.ts` needs a handful of *fixed*
          // world points on screen to measure a damage number against, and a
          // spawner is the only thing in the overlay that never moves.
          element.dataset['spawner'] = mark.id;
          spawnerLayer.append(element);
          spawnerMarks.set(mark.id, element);
        }
        element.textContent = mark.text;
        // Dimmed while the ground is empty, lit while something is standing on
        // it: the two states are readable without reading the text.
        element.style.color = mark.waiting ? '#9aa3b0' : '#f0a09c';
        element.style.left = `${Math.round(mark.x)}px`;
        element.style.top = `${Math.round(mark.y)}px`;
      }
      for (const [id, element] of spawnerMarks) {
        if (seen.has(id)) continue;
        element.remove();
        spawnerMarks.delete(id);
      }
    },
    addDamage(entityId, at, damage, crit) {
      const heal = damage < 0;
      const text = (heal ? '+' : '') + Math.round(Math.abs(damage)).toString();
      const element = document.createElement('div');
      // Hidden until the first `update` places it: a number is spawned from a
      // message, which is not a frame, so until one has been drawn there is no
      // camera to ask and the only honest position is nowhere.
      element.style.cssText = 'position:absolute;transform:translate(-50%,-100%);display:none;';
      // The pixel font (spec 065) rather than the browser's UI face: these float
      // over a posterized, low-resolution world, and system text over it read
      // like a debug overlay that had been left switched on.
      element.innerHTML = pixelTextSvg(text, {
        scale: crit ? 4 : 3,
        fill: heal ? '#8ce696' : crit ? '#ffdc78' : '#f4f4f4',
        outline: '#0a0d14',
      });
      root.append(element);
      const added = popups.add(entityId, at);
      // Stamped so one number can be followed across frames from outside, the
      // way `data-entity` lets a bar be. `preview-world.ts` reads it to check
      // that a number pans with the ground rather than with the camera, which
      // is a fact only a real browser with a real camera can settle.
      element.dataset['damageId'] = String(added.id);
      popupElements.set(added.id, element);
      // The field caps how many float at once; whatever it dropped to make room
      // is an element nobody will place again.
      for (const id of added.expired) dropPopup(id);
    },
    addExperience(group, at, amount) {
      // Nothing to say about a gain of nothing. `XpGains` already reports 0
      // rather than a negative, so this is the rounding's floor and not a
      // second opinion about whether experience can go backwards.
      const whole = Math.round(amount);
      if (whole <= 0) return;
      const element = document.createElement('div');
      element.style.cssText = 'position:absolute;transform:translate(-50%,-100%);display:none;';
      // Labelled, because the colour and the column say "this is not damage"
      // and neither of them says what it *is*: a purple number under a white
      // one is a second quantity, and which quantity is the whole point.
      //
      // What the label cost was measured before it was kept -- `+24 XP` is
      // three times the width of the `24` alone, which is why this is the
      // smallest text of the pair, at half a critical's scale. It is the
      // second number spawned on one tick and its job is to be readable
      // rather than to be the headline.
      element.innerHTML = pixelTextSvg(`+${whole} XP`, {
        scale: 2,
        fill: XP_PURPLE,
        outline: XP_PURPLE_DARK,
      });
      root.append(element);
      const added = popups.add(group, at, 'xp');
      // Stamped the way a damage number is, so one can be followed across
      // frames from outside without re-deriving the camera.
      element.dataset['xpPopup'] = String(added.id);
      popupElements.set(added.id, element);
      for (const id of added.expired) dropPopup(id);
    },
    error(text) {
      const added = errorLog.add(text);
      // Nothing is created for a repeat: `add` folded it into a line that
      // already has an element, and the next frame rewrites that line's text.
      if (!errorElements.has(added.id)) {
        const element = document.createElement('div');
        element.style.cssText = 'display:block;';
        errors.append(element);
        errorElements.set(added.id, element);
      }
      // Whatever the field dropped to stay under capacity is an element nobody
      // will place again.
      for (const id of added.expired) dropError(id);
    },
    showOpenWindows(open) {
      for (const slot of systemSlots) {
        const on = open.includes(slot.id);
        slot.button.style.borderColor = on ? '#ffcf6b' : '#33405a';
        slot.button.style.background = on ? '#243044' : '#182130';
        slot.button.style.color = on ? '#f2f6fb' : '#98a4b4';
        // Says so out loud as well as in colour: the button is a toggle, and a
        // screen reader has no border to look at.
        slot.button.setAttribute('aria-pressed', String(on));
      }
    },
    floorCss: bottomEdge(layout),
    slotSideCss: ACTION_SLOT_CSS,
    showsSlotKeys: layout.showsKeyNumber,
    leftReserveCss: poolReserve(layout),
    setActionBar(box) {
      if (box.width === actionBar.width && box.height === actionBar.height) return;
      actionBar = box;
      placeAgainstBar();
    },
    onOpen(handler) {
      openHandler = handler;
    },
    onEquip(handler) {
      equipHandler = handler;
    },
    onRespawn(handler) {
      respawnHandler = handler;
    },
    toggleReadout() {
      readoutWanted = !readoutWanted;
      return applyReadout();
    },
  };
}

/**
 * The one line of target readout (spec 070). Deliberately one line: knowing
 * what you are hitting and how much of it is left is the whole job, and a
 * target frame is a different change.
 */
function targetLine(view: ClientView, targetId: number | null): string {
  const target = targetId === null
    ? undefined
    : view.entities.find((entity) => entity.id === targetId);
  if (!target) return 'no target';
  return `target ${displayName(target)} ${Math.round(target.health)}/${Math.round(target.maxHealth)}`;
}

/**
 * The bottom line: what the next click does (spec 080).
 *
 * It replaces the fixed key list, which said the same six things whatever the
 * player was in the middle of. While a skill is aimed there is exactly one
 * question on screen, and this is it.
 */
/**
 * Whether the hint line should name gestures rather than mouse buttons.
 *
 * Answered once and remembered: `aimLine` runs every frame, and this is a media
 * query about the hardware rather than about the window.
 */
let touchHintsCache: boolean | null = null;
function touchHints(): boolean {
  touchHintsCache ??= isHandheldDevice();
  return touchHintsCache;
}

function aimLine(aiming: { readonly abilityId: string | null; readonly pending: boolean }): string {
  const ability = aiming.abilityId === null ? null : abilityById(aiming.abilityId);
  // A phone has no right button and no Escape key, so naming them would be
  // instructions for a machine the player is not holding (spec 093).
  const touch = touchHints();
  if (!ability) {
    return touch
      // No key numbers to name on a phone since spec 094 -- the bar is tapped.
      ? 'tap ground to move, a unit to attack · pinch to zoom · tap a skill to cast it'
      // The range is derived rather than typed, or it goes stale the next time a
      // row is added to the bar -- which is exactly what spec 156 did to the
      // `1-8` that was here.
      : `right-click ground to move, a unit to attack · WASD · 1-${BAR_SLOT_COUNT} slots · Esc cancel`;
  }
  if (!aiming.pending) {
    return touch
      ? `${ability.name}: moving into range`
      : `${ability.name}: moving into range · right-click to call it off`;
  }
  if (touch) {
    // The unit case is the one place the two disagree, and it is worth saying
    // out loud: on touch, tapping anywhere but a body is how you back out.
    return aimGesture(ability) === 'unit'
      ? `aiming ${ability.name} — tap a unit, tap the ground to cancel`
      : `aiming ${ability.name} — tap to place`;
  }
  const pick = aimGesture(ability) === 'unit' ? 'left-click a unit' : 'left-click to place';
  return `aiming ${ability.name} — ${pick}, right-click to cancel`;
}

