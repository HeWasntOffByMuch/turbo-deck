/**
 * Mounting the interface changes no game outcome (spec 131).
 *
 * The same assertion `presentation-only.test.ts` makes about animation, made
 * about the interface, and for the same reason: the brief's rule that widgets
 * carry no game logic is a sentence, and a sentence is not a test. Lint already
 * refuses `src/ui/` the imports it would need to reach the sim, which is the
 * structural half. This is the behavioural half -- **play the same fight twice
 * with the same seed and the same scripted inputs, once with every screen driven
 * and every event fed to it and once with none of it, and require the
 * authoritative state to be identical byte for byte.**
 *
 * It is the one that catches what a type cannot: an adapter that mutates the
 * array it was handed, a screen that writes back into the replica, a rule
 * function borrowed from the server that turns out not to be pure, or shared
 * mutable state perturbed by something nobody thought was an input.
 *
 * `UiScreens` exists in its own file precisely so this can run in Node. The
 * canvas half is one blit and a coordinate conversion, and neither can reach a
 * server.
 */

import { describe, expect, it } from 'vitest';
import { createWorldColliders } from '../../../sim/collision.js';
import { SERVER_PLAYER_RADIUS } from '../../../server/config.js';
import { LoopbackTransport } from '../../../server/net/transport-loop.js';
import { GameServer } from '../../../server/server.js';
import { FLAT_TERRAIN } from '../../../server/world/terrain.js';
import { GameClient, type ClientView } from '../../../server/client/game-client.js';
import { createWorldPredictor } from '../../../server/client/prediction.js';
import { InputMap } from '../../../ui/input/input-map.js';
import { UiScreens } from './ui-screens.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const TICKS = 180;
const VIEWPORT = { width: 400, height: 300 };
const NONE = { shift: false, ctrl: false, alt: false, meta: false };

/** The authoritative facts, as a string. Everything a change would show up in. */
function stateOf(view: ClientView): string {
  const bodies = [...view.entities]
    .sort((a, b) => a.id - b.id)
    .map((entity) =>
      [
        entity.id,
        entity.kind,
        entity.x.toFixed(6),
        entity.y.toFixed(6),
        entity.facing.toFixed(6),
        entity.health,
        entity.maxHealth,
        entity.activity,
      ].join(':'),
    );
  const bag = view.inventory.map((stack) => (stack ? `${stack.defId}x${stack.count}` : '-')).join(',');
  const worn = Object.entries(view.equipment)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([slot, id]) => `${slot}=${id ?? '-'}`)
    .join(',');
  const skills = [...view.skills]
    .sort((a, b) => (a.skillId < b.skillId ? -1 : 1))
    .map((entry) => `${entry.skillId}:${entry.level}`)
    .join(',');
  return [
    `t${view.tick}`,
    bodies.join(','),
    bag,
    worn,
    skills,
    `coins${view.coins}`,
    `lvl${view.level}`,
    `xp${view.experience}`,
    `pts${view.unspentSkillPoints}`,
  ].join('|');
}

interface RunResult {
  readonly states: readonly string[];
  /** Requests the screens emitted. Must be empty: nothing below clicks a button. */
  readonly requests: readonly string[];
  /** Draw commands on the last frame, so "it was actually drawing" is checkable. */
  readonly drawn: number;
  /** Layout writes over the whole run. One, however much hovering happened. */
  readonly layoutWrites: number;
}

/**
 * Play the same scripted fight, with the interface driven or absent.
 *
 * The input script is fixed and reads nothing from the view, so the two runs are
 * the same experiment with one variable. The pointer and key events fed to the
 * interface are *movement and hovering* -- deliberately not presses on a Buy
 * button, because a purchase legitimately changes the state and would make this
 * compare two different games.
 */
