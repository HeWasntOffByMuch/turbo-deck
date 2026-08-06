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
import { buildWorldFromMap } from '../../../server/world/build.js';
import {
  BROADCAST_EVERY_N_TICKS,
  SERVER_PLAYER_RADIUS,
  SERVER_TICK_RATE,
} from '../../../server/config.js';
import { abilityById, BASIC_ATTACK_ID } from '../../../server/data/abilities.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { viewSeed } from '../seed.js';
import mapText from '../../../../maps/arena.json?raw';
import { parseMap } from '../../../terrain/map.js';
import { StreamedMap } from '../../../server/client/streamed-map.js';
import type { ViewHandle } from '../view-handle.js';
import { createWeatherControls } from '../weather-controls.js';
import { turnToward } from '../../../server/sim/movement.js';
import { createHud, HOTBAR } from './hud.js';
import { appearanceOf } from './appearance.js';
import { moveIntent, MOVE_KEYS, RoutePlanner } from './intent.js';
import { autoAttack } from './target.js';
import { WorldScene } from './scene.js';
import { spawnerLabels } from './spawner-overlay.js';

const TICK_MS = 1000 / SERVER_TICK_RATE;

/**
 * Frames of quiet before the prop field is rebuilt (spec 072 follow-up).
 *
 * Small: the point is only to coalesce a burst of arrivals into one rebuild,
 * not to defer the trees until the player notices they are missing. Two frames
 * of nothing arriving is enough to know a burst has ended, and at the tail of a
 * cold start the whole field appears within ~30ms of the last chunk.
 */
