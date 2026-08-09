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
import { facesAim } from '../../../server/sim/abilities.js';
import { createHud, HOTBAR } from './hud.js';
import { appearanceOf } from './appearance.js';
import { moveIntent, MOVE_KEYS, RoutePlanner } from './intent.js';
import { autoAttack } from './target.js';
import { aimShape, castOrder, startAim, type AimGesture, type AimOrder } from './aim.js';
import { TouchGestures, type TouchSample } from './touch.js';
import { DEFAULT_HEADROOM, WorldScene, type AimIndicator } from './scene.js';
import { spawnerLabels } from './spawner-overlay.js';
import type { WorldAnchor } from './damage-popup.js';

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

  const hud = createHud((x, y, lift) => scene.projectPoint(x, y, lift));
  /** The overlay's current box, so it is only rewritten when the letterbox moves. */
  let hudBox = { x: -1, y: -1, width: -1, height: -1 };
  hud.onUse((abilityId) => pressAbility(abilityId));
  // Picking a weapon is an ordinary equip (spec 079): the server puts it in the
  // hand, recomputes the stat block, and the new `basicAttackId` comes back on
  // `Stats`. Nothing here decides what the right-click then does -- the next
  // frame simply reads the stat and asks for whatever it names.
  hud.onEquip((itemId) => client.equip('mainHand', itemId));

  // The settings buttons float over the top-right corner of the game window: the
  // view cog (spec 034), the day/night clock, the player's lights, the retro
  // filter and the hike look (spec 107), then the weather (spec 075). A popover
  // each rather than one drawer for all of them -- and one group, so opening any
  // of them closes the rest instead of stacking six panels into one corner.
  const weather = createWeatherControls({ group: scene.controls.menus });
  const buttons = document.createElement('div');
  // Inset against the notch and the home indicator (spec 093): in landscape the
  // cutout is on a side edge, which is exactly where these sit.
  buttons.style.cssText =
    'position:absolute;top:calc(8px + env(safe-area-inset-top));right:calc(10px + env(safe-area-inset-right));' +
    'z-index:30;display:flex;gap:6px;';
  buttons.append(scene.controls.element, weather.element);
  root.append(hud.element, buttons);

  client.onCombatResult((result) => {
    // Where it landed, asked for now and never again (spec 096). The scene is
    // the better answer -- it knows the pose actually on screen, and it still
    // holds the body of something this very blow killed -- and the replica is
    // the fallback for a hit on a body no frame has drawn yet.
    const at = scene.bodyAnchor(result.targetId) ?? replicaAnchor(result.targetId);
    if (!at) return;
    hud.addDamage(result.targetId, at, result.damage, (result.flags & 2) !== 0);
  });
  client.onEffect((effect) => {
    scene.addEffect(effect.x, effect.y, effect.radius, effect.durationTicks);
  });
  client.onCastRejected((abilityId, reason) => {
    hud.notice(`${abilityById(abilityId)?.name ?? abilityId}: ${reason}`);
  });

  /** The world point of a body the scene has not drawn, out of the last delta. */
  function replicaAnchor(entityId: number): WorldAnchor | null {
    const entity = client.view().entities.find((candidate) => candidate.id === entityId);
    return entity ? { x: entity.x, y: entity.y, lift: DEFAULT_HEADROOM } : null;
  }

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
   * The skill being aimed but not yet thrown (spec 080).
   *
   * A hotbar press stops being the commitment and becomes this: the shape of
   * the blow is on the ground, and nothing has been asked for. A left-click
   * turns it into an {@link order}; a right-click throws it away, at no cost,
   * because there was nothing to refund.
   */
  let pendingAim: { readonly abilityId: string; readonly gesture: AimGesture } | null = null;
  /**
   * A confirmed aim, walking into range (spec 080). One cast, not a cadence:
   * the tick it is asked for is the tick it is forgotten.
   */
  let order: AimOrder | null = null;
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

  /**
   * A hotbar slot was reached for (spec 080).
   *
   * What that means now depends on what the ability asks for. A self cast has
   * nothing to supply, so it is still the commitment it always was. Everything
   * else becomes an aim: a picture on the ground and a question, until a click
   * answers it.
   */
  function pressAbility(abilityId: string): void {
    const ability = abilityById(abilityId);
    if (!ability) return;

    const view = client.view();
    const start = startAim(ability, {
      readyAtTick: view.cooldowns[abilityId] ?? 0,
      tick: view.estimatedTick,
    });

    if (start.kind === 'refused') {
      // Said out loud in the same line the server's refusals use, so a dead
      // press is never silent. Nothing else moves: a key that does nothing does
      // nothing, so a standing aim is left exactly as it was.
      hud.notice(`${ability.name}: ${start.reason}`);
      return;
    }
    if (start.kind === 'cast') {
      castNow(abilityId, worldAim(), 0);
      return;
    }
    // A second press replaces the first rather than queueing behind it. There
    // is one aim, and it is whichever one you reached for last.
    pendingAim = { abilityId, gesture: start.gesture };
  }

  /** Commit: send the request, and give up everything that would fight it. */
  function castNow(abilityId: string, at: { x: number; y: number }, targetEntityId: number): void {
    // Committing to a blow cancels where you were going. The server roots a
    // caster anyway, so a standing order would simply resume the moment the cast
    // ended -- walking off mid-fight, seconds after the click that ordered it,
    // with nothing on screen to explain why.
    destination = null;
    planner.clear();
    // ...and it calls off the auto-attack, for the same reason held keys
    // outrank a move order: reaching for a hotbar slot is taking control back.
    targetId = null;
    client.useAbility(abilityId, at.x, at.y, targetEntityId);
  }

  /**
   * The left-click that answers the aim's question.
   *
   * A ground aim takes the point under the cursor. A unit aim takes the body
   * under it -- and a click on empty grass is *ignored* rather than treated as
   * a cancel: it asked for a body, so a click that found none has not answered
   * anything, and throwing the aim away would punish a near miss.
   */
  function confirmAim(): void {
    const pending = pendingAim;
    if (!pending) return;
    const ability = abilityById(pending.abilityId);
    if (!ability) return;

    let targetEntityId = 0;
    let at = worldAim();
    if (pending.gesture === 'unit') {
      const hovered = cursor ? scene.pickUnitAt(cursor.x, cursor.y) : null;
      const picked = hovered === null ? null : client.view().entities.find((e) => e.id === hovered);
      if (!picked || !attackable(picked, client.view().selfEntityId)) return;
      targetEntityId = picked.id;
      at = { x: picked.x, y: picked.y };
    }

    pendingAim = null;
    // The order owns the walking from here, so nothing else may be steering.
    destination = null;
    planner.clear();
    targetId = null;
    order = { abilityId: ability.id, targetEntityId, x: at.x, y: at.y, range: ability.range };
  }

  /** Throw the aim away. Nothing was asked for, so there is nothing to refund. */
  function clearAim(): void {
    pendingAim = null;
    order = null;
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
      pressAbility(slot);
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
      clearAim();
    }
    // Any manual step also drops a standing order, for the same reason held
    // keys outrank one in `moveIntent`: taking the keys is taking control.
    //
    // A *pending* aim survives it. Walking while you decide where to put a
    // blast is the point of being allowed to decide; a confirmed order does not
    // survive, because from then on it is steering and a held key already
    // outranks a destination in `moveIntent`.
    if (MOVE_KEYS[event.code]) {
      destination = null;
      planner.clear();
      targetId = null;
      order = null;
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

    // Left-click confirms an aim, and does nothing at all without one
    // (spec 080). It used to fire the first hotbar slot at the cursor, which is
    // a click race rather than a decision.
    if (event.button === 0) {
      confirmAim();
      return;
    }

    // One button does both, and which one it does is decided by what is under
    // it (spec 070).
    if (event.button !== 2) return;

    // Right-click over a pending aim means *no*, and only that: no move order,
    // no attack order, nothing under the cursor acted on. The button that calls
    // a blow off cannot also mean "and go there instead" -- and it is the only
    // reading under which changing your mind is genuinely free.
    if (pendingAim) {
      pendingAim = null;
      return;
    }
    issueOrder();
  };

  /**
   * The order itself: attack the body under the cursor, or walk to the ground
   * under it (spec 070).
   *
   * Its own function because a tap reaches it too (spec 093), and a second copy
   * of "which of these two things did you mean" is exactly the copy that drifts.
   * The caller has already placed `cursor` and dealt with any pending aim.
   */
  function issueOrder(): void {
    if (!cursor) return;
    // A confirmed order is already walking, so a new order is an ordinary
    // change of orders and replaces it, the way a new move order replaces an
    // attack target.
    order = null;

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
    // And it withdraws from a blow, explicitly, rather than by implication
    // (spec 090). Spec 079's rule is that *asking to move* withdraws, and the
    // server reads that off the input's move vector -- but `moveIntent` yields
    // no vector at all for a destination inside `ARRIVE_EPS`, and while rooted
    // it asks for the heading of the *aim* rather than of the click. So an order
    // to step aside could turn the body into its own swing and then land it.
    // Whether an order happens to produce a vector this tick is not something a
    // player can see; the order is the thing they gave.
    client.cancelCast();
  }

  // --- touch (spec 093) --------------------------------------------------
  //
  // One gesture has to carry both mouse buttons, so a tap is answered by
  // whatever is being asked rather than meaning one fixed thing.
  const gestures = new TouchGestures();

  /**
   * A tap: the order, or the answer to an aim, depending on what is pending.
   *
   * The one place touch and mouse deliberately disagree is the last branch. A
   * mouse *ignores* a unit-aim click that missed, because the other button is
   * right there to back out with and throwing the aim away would punish a near
   * miss (spec 080). On touch there is no other button, so ignoring it would
   * leave a unit-gesture aim with no way out. Tapping the thing the aim asked
   * for confirms; tapping anywhere else means no.
   */
  function onTap(x: number, y: number): void {
    cursor = { x, y };
    if (pendingAim) {
      const gesture = pendingAim.gesture;
      // Answers it, or -- for a unit aim that found only grass -- leaves it
      // pending, which is how we can tell the tap answered nothing.
      confirmAim();
      if (gesture === 'unit' && pendingAim) pendingAim = null;
      return;
    }
    issueOrder();
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') {
      onMouseDown(event);
      return;
    }
    // Keeps the browser's own tap behaviours -- double-tap zoom, selection, the
    // compatibility mouse events that would reach nothing anyway -- off a canvas
    // that has its own reading of the gesture.
    event.preventDefault();
    gestures.down(sampleOf(event));
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') {
      onMove(event);
      return;
    }
    const gesture = gestures.move(sampleOf(event));
    // The pinch is the only thing a touch drag does. Deliberately not a camera
    // pan: the camera follows the player (spec 039), and a view that could be
    // dragged off them would need a way back that this spec does not add.
    if (gesture?.kind === 'pinch') scene.controls.pinchZoom(gesture.ratio);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    const gesture = gestures.up(sampleOf(event));
    if (gesture?.kind === 'tap') onTap(gesture.x, gesture.y);
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') gestures.cancel(event.pointerId);
  };

  /** A pointer event as the recogniser's plain, canvas-relative sample. */
  function sampleOf(event: PointerEvent): TouchSample {
    const rect = canvas.getBoundingClientRect();
    return { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  const onContextMenu = (event: Event): void => event.preventDefault();
  const onBlur = (): void => {
    held.clear();
    // A gesture interrupted by losing focus never sends its pointerup, and the
    // next finger down would otherwise land mid-pinch.
    gestures.clear();
  };

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
  /**
   * Where the standing attack order's mark is, or null (spec 090).
   *
   * The body faces this while waiting for the swing to come off cooldown, so the
   * turn happens during the wait rather than after it. Read off the replica each
   * tick rather than remembered, because a mark that walks takes its bearing
   * with it.
   */
  function aimedMark(view: ReturnType<typeof client.view>): { x: number; y: number } | null {
    if (targetId === null) return null;
    const entity = view.entities.find((candidate) => candidate.id === targetId);
    return entity ? { x: entity.x, y: entity.y } : null;
  }

  function driveAutoAttack(view: ReturnType<typeof client.view>, me: { x: number; y: number }): void {
    if (targetId === null) return;
    const entity = view.entities.find((candidate) => candidate.id === targetId);
    // What this character attacks with is a stat now (spec 079), so the reach a
    // chase stops at, the cooldown the sweep is drawn from and the ability that
    // is asked for are all one answer: a bow reaches further than a sword
    // without a line here knowing which is being held.
    const swingId = view.stats?.basicAttackId || BASIC_ATTACK_ID;
    const swing = abilityById(swingId);
    // The reach the chase stops at and the reach the *server* will judge the
    // commit against are one number, so it is read once here and handed to both
    // (spec 080). It used to be read here and left out of the request, which
    // made the client's own gate stricter than the server's by exactly a body.
    const targetRadius = entity ? appearanceOf(entity).radius : 0;
    const replica = view.entities.find((e) => e.id === view.selfEntityId);
    const decision = autoAttack({
      self: me,
      selfHealth: replica?.health ?? 1,
      target: entity
        ? { id: entity.id, x: entity.x, y: entity.y, radius: targetRadius, health: entity.health }
        : null,
      range: swing?.range ?? 0,
      // Both halves of "am I committed": the server's cast and the one this
      // client has only asked for. `selfRoot` is already the union of the two.
      rooted: view.selfRoot !== null,
      // ...and the third: a request that has been sent and not yet ruled on,
      // which has no cast behind it and so shows up in neither of those.
      pending: view.awaitingCast,
      readyAtTick: view.cooldowns[swingId] ?? 0,
      // Judged on the heading the *player is looking at* -- the local one, the
      // one the body is drawn with -- so that "off cooldown and fully turned"
      // means the wind-up starts now (spec 090). Judging it off the replica
      // instead was correct about the server and a fifth of a second late,
      // which reads as the wind-up being delayed after the turn has visibly
      // finished. What makes asking here safe is the other end of the same fix:
      // `startCast` counts a body within a few ticks of turning as facing its
      // aim, so the server -- which is those few ticks behind -- agrees.
      aligned: !entity ? true : facesAim(me, facing, { x: entity.x, y: entity.y }),
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
    if (decision.attack) client.useAbility(swingId, entity.x, entity.y, entity.id, targetRadius);
  }

  /**
   * One tick of a confirmed aim (spec 080): close the gap, then throw it.
   *
   * The same shape as `driveAutoAttack` above and deliberately so -- both feed
   * `moveIntent` an ordinary destination and ask the server for an ability, and
   * the server validates them identically. The one difference is the ending: an
   * attack order stands until the body is down, and this is a single blow.
   */
  function driveCastOrder(view: ReturnType<typeof client.view>, me: { x: number; y: number }): void {
    const standing = order;
    if (!standing) return;

    const mark =
      standing.targetEntityId === 0
        ? undefined
        : view.entities.find((entity) => entity.id === standing.targetEntityId);
    const decision = castOrder({
      self: me,
      order: standing,
      target: mark
        ? {
            id: mark.id,
            x: mark.x,
            y: mark.y,
            radius: appearanceOf(mark).radius,
            health: mark.health,
          }
        : null,
      // Both halves of "am I committed": the server's cast and the one this
      // client has only asked for.
      rooted: view.selfRoot !== null,
      readyAtTick: view.cooldowns[standing.abilityId] ?? 0,
      tick: view.estimatedTick,
    });

    // Re-pointed every tick, because a named mark moves. The planner treats it
    // as any other destination, so an approach round a tree is routed by the
    // same A* a right-click on the ground is.
    destination = decision.chaseTo;
    if (!decision.chaseTo) planner.clear();
    if (decision.cast) {
      client.useAbility(
        decision.cast.abilityId,
        decision.cast.x,
        decision.cast.y,
        decision.cast.targetEntityId,
      );
    }
    if (decision.drop) {
      order = null;
      destination = null;
      planner.clear();
    }
  }

  /**
   * What the aim looks like this frame, or null. Presentation assembled from
   * the decision `aim.ts` already made -- no branch here changes an outcome.
   */
  function aimIndicator(
    view: ReturnType<typeof client.view>,
    me: { x: number; y: number },
  ): AimIndicator | null {
    const abilityId = pendingAim?.abilityId ?? order?.abilityId ?? null;
    if (abilityId === null) return null;
    const ability = abilityById(abilityId);
    if (!ability) return null;

    // Where it is pointed: the cursor while the aim is still a question, the
    // placement once it has been answered.
    let point = worldAim();
    let unitId: number | null = null;
    let markRadius = 0;

    if (order) {
      const mark =
        order.targetEntityId === 0
          ? undefined
          : view.entities.find((entity) => entity.id === order?.targetEntityId);
      point = mark ? { x: mark.x, y: mark.y } : { x: order.x, y: order.y };
      unitId = mark ? mark.id : null;
      markRadius = mark ? appearanceOf(mark).radius : 0;
    } else if (pendingAim?.gesture === 'unit') {
      const hovered = cursor ? scene.pickUnitAt(cursor.x, cursor.y) : null;
      const picked = hovered === null ? null : view.entities.find((entity) => entity.id === hovered);
      if (picked && attackable(picked, view.selfEntityId)) {
        unitId = picked.id;
        point = { x: picked.x, y: picked.y };
        markRadius = appearanceOf(picked).radius;
      }
    }

    return {
      shape: aimShape(ability),
      origin: me,
      point,
      unitId,
      range: ability.range,
      // Measured to the body's edge when there is one, the same as the gate the
      // server will apply to the cast this becomes.
      inRange: Math.hypot(point.x - me.x, point.y - me.y) <= ability.range + markRadius,
    };
  }

  function sendInput(): void {
    const view = client.view();
    const me = selfPosition();
    driveCastOrder(view, me);
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
      // Face the mark while the swing is still on cooldown (spec 090). Without
      // it the body stood facing wherever it happened to be looking for up to a
      // whole attack delay, and only turned once the blow committed -- so the
      // turn was paid for *after* the wait instead of during it.
      targetAim: aimedMark(view),
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
      destination: targetId === null && order === null ? destination : null,
      cursor,
      targetEntityId: targetId,
      aim: aimIndicator(view, view.self ?? { x: 0, y: 0 }),
    });
    // The overlay is laid over the *drawn image*, not over the window (spec 099).
    // Every anchor it positions from is in canvas space, so under a letterbox an
    // overlay spanning the whole view would sit the health bars off their bodies
    // by the size of the bars -- and the hotbar would hang in the letterbox
    // rather than over the picture. Written only when it moves; a per-frame style
    // write is a per-frame layout.
    const box = scene.viewport();
    if (box.x !== hudBox.x || box.y !== hudBox.y || box.width !== hudBox.width || box.height !== hudBox.height) {
      hudBox = box;
      const style = hud.element.style;
      style.inset = '';
      style.left = `${box.x}px`;
      style.top = `${box.y}px`;
      style.width = `${box.width}px`;
      style.height = `${box.height}px`;
    }

    hud.update(view, scene.screenAnchors(), drawnTick, client.correctionCount, targetId, {
      abilityId: pendingAim?.abilityId ?? order?.abilityId ?? null,
      pending: pendingAim !== null,
    });

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
      // Pointer events rather than mouse events, so a tap is read once: the
      // compatibility `mousedown` a touch also fires would arrive as button 0
      // and confirm an aim nobody asked about (spec 093).
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerCancel);
      canvas.addEventListener('mouseleave', onLeave);
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
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('mouseleave', onLeave);
      document.documentElement.removeEventListener('contextmenu', onContextMenu);
      held.clear();
      // A tab switched away mid-pinch must not leave fingers down.
      gestures.clear();
    },
  };
}
