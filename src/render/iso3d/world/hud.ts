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
import { attackTimingFor } from '../../../server/sim/abilities.js';
import { SERVER_TICK_RATE } from '../../../server/config.js';
import { castBar } from './cast.js';
import { aimGesture } from './aim.js';
import { appearanceOf, displayName } from './appearance.js';
import { pixelTextSvg } from './pixel-font.js';
import { isHandheldDevice } from '../device.js';
import { DamagePopups, type Projector, type WorldAnchor } from './damage-popup.js';
import { ErrorLog } from './error-log.js';
import { HealthFlashes } from './health-bar.js';
import { errorStackBottom, hudLayout } from './hud-layout.js';
import { systemIconSvg, weaponIconSvg, type SystemIconId } from './icons.js';
import type { WindowId } from './key-actions.js';

/** The slot being aimed (spec 080). The aim indicator's colour, in the DOM. */
const AIM_HIGHLIGHT = '#7fd4ff';

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

/** Which abilities the hotbar offers, in order. Keys 1..n. */
export const HOTBAR: readonly string[] = [
  'melee.slash',
  'melee.heavy',
  'bolt.arcane',
  'bolt.lob',
  'bolt.seek',
  'ground.quake',
  'self.mend',
  // The flask (spec 156). On the bar rather than on a key of its own, because it
  // is an ability like every other and the only thing that makes it insurance is
  // what it costs -- putting it somewhere special would be the interface
  // claiming a distinction the rules do not make.
  'self.hearthdraught',
  'channel.drain',
];

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
  /** What to call when a hotbar button is clicked. */
  onUse(handler: (abilityId: string) => void): void;
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
  if (!layout.showsReadout) {
    // Hidden, not removed, and still written every frame. It is developer
    // instrumentation and has no business on a 390px frame -- but it is also the
    // only clock `scripts/preview-touch.ts` has: it reads the tick and the target
    // line out of `document.body.textContent`, which includes a `display:none`
    // subtree. Deleting it would leave the touch harness unable to tell "the tap
    // did nothing" from "the frame had not run yet", which is the confusion
    // spec 093 was debugged out of.
    status.style.display = 'none';
    status.setAttribute('aria-hidden', 'true');
  }
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

  // The spawner overlay lives in its own layer so clearing it is one truncation
  // rather than a walk looking for which children were spawners.
  const spawnerLayer = document.createElement('div');
  spawnerLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  root.append(spawnerLayer);
  const spawnerMarks = new Map<string, HTMLElement>();

  // Bottom edge insets are `env()` rather than a number: in landscape the home
  // indicator runs along the bottom and the notch along a side, which is exactly
  // where the hotbar and the weapon switch sit (spec 093).
  const bottom = `calc(${layout.edge}px + env(safe-area-inset-bottom))`;

  const bar = document.createElement('div');
  bar.style.cssText =
    `position:absolute;left:50%;bottom:${bottom};transform:translateX(-50%);display:flex;` +
    `gap:${layout.slotGap}px;font:${layout.slotFontPx}px ui-monospace,Menlo,monospace;pointer-events:auto;`;
  root.append(bar);

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
      `bottom:calc(${layout.edge + layout.slot.height + 6}px + env(safe-area-inset-bottom));` +
      'font:11px ui-monospace,Menlo,monospace;color:#dbe3ee;background:rgba(10,14,20,.72);' +
      'padding:3px 8px;border-radius:5px;pointer-events:none;';
    root.append(aimHint);
  }

  let useHandler: (abilityId: string) => void = () => undefined;

  const slots = HOTBAR.map((abilityId, index) => {
    const ability = abilityById(abilityId);
    const button = document.createElement('button');
    button.style.cssText =
      `width:${layout.slot.width}px;border-radius:6px;border:1px solid #33405a;background:#182130;` +
      'color:#cfd6e0;cursor:pointer;font:inherit;text-align:center;' +
      // Square and centred on a finger: the label is whatever fits inside the
      // target rather than the target being whatever the label needs.
      (layout.compact
        ? `height:${layout.slot.height}px;padding:2px;line-height:1.15;display:flex;` +
          'align-items:center;justify-content:center;'
        : 'padding:6px 4px;line-height:1.5;');
    button.style.position = 'relative';
    button.style.overflow = 'hidden';
    // The number is the key that casts it, so it goes where there are keys. A
    // phone has none, and the digit was taking a third of the button to say so.
    button.innerHTML = layout.showsKeyNumber
      ? `<b>${index + 1}</b><br>${ability?.name ?? abilityId}`
      : (ability?.name ?? abilityId);
    button.title = ability?.description ?? '';
    button.addEventListener('click', () => useHandler(abilityId));

    // The cooldown sweep: a shade that drains off the bottom as the ability
    // comes back. Drawn under the label rather than over it, so a greyed button
    // is still readable.
    const sweep = document.createElement('div');
    sweep.style.cssText =
      'position:absolute;left:0;right:0;bottom:0;height:0;background:rgba(8,12,20,.72);' +
      'pointer-events:none;';
    button.append(sweep);

    const remaining = document.createElement('span');
    remaining.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
      `font:700 ${layout.slotCountdownPx}px ui-monospace,Menlo,monospace;color:#e8eef6;` +
      'text-shadow:0 1px 2px #000;pointer-events:none;';
    button.append(remaining);

    bar.append(button);
    return { abilityId, ability, button, sweep, remaining };
  });

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
    weaponCaption.style.cssText = 'color:#8b97a8;letter-spacing:.08em;padding-left:2px;';
    weaponCaption.textContent = 'WEAPON';
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
      const name = document.createElement('span');
      name.textContent = weapon.name;
      button.append(name);
    }
    button.title = ability ? `${ability.name} -- ${ability.description}` : weapon.itemId;
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
      name.textContent = entry.name;
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

    holder.append(name, healthTrack, guard, cast);
    root.append(holder);
    const made: Bar = { root: holder, name, health, ghost, guard, guardFill, cast, castFill };
    bars.set(id, made);
    return made;
  }

  function dropPopup(id: number): void {
    popupElements.get(id)?.remove();
    popupElements.delete(id);
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
    nowMs: number,
  ): void {
    const byId = new Map(view.entities.map((entity) => [entity.id, entity]));
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

    for (const slot of slots) {
      const casting = view.casts.some(
        (cast) => cast.entityId === view.selfEntityId && cast.abilityId === slot.abilityId,
      );
      const requested = view.requestedAbilityId === slot.abilityId;
      slot.button.style.borderColor = casting ? '#ffcf6b' : requested ? '#5c7ba6' : '#33405a';
      slot.button.style.opacity = affordable(view, slot.ability) ? '1' : '0.45';

      // The slot being aimed, lit in the aim's own colour (spec 080), so the
      // question on the ground and the button it came from are one thing.
      const aimed = slot.abilityId === aiming.abilityId;
      slot.button.style.borderColor = aimed ? AIM_HIGHLIGHT : '#33405a';
      slot.button.style.background = aimed ? '#1d2c3d' : '#182130';

      // The sweep is the server's cooldown, played back (spec 065). Its *length*
      // comes from the ability table so the shade shrinks proportionally; the
      // client never decides when something is ready.
      const readyAt = view.cooldowns[slot.abilityId] ?? 0;
      const left = readyAt - tick;
      // The sweep's length is the cadence the cooldown was stamped with, which
      // for the basic attack is the player's own attack interval (specs 070,
      // 144) -- against the table's number the shade would start part-drained
      // and finish early. Through `attackTimingFor`, so the sweep and the sim
      // cannot come to different answers about how long a swing takes.
      const total = Math.max(
        1,
        slot.ability && view.stats
          ? attackTimingFor(slot.ability, { stats: view.stats }).intervalTicks
          : (slot.ability?.cooldownTicks ?? 1),
      );
      if (left > 0) {
        slot.sweep.style.height = `${Math.min(1, left / total) * 100}%`;
        slot.remaining.textContent = formatSeconds(left / SERVER_TICK_RATE);
      } else {
        slot.sweep.style.height = '0';
        slot.remaining.textContent = '';
      }
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
    onUse(handler) {
      useHandler = handler;
    },
    onOpen(handler) {
      openHandler = handler;
    },
    onEquip(handler) {
      equipHandler = handler;
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
      : `right-click ground to move, a unit to attack · WASD · 1-${HOTBAR.length} abilities · Esc cancel`;
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

/** A cooldown countdown: whole seconds while there are several, tenths at the end. */
function formatSeconds(seconds: number): string {
  if (seconds >= 10) return String(Math.ceil(seconds));
  if (seconds >= 1) return seconds.toFixed(1);
  return seconds.toFixed(1);
}

/**
 * Whether the player could pay for an ability right now. Cosmetic dimming only:
 * the server decides, and refuses a cast it will not fund whatever this said.
 *
 * Against the live pool since spec 069. It used to compare with `maxResource`,
 * which only ever answered "could this *ever* be afforded" -- the live number
 * was on the entity and had never been on the wire, so a button for a bolt the
 * player could not currently pay for looked exactly like one they could.
 */
function affordable(view: ClientView, ability: AbilityDefinition | null): boolean {
  if (!ability || !view.stats) return true;
  // The flask's cost is a charge, not resource (spec 156), and an empty one is
  // the same kind of "you cannot press this" as an empty pool. Read off the
  // replicated count minus what a request in flight has already spent, so a
  // second press inside the round trip is dimmed rather than refused.
  const charges = ability.chargeCost ?? 0;
  if (charges > 0 && view.restoration.charges < charges) return false;
  return ability.cost <= view.resource;
}