const PROP_SETTLE_FRAMES = 2;
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
  //
  // The world is the **map document** now (spec 072), not `buildWorld(seed)`.
  // The seed still picks the fight's randomness; it stopped describing the
  // ground the moment the ground became a file somebody could edit by hand.
  const seed = viewSeed();
  const world = buildWorldFromMap(parseMap(mapText), mapText);

  const transport = new LoopbackTransport();
  const server = new GameServer({ seed, built: world, transport });
  // Wired by hand rather than through `server.start()`: that would spin up the
  // server's own wall-clock loop, and this view already drives the tick from its
  // animation frame. Registering the handler is the half we want.
  transport.onConnection((channel) => server.accept(channel));
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
  const planner = new RoutePlanner();

  // The scene draws the map the *client* was sent, not the document the in-tab
  // server happens to be holding (spec 072). Starting empty and filling in from
  // chunks is the only way this path is genuinely exercised: handed `world` it
  // would look right while streaming did nothing.
  //
  // `streamed` is created on the first MapInfo and lives for the session. It is
  // never rebuilt -- see streamed-map.ts for why rebuilding it per arrival cost
  // ten seconds of frozen page.
  const scene = new WorldScene(canvas);
  let streamed: StreamedMap | null = null;
  /** Props lag the terrain; this is whether they owe a rebuild, and for how long. */
  let propsDirty = false;
  let settledFrames = 0;

  /**
   * Take whatever landed since the last frame.
   *
   * Only chunks the streamed map has not already seen are meshed, so a frame
   * costs the number of chunks that *arrived* in it rather than the number
   * held. That is the whole difference between a cold start that streams in and
   * one that blocks the main thread for its entire duration.
   */
  function ingestChunks(view: ReturnType<typeof client.view>): void {
    const map = view.map;
    if (!map) return;

    if (!streamed) {
      streamed = new StreamedMap(map.info);
      scene.setMap(streamed);
    }

    let arrived = 0;
    for (const held of map.chunks) {
      // One arrival, but up to five chunks to draw: a neighbour's mesh was baked
      // against ground this chunk has only now supplied (spec 078).
      const dirty = streamed.add(held);
      if (dirty.length === 0) continue;
      for (const chunk of dirty) scene.addTerrainChunk(chunk);
      arrived++;
    }

    // Props wait for the stream to go quiet rather than rebuilding per chunk.
    // One instanced mesh per species over the whole map is a few draw calls;
    // one per chunk would be fifty-odd of them on every frame from then on, so
    // per-chunk props would trade a startup cost for a permanent one.
    if (arrived > 0) {
      propsDirty = true;
      settledFrames = 0;
    } else if (propsDirty && ++settledFrames >= PROP_SETTLE_FRAMES) {
      propsDirty = false;
      scene.refreshProps();
      // The world is now drawn: terrain meshed and props standing on it.
      //
      // Announced because streaming took that fact away from anyone watching
      // from outside. It used to be implied -- the world was built before the
      // first frame, so any frame at all meant a finished world, and
      // `preview-world.ts` waited on the HUD's tick counter accordingly. Now
      // ticks advance while chunks are still arriving, and a harness that
      // clicked at tick 150 was clicking into a half-drawn field.
      root.dataset['worldReady'] = 'true';
    }
  }

  const hud = createHud();
  hud.onUse((abilityId) => useAbility(abilityId));
  // Picking a weapon is an ordinary equip (spec 079): the server puts it in the
  // hand, recomputes the stat block, and the new `basicAttackId` comes back on
  // `Stats`. Nothing here decides what the right-click then does -- the next
  // frame simply reads the stat and asks for whatever it names.
  hud.onEquip((itemId) => client.equip('mainHand', itemId));

  // The two settings buttons float over the top-right corner of the game
  // window: the camera/light cog (spec 034) and the weather beside it
  // (spec 075). Separate popovers rather than one -- the cog's is already
  // twenty rows deep and scrolls on a short window, and what the world is doing
  // is a different question from how it is being looked at.
  const weather = createWeatherControls();
  const buttons = document.createElement('div');
  buttons.style.cssText = 'position:absolute;top:8px;right:10px;z-index:30;display:flex;gap:6px;';
  buttons.append(weather.element, scene.controls.element);
  root.append(hud.element, buttons);

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
   * The body being attacked, or null (spec 070). The only thing this view holds
   * about a fight: what to walk toward, what to ask to hit, and what to ring.
   * Everything that follows from it -- range, cooldown, whether the blow lands
   * -- belongs to the server.
   */
  let targetId: number | null = null;
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
    // Committing to a blow cancels where you were going. The server roots a
    // caster anyway, so a standing order would simply resume the moment the cast
    // ended -- walking off mid-fight, seconds after the click that ordered it,
    // with nothing on screen to explain why.
    destination = null;
    planner.clear();
    // ...and it calls off the auto-attack, for the same reason held keys
    // outrank a move order: reaching for a hotbar slot is taking control back.
    targetId = null;
    client.useAbility(abilityId, target.x, target.y);
  }

  /**
   * Whether a right-click on this body should attack it rather than walk to it.
   *
   * Deliberately thin, and deliberately not a rule: it keeps the cursor from
   * ordering an attack on yourself, on a corpse or on a bolt in flight. Whether
   * the blow is *allowed* -- hostility, range, the zone's pvp flag -- is the
   * server's to answer, and it answers it on every swing.
   */
  function attackable(entity: { id: number; kind: number; health: number }, selfId: number): boolean {
    if (entity.id === selfId) return false;
    if (entity.health <= 0) return false;
    return entity.kind === EntityKind.Monster || entity.kind === EntityKind.Player;
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
    if (event.code === 'Escape') {
      client.cancelCast();
      // Withdrawing from a blow that the auto-attack would re-commit to on the
      // next tick is not withdrawing from anything.
      targetId = null;
    }
    // Any manual step also drops a standing order, for the same reason held
    // keys outrank one in `moveIntent`: taking the keys is taking control.
    if (MOVE_KEYS[event.code]) {
      destination = null;
      planner.clear();
      targetId = null;
    }
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

    // One button does both, and which one it does is decided by what is under
    // it (spec 070). Left-click is bound to nothing: it used to fire the first
    // hotbar slot at the cursor, which is a click race rather than a decision,
    // and it could not tell you what you were fighting.
    if (event.button !== 2) return;

    const hovered = scene.pickUnitAt(cursor.x, cursor.y);
    const picked = hovered === null ? null : client.view().entities.find((e) => e.id === hovered);
    if (picked && attackable(picked, client.view().selfEntityId)) {
      targetId = picked.id;
      // The chase is the auto-attack's to set, tick by tick, as the target
      // moves; a standing order left over from a previous click would fight it.
      destination = null;
      planner.clear();
      return;
    }

    // Empty ground: an ordinary move order, and the target is let go. Walking
    // somewhere is how you stop attacking, which is the whole reason it is the
    // same button.
    targetId = null;
    destination = scene.screenToWorld(cursor.x, cursor.y);
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
  /** Whether the opening facing has been taken from the first delta. */
  let seeded = false;
  /** Whether the spawner readout has been asked for (spec 076). */
  let watchingSpawners = false;

  /**
   * Face the way the server says we are facing, once.
   *
   * This used to also place a handful of monsters by hand, which was the tab
   * reaching past the sim to put content in the world. Since spec 076 the map
   * document does that, so all that is left is the one thing that genuinely
   * has to wait for the first delta: the welcome says which entity we are, but
   * the *position and facing* arrive with the delta after it.
   */
  function seedTheField(view: ReturnType<typeof client.view>): void {
    if (seeded || !view.self) return;
    seeded = true;
    facing = view.entities.find((entity) => entity.id === view.selfEntityId)?.facing ?? 0;
  }

  /**
   * One tick of the standing attack order (spec 070): close the gap, then swing
   * again and again until the body is down.
   *
   * The order is dropped by anything that takes manual control -- a key, a move
   * order, a cancel -- because those are all the player saying they would like
   * to be doing something else.
   */
  function driveAutoAttack(view: ReturnType<typeof client.view>, me: { x: number; y: number }): void {
    if (targetId === null) return;
    const entity = view.entities.find((candidate) => candidate.id === targetId);
    // What this character attacks with is a stat now (spec 079), so the reach a
    // chase stops at, the cooldown the sweep is drawn from and the ability that
    // is asked for are all one answer: a bow reaches further than a sword
    // without a line here knowing which is being held.
    const swingId = view.stats?.basicAttackId || BASIC_ATTACK_ID;
    const swing = abilityById(swingId);
    const decision = autoAttack({
      self: me,
      target: entity
        ? {
            id: entity.id,
            x: entity.x,
            y: entity.y,
            radius: appearanceOf(entity).radius,
            health: entity.health,
          }
        : null,
      range: swing?.range ?? 0,
      // Both halves of "am I committed": the server's cast and the one this
      // client has only asked for. `selfRoot` is already the union of the two.
      rooted: view.selfRoot !== null,
      readyAtTick: view.cooldowns[swingId] ?? 0,
      tick: view.estimatedTick,
    });

    // A target that despawned entirely is as gone as one that died: either way
    // there is nothing left to walk to.
    if (decision.drop || !entity) {
      targetId = null;
      destination = null;
      planner.clear();
      return;
    }

    // The chase is re-pointed every tick because the target moves. `moveIntent`
    // and the planner treat it as any other destination, so a chase round a
    // tree is routed by the same A* a right-click on the ground is.
    destination = decision.chaseTo;
    if (!decision.chaseTo) planner.clear();
    if (decision.attack) client.useAbility(swingId, entity.x, entity.y, entity.id);
  }

  function sendInput(): void {
    const view = client.view();
    const me = selfPosition();
    driveAutoAttack(view, me);
    const intent = moveIntent({
      held,
      self: me,
      destination,
      // Routed once and remembered, not re-searched every tick: an A* at 60Hz
      // for as long as an order stands is what the first cut did.
      route: planner.next(me, destination, pathWorld, view.estimatedTick),
      facing,
      // What roots us and what we are turning into, from the client session
      // rather than from the button that was pressed. It covers both a cast the
      // server has confirmed and one we have only asked for (spec 067) -- and it
      // can end without us asking, because being hit interrupts one.
      castAim: view.selfRoot,
    });
    if (intent.arrived) {
      destination = null;
      planner.clear();
    }

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
    ingestChunks(view);
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
      // A chase re-points its destination every tick as the target moves, so
      // marking it would strobe a diamond along the ground for the whole run.
      // The ring under the target is the marker while one is being attacked.
      destination: targetId === null ? destination : null,
      cursor,
      targetEntityId: targetId,
    });
    hud.update(view, scene.screenAnchors(), drawnTick, client.correctionCount, targetId);

    // The setting is the subscription (spec 076): turning it on is what asks
    // the server for the timers, and turning it off is what stops them coming.
    // Watched rather than wired to a change event because "Reset" moves the
    // checkbox too, and a subscription that survived a reset would be a leak.
    const wantSpawners = scene.controls.showSpawners();
    if (wantSpawners !== watchingSpawners) {
      watchingSpawners = wantSpawners;
      client.watchSpawners(wantSpawners);
    }
    hud.showSpawners(
      wantSpawners
        ? spawnerLabels(view.spawners, SERVER_TICK_RATE).map((label) => ({
            ...label,
            ...scene.projectPoint(label.x, label.y),
          }))
        : [],
    );

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
