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
import { turnToward } from '../../../server/sim/movement.js';
import { createHud, HOTBAR } from './hud.js';
import { moveIntent, MOVE_KEYS } from './intent.js';
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
  // minute and there is nothing to read in any direction. Off entirely for now:
  // this tab places a handful of monsters by hand below, and a field you can
  // count is what makes a wind-up, a cancel or a correction observable at all.
  // The tab choosing how busy its own single-player server is, the way it
  // chooses the seed; the rule it turns down lives on the server, unchanged.
  server.liveConfig.set('spawnRateMultiplier', 0);

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

  /** The world a move order routes through -- the one the server is colliding against. */
  const pathWorld = { colliders: world.colliders, radius: SERVER_PLAYER_RADIUS };

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
  /** The standing move order from the last right-click, in world units. */
  let destination: { x: number; y: number } | null = null;
  /**
   * The heading we believe we have, turned at the server's own rate.
   *
   * Predicted for the same reason position is: facing is replicated at 20Hz, and
   * drawing our own body's heading from that puts a visible interval of lag on
   * the one turn the player is making themselves. `turnToward` is the server's
   * function, imported rather than reimplemented -- there is one turn rule.
   */
  let facing = 0;

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
    // Escape calls off a wind-up. Cancelling refunds the cost and the cooldown,
    // so what a called-off cast spends is exactly the time it took -- which is
    // why the key is worth having somewhere that is not also the move button.
    if (event.code === 'Escape') client.cancelCast();
    // Any manual step also drops a standing order, for the same reason held
    // keys outrank one in `moveIntent`: taking the keys is taking control.
    if (MOVE_KEYS[event.code]) destination = null;
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
    const rect = canvas.getBoundingClientRect();
    cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };

    // Left click swings; right click walks. The MOBA split the game had before
    // the server existed, and the one the wind-up design was written against:
    // you commit to a blow with one hand and reposition with the other.
    const melee = HOTBAR[0];
    if (event.button === 0 && melee) {
      useAbility(melee);
      return;
    }
    if (event.button === 2) {
      destination = scene.screenToWorld(cursor.x, cursor.y);
    }
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
  /** Whether the opening monsters have been placed; see {@link seedTheField}. */
  let seeded = false;

  /**
   * Put a few monsters near the player, once.
   *
   * Waits for `view.self` rather than firing when `connect()` resolves. The
   * welcome only says which entity we are; the *position* arrives with the first
   * delta, and prediction does not start until that and the stats have both
   * landed. Spawning on the welcome put every monster at the world origin --
   * several hundred units from a player who spawns mid-map, so they fell outside
   * the interest radius and the field came up empty.
   */
  function seedTheField(view: ReturnType<typeof client.view>): void {
    if (seeded || !view.self) return;
    seeded = true;
    facing = view.entities.find((entity) => entity.id === view.selfEntityId)?.facing ?? 0;
    server.spawnEntities('grazer', view.self.x + 200, view.self.y - 70, 2);
    server.spawnEntities('stalker', view.self.x - 240, view.self.y + 110, 1);
  }

  function sendInput(): void {
    const view = client.view();
    const me = selfPosition();
    // The cast the *server* says we are in, which is what roots us and what we
    // are turning into. Read from `view.casts` rather than from the button that
    // was pressed: a cast only exists once the server has confirmed it, and it
    // can end without us asking -- being hit interrupts one.
    const selfCast = view.casts.find((cast) => cast.entityId === view.selfEntityId) ?? null;
    const intent = moveIntent({
      held,
      self: me,
      destination,
      facing,
      castAim: selfCast ? { x: selfCast.targetX, y: selfCast.targetY } : null,
      world: pathWorld,
    });
    if (intent.arrived) destination = null;

    // Turn toward what was asked for at our own rate, so the drawn heading is
    // the one the server is about to arrive at rather than the one it left.
    facing = turnToward(facing, intent.facing, view.stats?.turnRate ?? 0, SERVER_TICK_RATE);
    client.sendInput({ moveX: intent.moveX, moveY: intent.moveY, facing: intent.facing, buttons: 0 });
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
      // The client keeps its own clock (spec 065's follow-up): deltas are
      // suppressed when nothing changed, so `view.tick` is not one.
      client.advanceTick();
      sendInput();
    }

    const view = client.view();
    seedTheField(view);
    // A new delta resets the interpolation window. Measuring it from the delta's
    // own tick rather than from a wall-clock guess keeps the alpha honest when
    // frames are dropped.
    if (view.tick !== lastDeltaTick) {
      lastDeltaTick = view.tick;
      sinceDelta = 0;
    }
    const alpha = Math.min(1, sinceDelta / DELTA_MS);
    // Two different clocks, and the difference matters.
    //
    // `alpha` interpolates *bodies* between the last two deltas, so it is
    // measured against `view.tick` -- authoritative samples, 20Hz apart.
    //
    // Anything with a duration -- a cast bar, a cooldown sweep -- is drawn
    // against `estimatedTick` instead, plus the fraction of a tick the
    // accumulator is holding. `view.tick` stops dead whenever the server has
    // nothing to say, and a rooted caster alone in a field says nothing at all:
    // the bar froze partway and sat there while the wind-up ran on without it.
    const drawnTick = view.estimatedTick + Math.min(1, accumulator / TICK_MS);

    scene.render(view, {
      dt: elapsed / 1000,
      alpha,
      tick: drawnTick,
      selfFacing: facing,
      destination,
    });
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

      void client.connect();

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
