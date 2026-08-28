import { createHud } from './world/hud.js';
import { UiLayer } from './world/ui-layer.js';
import { InputMap } from '../../ui/input/input-map.js';
import type { ClientView } from '../../server/client/game-client.js';

/**
 * The measuring rig for the bottom band (spec 164).
 *
 * Dev-server only -- `vite build` bundles `index.html` and nothing else, so this
 * page is never part of a shipped build. Driven by
 * `scripts/probe-bottom-hud.ts`.
 *
 * It exists because the four things spec 164 added to the HUD are only true once
 * a browser has laid them out, and the Play tab can answer none of the questions
 * without a fight: the experience strip only moves when a monster dies, the
 * death overlay only appears when the player loses, and the respawn button can
 * only be clicked after that. Waiting for all three in a real session under
 * software GL -- which paints this page a few frames a second -- would be a
 * harness that measures patience.
 *
 * So this mounts the **real** `createHud` over a fabricated `ClientView` and
 * lets the driver set the numbers. What it therefore cannot check is anything
 * about where the view's numbers come from; that half is asserted in Node
 * (`xp-bar.test.ts`, `pool-bars.test.ts`, `death.test.ts`) and over a real wire
 * (`death-and-experience.test.ts`). What only exists here is whether any of it
 * is on screen, in the right place, and connected to anything.
 */

interface ProbeApi {
  ready: boolean;
  /** Draw one frame with these overrides folded into the base view. */
  set(overrides: Record<string, unknown>): void;
  /** How many times the respawn button's handler has fired. */
  respawns(): number;
  /** Which ability ids the slot buttons have asked to cast, in order. */
  used(): string[];
  /** Land a blow at the rig's one world point (spec 096). */
  hit(damage: number, crit: boolean): void;
  /** Earn `amount` experience at the same point (spec 184). */
  reward(amount: number): void;
  /** Draw `frames` more frames, so a floating number gets somewhere. */
  advance(frames: number): void;
  /**
   * Put one body's floating bar at a screen point, or take it away (spec 186).
   *
   * The per-body holder -- name, health, guard, cast bar, stun swirl, status row
   * -- is drawn from `anchors` rather than from the view, because in the game a
   * body's screen position is something the scene works out. There is no scene
   * here, so a rig that wants to look at that holder has to say where the body
   * is; nothing before spec 186 did, so it defaulted to none and stayed there.
   */
  anchor(at: { id: number; x: number; y: number } | null): void;
}

declare global {
  interface Window {
    hudProbe?: ProbeApi;
  }
}

const app = document.getElementById('app');
if (!app) throw new Error('no #app');

const STATS = {
  maxHealth: 140,
  moveSpeed: 250,
  turnRate: 540,
  attackDamage: 12,
  attackRange: 60,
  baseAttackTimeTicks: 24,
  attackSpeed: 0,
  attackSpeedMult: 1,
  armor: 0,
  spellPower: 1,
  critChance: 0,
  maxResource: 60,
  resourceRegen: 0.1,
  basicAttackId: 'melee.slash',
  traits: { maxPoise: 100, fallbackCharges: 2 },
};

/** A living player at level 7, most of the way through the level. */
function baseView(): Record<string, unknown> {
  return {
    tick: 400,
    entities: [
      {
        id: 1,
        kind: 0,
        typeId: 'player',
        x: 0,
        y: 0,
        z: 0,
        health: 96,
        maxHealth: 140,
        poise: 1,
        // Spec 185. Empty by default so the row is off unless a case asks for
        // it, which is what the shipped HUD does for a body carrying nothing.
        statuses: [],
      },
    ],
    selfEntityId: 1,
    self: { x: 0, y: 0 },
    drops: [],
    casts: [],
    cooldowns: {},
    resource: 41,
    restoration: { meter: 0.3, charges: 2, maxCharges: 2 },
    stats: STATS,
    equipment: { mainHand: null, offHand: null, head: null, chest: null, legs: null, trinket: null },
    level: 7,
    experience: 380,
    requestedAbilityId: null,
    connected: true,
    worldSeed: 1,
    spawners: [],
  };
}

let respawnCount = 0;
const used: string[] = [];
let overrides: Record<string, unknown> = {};

/**
 * One world point, in the middle of the frame (spec 184).
 *
 * It used to answer `onScreen: false` from the origin, which was fine while
 * nothing here spawned a floating number -- the projector's only other caller
 * is the hovered drop's label, and this rig hovers nothing. A number needs a
 * place to be photographed at, and the honest one is the point the rig claims
 * every body is standing on.
 */
const PROBE_POINT = { x: 560, y: 300 };
const hud = createHud(() => ({ x: PROBE_POINT.x, y: PROBE_POINT.y, onScreen: true }));
hud.onRespawn(() => {
  respawnCount += 1;
});
app.append(hud.element);
hud.element.style.inset = '0';

