import { createHud } from './world/hud.js';
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
    entities: [{ id: 1, kind: 0, typeId: 'player', x: 0, y: 0, z: 0, health: 96, maxHealth: 140, poise: 1 }],
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
hud.onUse((abilityId) => used.push(abilityId));
app.append(hud.element);
hud.element.style.inset = '0';

function draw(): void {
  const view = { ...baseView(), ...overrides } as unknown as ClientView;
  hud.update(view, [], 400, 0, null, { abilityId: null, pending: false }, null, 1000);
}

draw();

window.hudProbe = {
  ready: true,
  set(next) {
    overrides = next;
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
