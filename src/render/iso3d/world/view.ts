/**
 * The Play tab (spec 057 stage 3, spec 063).
 *
 * The commit where the answer to "why is there no player in the admin panel"
 * becomes "there is one". Nothing in this file simulates anything: it boots a
 * server, opens a client session against it, and each frame hands
 * `GameClient.view()` to a scene that draws it.
 *
 * Single-player is a server in this tab over a loopback transport, which is what
 * spec 057 says single-player is. The three objects below are wired in the order
 * that matters -- build the world, give it to the server, tell the client, draw
 * what comes back -- and the only thing that would change to play on a real
 * socket is which transport is constructed.
 *
 * The frame loop is the one piece with any subtlety, and it is spec 057's rate
 * split showing through:
 *
 *  - the **sim** advances in whole 60Hz ticks from an accumulator, never on the
 *    frame's elapsed time;
 *  - **deltas** land every third tick, so the renderer interpolates across a
 *    three-tick interval rather than a frame;
 *  - **drawing** happens once per animation frame, at whatever rate the browser
 *    paints, reading a smoothed pose that is presentation and nothing else.
 */

import { GameClient } from '../../../server/client/game-client.js';
import { createWorldPredictor } from '../../../server/client/prediction.js';
import { LoopbackTransport } from '../../../server/net/transport-loop.js';
import { GameServer } from '../../../server/server.js';
import { buildWorld } from '../../../server/world/build.js';
import {
  BROADCAST_EVERY_N_TICKS,
  SERVER_PLAYER_RADIUS,
  SERVER_TICK_RATE,
} from '../../../server/config.js';
import { abilityById } from '../../../server/data/abilities.js';
import { viewSeed } from '../seed.js';
import type { ViewHandle } from '../view-handle.js';
import { createHud, HOTBAR } from './hud.js';
import { moveIntent } from './intent.js';
import { WorldScene } from './scene.js';

const TICK_MS = 1000 / SERVER_TICK_RATE;
/** Never advance more than this many ticks in one frame, after a long pause. */
const MAX_CATCH_UP_TICKS = 10;
/** Ms between deltas -- the interval the renderer interpolates across. */
const DELTA_MS = TICK_MS * BROADCAST_EVERY_N_TICKS;