async function play(drive: boolean): Promise<RunResult> {
  const transport = new LoopbackTransport();
  const server = new GameServer({
    seed: 11,
    transport,
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
  });
  transport.onConnection((channel) => server.accept(channel));

  const client = new GameClient(transport.connect(), {
    playerId: 'you',
    predictor: (stats, tickRate) =>
      createWorldPredictor({
        world: createWorldColliders([], []),
        terrain: FLAT_TERRAIN,
        radius: SERVER_PLAYER_RADIUS,
        speed: stats.moveSpeed,
        tickRate,
      }),
  });
  client.connect();
  await settle();

  const requests: string[] = [];
  let layoutWrites = 0;
  const screens = new UiScreens(
    {
      map: new InputMap(),
      onMove: (from, to, count) => requests.push(`move:${from.container}${from.index}->${to.container}${to.index}x${count}`),
      onDropItem: (at, count) => requests.push(`drop:${at.container}${at.index}x${count}`),
      onSpend: (skillId) => requests.push(`spend:${skillId}`),
      onAllocate: (key) => requests.push(`allocate:${key}`),
      onRespec: () => requests.push('respec'),
      onBuy: (vendorId, defId) => requests.push(`buy:${vendorId}:${defId}`),
      onSell: (vendorId, index) => requests.push(`sell:${vendorId}:${index}`),
      onBuyBack: (vendorId, index) => requests.push(`buyback:${vendorId}:${index}`),
      onVendor: (vendorId) => requests.push(`vendor:${vendorId}`),
      onTradeOffer: (slots, coins) => requests.push(`tradeOffer:${slots.length}:${coins}`),
      onTradeAccept: (revision) => requests.push(`tradeAccept:${revision}`),
      onTradeRespond: (accept) => requests.push(`tradeRespond:${accept}`),
      onTradeCancel: () => requests.push('tradeCancel'),
      onTradeDismiss: () => requests.push('tradeDismiss'),
      onCastSlot: (abilityId: string) => requests.push(`cast:${abilityId}`),
      onSay: (text: string) => requests.push(`say:${text}`),
      onBindingsChanged: () => requests.push('bindings'),
      onScaleChosen: (choice) => requests.push(`scale:${String(choice)}`),
      onShowFpsChosen: (show) => requests.push(`showFps:${String(show)}`),
      // Counted apart from `requests`, deliberately. Everything in that array is
      // something asked of the *server*; a layout write is a local preference,
      // and the three windows this test opens legitimately cause one. What is
      // worth asserting about it is the debounce -- see below.
      onLayoutChanged: () => {
        layoutWrites += 1;
      },
      nearestVendor: () => null,
    },
    VIEWPORT,
  );

  const states: string[] = [];
  let drawn = 0;

  for (let tick = 0; tick < TICKS; tick += 1) {
    server.tick();
    client.advanceTick();
    const angle = (tick / 40) * Math.PI * 2;
    client.sendInput({ moveX: Math.cos(angle), moveY: Math.sin(angle), facing: angle, buttons: 0 });
    await settle();

    const view = client.view();
    states.push(stateOf(view));
    if (!drive) continue;

    // Open all three replicated screens early and leave them open, so every
    // adapter runs on every frame from then on. A screen that is never opened is
    // a screen whose view-model is never built, and this test would prove
    // nothing about it.
    if (tick === 2) {
      screens.show('inventory');
      screens.show('character');
      screens.show('options');
    }

    // Time is an argument here too: `tick * 16` rather than a clock, so this is
    // a replay rather than something that merely happened once.
    const nowMs = tick * 16;
    screens.update(view, nowMs);

    // Hover and drag the pointer across the whole viewport, and press keys the
    // screens do handle -- arrows move focus between bag cells, Tab walks the
    // controls. All of it reaches widgets; none of it may reach the sim.
    const at = { x: (tick * 7) % VIEWPORT.width, y: (tick * 11) % VIEWPORT.height };
    screens.handlePointer('move', at, -1, NONE);
    screens.handleKey(tick % 2 === 0 ? 'ArrowRight' : 'ArrowDown', 'down', NONE);
    screens.handleKey('KeyQ', 'down', NONE, 'q');
    screens.moveFocus(1);
    drawn = screens.paint().length;
  }

  return { states, requests, drawn, layoutWrites };
}

describe('mounting the interface is presentation only', () => {
  it('does not change one byte of the authoritative state', async () => {
    const [mounted, bare] = await Promise.all([play(true), play(false)]);
    expect(mounted.states).toEqual(bare.states);
  }, 30_000);

  it('was actually drawing, so the comparison above means something', async () => {
    // Without this, a run whose interface silently did nothing would pass the
    // test above and prove nothing at all.
    const mounted = await play(true);
    expect(mounted.drawn).toBeGreaterThan(0);
    expect(mounted.states.length).toBe(TICKS);
  }, 30_000);

  /**
   * What a session of hovering and typing emits, on both counts.
   *
   * Two assertions over one run rather than two runs, and that is deliberate:
   * `play` stands up a server, a client, a full `UiScreens` and its atlas and
   * drives 180 ticks, which makes it the heaviest fixture in the suite. Spending
   * another whole one to read a second integer off the same experiment is a cost
   * with nothing at the end of it -- and this file already runs `play` four
   * times.
   *
   * **No request.** A screen that asked the server for something nobody clicked
   * would change the state *legitimately*, and the comparison above would look
   * like a broken sim.
   *
   * **One layout write** (spec 147). The run opens three windows on tick 2 and
   * then hovers, types and moves focus on every frame after it. A save per
   * change would be a `localStorage` write on most of them; the debounce makes
   * it one.
   */
  it('emits no request from hovering and typing, and writes the layout once', async () => {
    const mounted = await play(true);
    expect(mounted.requests).toEqual([]);
    expect(mounted.layoutWrites).toBe(1);
  }, 30_000);
});