/**
 * The interface canvas, because the action bar is on it now (spec 196).
 *
 * The rig has to mount the real one rather than fake a row of boxes: what is
 * being asked is whether the five slots are *there*, whether an empty one is
 * inert, and whether the pool block still sits clear of them -- and the last of
 * those is a claim about two surfaces, which is exactly the kind that passes in
 * Node while being wrong on screen.
 *
 * Every callback is a no-op except the one this rig measures. None of them can
 * reach a server: there isn't one.
 */
const nothing = (): void => undefined;
const ui = new UiLayer(app, {
  map: new InputMap(),
  onMove: nothing,
  onDropItem: nothing,
  onSpend: nothing,
  onAdvance: nothing,
  onRespec: nothing,
  onBuy: nothing,
  onSell: nothing,
  onBuyBack: nothing,
  onVendor: nothing,
  // Spec 244. This rig fabricates a view to photograph the bottom band; it
  // never holds a conversation, so there is nothing for a reply to mean.
  onDialogueChoice: nothing,
  onDialogueAdvance: nothing,
  onDialogueLeave: nothing,
  onTradeOffer: nothing,
  onTradeAccept: nothing,
  onTradeRespond: nothing,
  onTradeCancel: nothing,
  onTradeDismiss: nothing,
  onSay: nothing,
  onBindingsChanged: nothing,
  onScaleChosen: nothing,
  onShowFpsChosen: nothing,
  onMaxZoomChosen: nothing,
  onLayoutChanged: nothing,
  onCastSlot: (abilityId) => {
    used.push(abilityId);
    draw();
  },
  onHoverSlot: nothing,
});
// The two facts the bar needs that only the HUD's table knows: how much of the
// frame's floor the experience strip has, and how big a slot must be for a
// finger. Pushed once here exactly as `view.ts` pushes them, or the bar draws at
// the widget's bare default and the rig measures a size the game never shows.
ui.setActionBarFloorCss(hud.floorCss);
ui.setActionBarSlotCss(hud.slotSideCss);
ui.setShowsSlotKeys(hud.showsSlotKeys);

/**
 * Hand the interface the mouse, the way `view.ts` does.
 *
 * The UI canvas is `pointer-events: none` -- it sits over the world and the
 * world's own listeners offer it every press first -- so a rig that mounts the
 * layer and forwards nothing has an action bar that draws perfectly and cannot
 * be clicked. Which is exactly what a harness asking "is an empty slot inert"
 * would then be measuring: nothing at all, correctly, for the wrong reason.
 *
 * Coordinates are relative to the UI canvas's own box, which is what `toUi`
 * expects and what the world canvas gives it in the game.
 */
const NO_MODS = { shift: false, ctrl: false, alt: false, meta: false };
for (const phase of ['down', 'up', 'move'] as const) {
  const name = phase === 'move' ? 'mousemove' : phase === 'down' ? 'mousedown' : 'mouseup';
  globalThis.addEventListener(name, (raw) => {
    const event = raw as MouseEvent;
    const rect = ui.element.getBoundingClientRect();
    ui.handlePointer(
      phase,
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      phase === 'move' ? -1 : event.button,
      NO_MODS,
    );
    draw();
  });
}

/**
 * The floating bars this rig draws, if any (spec 186).
 *
 * Empty by default, which is what every case before spec 186 wanted: the bottom
 * band is drawn from the view alone, and a body's own bar needs an *anchor* --
 * a screen point the scene worked out. There is no scene here, so a rig that
 * wants the per-body holder has to say where the body is.
 */
let anchors: { id: number; x: number; y: number; onScreen: boolean }[] = [];

function draw(): void {
  const view = { ...baseView(), ...overrides } as unknown as ClientView;
  // The interface first, so the bar has been laid out by the time the HUD is
  // asked to place the pool block against it.
  ui.update(view, 1000, 400);
  hud.setActionBar(ui.actionBarBoxCss());
  hud.update(view, anchors, 400, 0, null, { abilityId: null, pending: false }, null, 1000);
  publish();
}

/**
 * Where the interface drew its slots, in CSS pixels, on the page (spec 196).
 *
 * The bar is a canvas, so "there are five slots and the third is empty" has no
 * element to ask. Published in *CSS* pixels rather than UI ones, unlike the Play
 * tab's own readout, because everything else this rig is measured against is a
 * DOM box and a harness comparing the two should not have to do the conversion
 * twice.
 */
function publish(): void {
  const slots = ui.actionBarSlotsCss();
  app?.setAttribute(
    'data-bar-slots',
    slots
      .map(
        ({ ability, rect }) =>
          `${ability}@${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
      )
      .join(';'),
  );
}

draw();

window.hudProbe = {
  ready: true,
  set(next) {
    overrides = next;
    draw();
  },
  anchor(at) {
    anchors = at === null ? [] : [{ id: at.id, x: at.x, y: at.y, onScreen: true }];
    draw();
  },
  respawns: () => respawnCount,
  used: () => [...used],
  hit(damage, crit) {
    hud.addDamage(7, { x: 0, y: 0, lift: 0 }, damage, crit);
    draw();
  },
  reward(amount) {
    hud.addExperience(7, { x: 0, y: 0, lift: 0 }, amount);
    draw();
  },
  advance(frames) {
    for (let frame = 0; frame < frames; frame++) draw();
  },
};