export function mountWorld(container: HTMLElement): ViewHandle {
  const root = document.createElement('div');
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#0b0b12;';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;';
  root.append(canvas);

  // --- the world, the server, and the client that reads it ---------------
  const seed = viewSeed();
  const world = buildWorld(seed);

  const transport = new LoopbackTransport();
  const server = new GameServer({ seed, built: world, transport });
  // Wired by hand rather than through `server.start()`: that would spin up the
  // server's own wall-clock loop, and this view already drives the tick from its
  // animation frame. Registering the handler is the half we want.
  transport.onConnection((channel) => server.accept(channel));
  // The ambient spawner runs per *active chunk*, and a player's interest window
  // is 49 of them -- at the default rate the field is fifty deep inside half a
  // minute and there is nothing to read in any direction. This is the tab
  // choosing how busy its own single-player server is, the way it chooses the
  // seed; the rule it turns down lives on the server and is unchanged.
  server.liveConfig.set('spawnRateMultiplier', 0.12);

  const client = new GameClient(transport.connect(), {
    playerId: 'you',
    displayName: 'You',
    // Predict against the world the server is colliding against (spec 063), so
    // a tree stops the local guess where it stops the authoritative one.
    predictor: (stats, tickRate) =>
      createWorldPredictor({
        world: world.colliders,
        terrain: world.sampler,
        radius: SERVER_PLAYER_RADIUS,
        speed: stats.moveSpeed,
        tickRate,
      }),
  });

  const scene = new WorldScene(canvas, world);
  const hud = createHud();
  hud.onUse((abilityId) => useAbility(abilityId));

  // The camera/light cog floats over the top-right corner of the game window.
  const cog = document.createElement('div');
  cog.style.cssText = 'position:absolute;top:8px;right:10px;z-index:30;';
  cog.append(scene.controls.element);
  root.append(hud.element, cog);

  client.onCombatResult((result) => {
    hud.addDamage(result.targetId, result.damage, (result.flags & 2) !== 0);
  });
  client.onEffect((effect) => {
    scene.addEffect(effect.x, effect.y, effect.radius, effect.durationTicks);
  });
  client.onCastRejected((abilityId, reason) => {
    hud.notice(`${abilityById(abilityId)?.name ?? abilityId}: ${reason}`);
  });

  // --- input -------------------------------------------------------------
  const held = new Set<string>();
  let cursor: { x: number; y: number } | null = null;
  let aim = { x: 0, y: 0 };

  function selfPosition(): { x: number; y: number } {
    return client.view().self ?? { x: 0, y: 0 };
  }

  /** Where the cursor is pointing on the ground, or straight ahead if it is off. */
  function worldAim(): { x: number; y: number } {
    if (!cursor) return aim;
    aim = scene.screenToWorld(cursor.x, cursor.y);
    return aim;
  }

  function useAbility(abilityId: string): void {
    const target = worldAim();
    client.useAbility(abilityId, target.x, target.y);
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    held.add(event.code);
    const slot = HOTBAR[Number(event.key) - 1];
    if (slot) {
      useAbility(slot);
      event.preventDefault();
    }
    if (event.code === 'Escape') client.cancelCast();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    held.delete(event.code);
  };
  const onMove = (event: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const onLeave = (): void => {
    cursor = null;
  };
  const onMouseDown = (event: MouseEvent): void => {
    const first = HOTBAR[0];
    if (event.button === 0 && first) useAbility(first);
    if (event.button === 2) client.cancelCast();
  };
  const onContextMenu = (event: Event): void => event.preventDefault();
  const onBlur = (): void => held.clear();

  // --- the loop ----------------------------------------------------------
  let raf = 0;
  let last = 0;
  let accumulator = 0;
  /** Ms since the last delta landed, for the interpolation alpha. */
  let sinceDelta = 0;
  let lastDeltaTick = 0;

  function sendInput(): void {
    const me = selfPosition();
    const intent = moveIntent(held, me, worldAim());
    client.sendInput({ ...intent, buttons: 0 });
  }

  function frame(now: number): void {
    const elapsed = last === 0 ? TICK_MS : now - last;
    last = now;
    accumulator = Math.min(accumulator + elapsed, TICK_MS * MAX_CATCH_UP_TICKS);
    sinceDelta += elapsed;

    while (accumulator >= TICK_MS) {
      accumulator -= TICK_MS;
      // The in-tab server advances on the same fixed step it would over a wire;
      // this view just happens to be the thing driving its clock.
      server.tick();
      sendInput();
    }

    const view = client.view();
    // A new delta resets the interpolation window. Measuring it from the delta's
    // own tick rather than from a wall-clock guess keeps the alpha honest when
    // frames are dropped.
    if (view.tick !== lastDeltaTick) {
      lastDeltaTick = view.tick;
      sinceDelta = 0;
    }
    const alpha = Math.min(1, sinceDelta / DELTA_MS);
    // The clock the bodies move on, so a cast bar fills in step with the figure
    // casting it rather than in 20Hz jumps beside it.
    const drawnTick = view.tick + alpha * BROADCAST_EVERY_N_TICKS;

    scene.render(view, { dt: elapsed / 1000, alpha, tick: drawnTick });
    hud.update(view, scene.screenAnchors(), drawnTick, client.correctionCount);

    raf = requestAnimationFrame(frame);
  }

  container.append(root);

  return {
    element: root,
    start(): void {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
      canvas.addEventListener('mousemove', onMove);
      canvas.addEventListener('mouseleave', onLeave);
      canvas.addEventListener('mousedown', onMouseDown);
      document.documentElement.addEventListener('contextmenu', onContextMenu);

      // Something to fight, so the first frame is not an empty field.
      void client.connect().then(() => {
        const me = selfPosition();
        server.spawnEntities('grazer', me.x + 220, me.y - 60, 3);
        server.spawnEntities('stalker', me.x - 260, me.y + 120, 2);
      });

      last = 0;
      accumulator = 0;
      raf = requestAnimationFrame(frame);
    },
    stop(): void {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('mousedown', onMouseDown);
      document.documentElement.removeEventListener('contextmenu', onContextMenu);
      held.clear();
    },
  };
}
