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
import { LoopbackTransport } from '../../../server/net/transport-loop.js';
import { connectChannel } from '../../../server/net/transport-browser.js';
import { GameServer } from '../../../server/server.js';
import { planConnection, rememberSession } from './connection.js';
import { ReconnectingChannel } from '../../../server/net/reconnecting.js';
import { createConnectionBanner } from './connection-banner.js';
import { createGroundPredictor, emptyGround, fillGround } from './prediction-ground.js';
import { mapIdOf } from '../../../server/world/map-index.js';
import type { Channel } from '../../../server/net/transport.js';
import type { WorldColliders } from '../../../sim/types.js';
import type { TerrainSampler } from '../../../server/world/terrain.js';
import { buildWorldFromMap, ROUTING_RADII } from '../../../server/world/build.js';
import {
  invalidateNavHeights,
  pendingNavHeights,
  stepNavHeights,
  warmNavGrids,
} from '../../../sim/pathfinding.js';
import {
  BROADCAST_EVERY_N_TICKS,
  SERVER_PLAYER_RADIUS,
  SERVER_TICK_RATE,
} from '../../../server/config.js';
import { abilityById, BASIC_ATTACK_ID } from '../../../server/data/abilities.js';
import { EntityKind } from '../../../server/net/protocol.js';
import type { BaseStatKey } from '../../../server/state/types.js';
import { viewSeed } from '../seed.js';
import { DEFAULT_AUTHORED_UNITS, setAuthoredUnits, unitsFromQuery } from './unit-catalog.js';
import { ASSET_MANIFEST_HASH } from './unit-assets.js';
import mapText from '../../../../maps/arena.json?raw';
import { parseMap } from '../../../terrain/map.js';
import { StreamedMap } from '../../../server/client/streamed-map.js';
import type { HeldChunk } from '../../../server/client/map-cache.js';
import type { ViewHandle } from '../view-handle.js';
import { createWeatherControls } from '../weather-controls.js';
import { createVfxControls } from '../vfx-controls.js';
import { createWireControls } from '../wire-controls.js';
import { UnreliableChannel, type WireConditions } from '../../../server/net/unreliable.js';
import { parseWire } from '../../../server/net/wire-query.js';
import { Rng } from '../../../shared/prng.js';
import { orbitDrag, orbitStep } from './orbit-keys.js';
import { turnToward } from '../../../server/sim/movement.js';
import { facesAim } from '../../../server/sim/abilities.js';
import { createHud } from './hud.js';
import { ChunkIngest, chunkRect } from './chunk-ingest.js';
import { FrameBudget } from './frame-budget.js';
import { LoadGate } from './loading.js';
import { createLoadingOverlay } from './loading-overlay.js';
import { FrameMeter } from './fps-meter.js';
import { createFpsOverlay } from './fps-overlay.js';
import { PROP_REGION_SIZE } from '../props.js';
import { abilityForSlot, actionBarFromQuery } from './action-bar.js';
import { hudLayout } from './hud-layout.js';
import { isHandheldDevice } from '../device.js';
import { appearanceOf } from './appearance.js';
import { effectsForBlow, REDUNDANT_SERVER_EFFECTS } from './vfx-wire.js';
import { moveIntent, RoutePlanner } from './intent.js';
import { pickupLead, pickupOrderFor } from './loot-drop.js';
import { PICKUP_RANGE } from '../../../server/sim/world.js';
import { decideKeyDown, decideKeyUp } from './key-actions.js';
import { UiLayer } from './ui-layer.js';
import { nearestVendorTo } from './shop-model.js';
import { InputMap, type Modifiers } from '../../../ui/input/input-map.js';
import { loadBindings, saveBindings } from '../../../ui/input/binding-store.js';
import { loadScale, loadShowFps, saveScale, saveShowFps } from '../../../ui/input/display-store.js';
import { loadLayout, saveLayout } from '../../../ui/core/layout-store.js';
import type { Rect } from '../../../ui/core/geom.js';
import { wheelNotches } from '../../../ui/core/events.js';
import { autoAttack } from './target.js';
import { windupLostItsMarkIn } from './withdraw.js';
import { aimShape, castOrder, startAim, type AimGesture, type AimOrder } from './aim.js';
import { TouchGestures, type TouchSample } from './touch.js';
import { DEFAULT_HEADROOM, WorldScene, type AimIndicator } from './scene.js';
import { spawnerLabels } from './spawner-overlay.js';
import type { WorldAnchor } from './damage-popup.js';
import { castRefusalText } from './error-log.js';

const TICK_MS = 1000 / SERVER_TICK_RATE;

/**
 * Wall-clock quiet before the prop field is rebuilt (spec 165).
 *
 * This was two *frames* (spec 072), and that number was wrong in a way nothing
 * noticed until the map grew. Deltas arrive every 50ms and frames every ~16ms,
 * so two quiet frames is a condition that is *always* met between one delta and
 * the next: the settle fired on every pump of the stream rather than once at the
 * end of a burst, and every firing rebuilt every prop in the world.
 *
 * Measured in milliseconds and set above the broadcast interval, so a stream
 * that is still arriving cannot trip it. 120ms is a little over two deltas --
 * enough slack that one late delta does not read as the end of the load, and
 * short enough that the trees appear while the ground they stand on is still the
 * thing the player is looking at.
 */
const PROP_SETTLE_MS = 120;

/**
 * Chunks meshed per frame (spec 165).
 *
 * Meshing a chunk disposes and rebuilds its surface, wall and water geometry and
 * re-bakes its neighbours' shore quads. One arrival can dirty five chunks, and a
 * pump of arrivals used to mesh all of them between one paint and the next --
 * up to forty rebuilds in a frame, which is a visible lurch however fast the
 * stream is.
 *
 * 4 holds a frame inside its budget on the machine this was measured on while
 * still clearing a full pump in under two deltas. It is a *rate*, so raising the
 * request pass above it does not make the frame worse -- it makes the queue
 * longer, which is the trade this whole spec is about.
 */
const MESH_BUDGET_PER_FRAME = 4;

/**
 * Milliseconds of a frame the chunk stream may have (spec 165 follow-up).
 *
 * A count was not enough. `MESH_BUDGET_PER_FRAME` bounded the *meshing* and left
 * the insert that produces it unbounded -- `StreamedMap.add` rebuilds the
 * arrival's baked cells and its four edge neighbours', ~10ms each on this map,
 * and a pump of 24 arrivals ran all of them in one frame. 6ms is a little over a
 * third of a 60Hz frame, which keeps the stream moving without ever being the
 * reason one is missed.
 */
const INGEST_BUDGET_MS = 6;

/**
 * Milliseconds of a frame the nav-grid warm may have.
 *
 * Smaller than the stream's, because this one is never urgent: nothing on screen
 * waits for it, and the only thing that does -- the first predicted route -- can
 * fall back to flat prediction for a few frames without anybody seeing it.
 */
const NAV_BUDGET_MS = 5;

/**
 * The same budget while the loading screen is up.
 *
 * Much larger, because behind the gate there is no frame to protect -- nothing
 * is on screen but a bar. At 5ms a frame the arena's 797k cells would take
 * sixteen seconds of *waiting*, against 4.8s of actual work; the slicing is
 * there to keep frames smooth, and when smoothness is not the constraint it is
 * pure overhead.
 */
const LOAD_NAV_BUDGET_MS = 24;

/**
 * Cells sampled between budget checks.
 *
 * The budget is checked between slices, so a slice is how far it can overshoot.
 * 512 measured 22ms in the worst case -- `heightAt` over ground that is still
 * arriving falls into its neighbour-ring search and costs several times its
 * settled price, which is exactly when this is running. 128 keeps the worst
 * observed slice inside a frame. Checking a clock per cell would cost more than
 * the sample does.
 */
const NAV_CELLS_PER_SLICE = 128;

/**
 * Wall-clock quiet before the nav grid itself is rebuilt.
 *
 * The sampling is sliced, but the grid built from it is not -- the obstacle
 * passes and the component flood are ~110ms and there is no natural seam in
 * them. It is keyed on the colliders, which change on every prop settle, so
 * during a cold start it would be paid once per burst. Waiting for the stream to
 * genuinely stop turns that into once.
 *
 * Longer than `PROP_SETTLE_MS` on purpose: nothing on screen waits for this, so
 * it should be the last thing to happen rather than a second settle racing the
 * first.
 */
const NAV_GRID_QUIET_MS = 500;

/**
 * Chunks around the player that must arrive before the world is shown.
 *
 * Smaller than `MAP_CHUNK_REQUEST_RADIUS`, deliberately. The request radius is
 * sized so terrain never runs out at the edge of the widest zoom on the widest
 * monitor; making the player wait for all of it would be making them wait for
 * ground they cannot see. 2 covers the 616-unit chunk they stand in and the ring
 * around it -- 1848 units square, comfortably past the default zoom's frame.
 */
const READY_CHUNK_RADIUS = 2;
/** Never advance more than this many ticks in one frame, after a long pause. */
const MAX_CATCH_UP_TICKS = 10;
/**
 * Wall-clock period for the two things that must outlive the frame loop
 * (spec 157): the heartbeat, and the reconnect backoff.
 *
 * Both used to ride `requestAnimationFrame`, which a browser throttles to
 * nothing in a hidden tab -- so switching tabs for a minute stopped the pings,
 * the server's ten-second timeout dropped the connection, and the backoff that
 * would have brought it back was frozen by the same stall. A `setInterval` is
 * clamped to about a second when hidden but never stops, which is the whole
 * difference between "slower" and "never".
 *
 * 500ms is the rate the frame loop drove them at, so nothing about a visible
 * tab changes.
 */
const KEEPALIVE_MS = 500;
/** Ticks of backoff clock per keep-alive, so `ReconnectingChannel` stays tick-driven. */
const KEEPALIVE_TICKS = Math.round(KEEPALIVE_MS / TICK_MS);
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
  // Which monsters are drawn from an authored unit (spec 111). Empty unless
  // `?units=` says otherwise, so the arena looks exactly as it did.
  // The defaults first, then whatever `?units=` overrides. `setAuthoredUnits`
  // replaces the whole table by design, so passing the query alone wiped the
  // default roster on every mount -- which is exactly how the player went on
  // being drawn by the critter rig after being pointed at an authored unit.
  setAuthoredUnits({ ...DEFAULT_AUTHORED_UNITS, ...unitsFromQuery() });

  // The one branch in this file that decides what kind of game this is
  // (spec 144). No `?server` is single-player over a loopback, exactly as
  // before; `?server` connects out and constructs no server at all.
  const plan = planConnection(location.search, location, sessionStorage, () =>
    crypto.randomUUID(),
  );

  /**
   * The bundled map -- built for single-player, and for nothing else (spec 146).
   *
   * A remote client does not read this file at all now. Its ground arrives as
   * `MapInfo` plus chunks and its colliders grow with them, which is both the
   * only correct answer for a server on a map nobody bundled and the only way
   * that path is ever exercised: used whenever the two happened to agree, it
   * would be a path that only runs in the case it is broken in.
   */
  const local = plan.mode === 'loopback' ? buildWorldFromMap(parseMap(mapText), mapText) : null;
  // Same reason as the server (spec 130): sampling the ground into a nav grid is
  // around a second on a real map, and it belongs beside the rest of the page's
  // start-up rather than in the frame where the first move order is given. The
  // streaming client's equivalent is on the settle in `ingestChunks`, which is
  // the earliest moment it could possibly be done.
  //
  // NOT warmed here any more (spec 165 follow-up). `warmRouting` is one
  // `heightAt` per nav cell, and the grown map is 797k of them at ~6us -- 4.8
  // seconds of frozen tab before the loading screen it is behind has even been
  // created. `stepNavWarm` in the frame loop pays the identical cost a slice at
  // a time instead, which is what the loading screen is for.

  /**
   * What the predictor is allowed to collide against.
   *
   * Filled synchronously here on the loopback path, because the map this tab
   * built *is* the map its in-tab server is colliding against -- the same
   * objects the predictor has always closed over. On a socket it stays empty
   * until `MapInfo` proves the server is on this same document, and the client
   * predicts flat until then. See prediction-ground.ts.
   */
  const ground = emptyGround();
  if (local) fillGround(ground, local.colliders, local.sampler);

  const banner = createConnectionBanner(root);
  let transport: LoopbackTransport | null = null;
  let server: GameServer | null = null;
  let channel: Channel;
  let reconnecting: ReconnectingChannel | null = null;
  if (plan.mode === 'remote') {
    // Wrapped, so a dropped socket comes back to the same body rather than
    // ending the session (spec 150). The wrapper is above `Channel` and not a
    // change to it -- see reconnecting.ts, and transport.ts for why.
    reconnecting = new ReconnectingChannel({
      open: () => connectChannel(plan.url, { onPhase: (phase) => banner.set(phase, plan.url) }),
      onReopen: () => client.resume(),
    });
    channel = reconnecting;
  } else {
    transport = new LoopbackTransport();
    // `local` is non-null on this branch by construction; the server is the
    // only thing that needs it as a value rather than as a possibility.
    server = new GameServer({ seed, ...(local ? { built: local } : {}), transport });
    // Wired by hand rather than through `server.start()`: that would spin up the
    // server's own wall-clock loop, and this view already drives the tick from its
    // animation frame. Registering the handler is the half we want.
    const listening = server;
    transport.onConnection((c) => listening.accept(c));
    channel = transport.connect();
  }

  /**
   * A wire you can make bad on purpose (spec 147).
   *
   * Worn by both paths, because the loopback is the one you can debug against a
   * server you also control -- and because a decorator only the socket wore
   * would be a decorator nobody exercised until something was already wrong.
   * At `PERFECT_WIRE` it delays nothing and drops nothing, so a tab that has not
   * asked for anything is the tab that shipped.
   *
   * Seeded from the URL rather than a clock: two tabs given the same `?wire=`
   * and the same seed get the same bad connection, which is what makes a
   * screenshot of one reproducible on the other.
   */
  let wireConditions: WireConditions = parseWire(new URLSearchParams(location.search).get('wire'));
  const wire = new UnreliableChannel(channel, () => wireConditions, Rng.fromSeed(seed));

  const client = new GameClient(wire, {
    playerId: plan.mode === 'remote' ? plan.playerId : 'you',
    displayName: plan.mode === 'remote' ? plan.displayName : 'You',
    // A token from this tab's last load, so a reload comes back to the same
    // body rather than spawning a second one beside it (spec 150).
    ...(plan.mode === 'remote' ? { resumeToken: plan.resumeToken } : {}),
    // What this build's assets hash to (spec 113). The in-tab server has no
    // manifest of its own, so it always passes there; a real server compares it
    // and refuses a mismatch, which is why the banner has to be able to say a
    // connection was refused rather than merely lost.
    assetManifest: ASSET_MANIFEST_HASH,
    // Predict against the world the server is colliding against (spec 063), so
    // a tree stops the local guess where it stops the authoritative one -- but
    // only once it is known to *be* that world (spec 144).
    predictor: (stats, tickRate) =>
      createGroundPredictor({
        ground,
        radius: SERVER_PLAYER_RADIUS,
        speed: stats.moveSpeed,
        tickRate,
      }),
  });
  /**
   * The world a move order routes through -- the one the server is colliding
   * against, or null while that is not known. `RoutePlanner` treats a null
   * world as "walk straight at it", which is the same fail-safe the flat
   * predictor is: wrong in the direction the server quietly corrects.
   *
   * Rebuilt rather than mutated when the ground arrives, because `navGridFor`
   * memoizes on the colliders' object identity -- handing it a mutated object
   * would cache a grid of the world as it was and never notice.
   */
  let pathWorld: { colliders: WorldColliders; radius: number; ground: TerrainSampler } | null = null;
  /**
   * The ground the nav warm is working on, which is *not* the same thing as the
   * ground a move order may route through (spec 165 follow-up).
   *
   * `pathWorld` is only set once the grid behind it has actually been built.
   * Before that a route request would reach `navGridFor`, find heights it has
   * not sampled yet, and pay for all 797k of them inside that one frame -- which
   * is the freeze this whole change removes, moved from the load to the first
   * click. A null world is `RoutePlanner`'s existing "walk straight at it", the
   * same fail-safe the flat predictor is, and the server is authoritative about
   * routing anyway.
   */
  let navSource: { colliders: WorldColliders; ground: TerrainSampler } | null = null;
  /** The colliders the nav grid has been built against. See {@link stepNavWarm}. */
  let navWarmed: WorldColliders | null = null;
  /** Height cells outstanding and the total, so the loading bar can move through them. */
  let navCellsLeft = 0;
  let navTotalCells = 0;
  function syncPathWorld(): void {
    const { colliders, terrain } = ground;
    navSource = colliders && terrain ? { colliders, ground: terrain } : null;
    pathWorld =
      navSource && navWarmed === navSource.colliders
        ? { colliders: navSource.colliders, radius: SERVER_PLAYER_RADIUS, ground: navSource.ground }
        : null;
  }
  syncPathWorld();
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
  /**
   * The meshing queue and the prop-region bookkeeping (spec 165).
   *
   * Both used to be implicit in the loop below -- mesh everything that arrived,
   * rebuild every prop after two quiet frames -- and both were sized for a map a
   * quarter of this one's size. See chunk-ingest.ts.
   */
  const ingest = new ChunkIngest({
    meshBudget: MESH_BUDGET_PER_FRAME,
    settleMs: PROP_SETTLE_MS,
    regionSize: PROP_REGION_SIZE,
  });
  /**
   * Chunks the server has sent that this client has not inserted yet.
   *
   * Keyed by coordinate, because `client.view()` hands back the whole held set
   * every frame: without this the same arrival would be queued again on every
   * frame until the budget got to it.
   */
  const pendingInserts = new Map<string, HeldChunk>();
  /** When a chunk was last offered, for the nav grid's quiet period. */
  let lastArrivalMs = 0;
  const gate = new LoadGate();
  const loading = createLoadingOverlay(root);
  /**
   * Whether this tab is running the simulation (spec 165 follow-up).
   *
   * The loopback tab is its own server, so `routeToward`'s `navGridFor` runs on
   * *this* thread inside the sim tick. That makes the routing grid a thing the
   * player has to wait for rather than a background nicety, and it is why the
   * load gate has a `routing` phase at all.
   */
  const ownsSimulation = plan.mode !== 'remote';
  /** Whether the routing ground grows as chunks arrive. See the invalidation below. */
  const navGrowsWithStream = plan.mode === 'remote';
  /** The load as the overlay last drew it, so the DOM is written only on change. */
  let lastLoadLabel = '';

  /**
   * The frame-time meter and its overlay (spec 165).
   *
   * Always measuring, drawn only when asked. The measurement is two numbers and
   * an array push per frame, so a session with the readout off pays nothing
   * worth naming -- and the alternative, starting the meter when the switch is
   * thrown, would mean the first two seconds after you go looking for a stutter
   * are the two seconds with no history in them.
   */
  const frames = new FrameMeter();
  const fpsOverlay = createFpsOverlay(root);
  let showFps = false;

  /**
   * Take whatever landed since the last frame, and mesh what the frame can afford.
   *
   * Only chunks the streamed map has not already seen are queued, so a frame
   * costs the number of chunks that *arrived* in it rather than the number
   * held. What is new in spec 165 is that arriving and meshing are no longer the
   * same event: arrivals go into a queue and the frame drains a bounded number of
   * them, so a burst is spread over frames instead of landing in one.
   */
  function ingestChunks(view: ReturnType<typeof client.view>, nowMs: number): void {
    const map = view.map;
    if (!map) return;

    if (!streamed) {
      streamed = new StreamedMap(map.info);
      scene.setMap(streamed);
      // Reported, not acted on (spec 146). Under 144 a mismatch turned
      // prediction off, because the alternative was colliding against a forest
      // the server did not have; now the colliders come from the stream either
      // way and this is just a useful thing to see in a screenshot.
      if (plan.mode === 'remote' && map.info.mapId !== mapIdOf(mapText)) {
        banner.note(`server map ${map.info.mapId.slice(0, 8)}`);
      }
    }

    // Inserting a chunk is not free either -- it rebuilds the arrival's own
    // baked cells plus its four edge neighbours', ~10ms each on the grown map --
    // so the *insert* is budgeted alongside the mesh rather than run over every
    // arrival in the frame it lands. Before this, one pump of 24 arrivals was a
    // quarter-second frame before a single triangle had been rebuilt.
    for (const held of map.chunks) {
      if (streamed.has(held.layer, held.cx, held.cz)) continue;
      const key = `${held.layer}:${held.cx},${held.cz}`;
      if (!pendingInserts.has(key)) lastArrivalMs = nowMs;
      pendingInserts.set(key, held);
    }

    const spend = new FrameBudget(nowMs, INGEST_BUDGET_MS);
    for (const [key, held] of pendingInserts) {
      if (spend.spent()) break;
      pendingInserts.delete(key);
      // One arrival, but up to five chunks to draw: a neighbour's mesh was baked
      // against ground this chunk has only now supplied (spec 078).
      const dirty = streamed.add(held);
      if (dirty.length > 0) ingest.offer(dirty, nowMs);
      // The nav heights over this ground are now answerable, and were not
      // before (spec 165). Marking the rectangle is what keeps the re-sample to
      // this chunk instead of the whole 797k-cell grid.
      // Only when the routing world is the one that *grows*.
      //
      // On the loopback path it is not: `navSource.ground` is the bundled map's
      // own sampler, complete since mount, and a streamed chunk tells it nothing
      // it did not already know. Dirtying it there was worse than useless -- it
      // re-sampled ground that had not changed AND bumped the height version,
      // which invalidates the grid the *in-tab server* is pathing against. Every
      // chunk that arrived while walking cost the sim a fresh nav grid.
      if (navGrowsWithStream && navSource && dirty.length > 0) {
        for (const chunk of dirty) {
          invalidateNavHeights(navSource.ground, navSource.colliders, chunkRect(chunk));
        }
        // Ground can go stale without the *colliders* changing, so the routed
        // world is withdrawn here rather than only when a settle mints new ones.
        // Left standing, the next move order would rebuild the grid inside its
        // own frame, which is the cost this is all about not paying.
        navWarmed = null;
        syncPathWorld();
      }
    }

    for (const chunk of ingest.takeMesh()) {
      scene.addTerrainChunk(chunk);
      if (spend.spent()) break;
    }

    // Props wait for the stream to go quiet rather than rebuilding per chunk.
    // One instanced mesh per species over the whole map is a few draw calls;
    // one per chunk would be two hundred of them on every frame from then on, so
    // per-chunk props would trade a startup cost for a permanent one.
    //
    // What changed in 165 is the *unit*: the regions the arrived ground actually
    // covers, not the whole field. `takePropRects` returns nothing at all until
    // the queue is drained and the stream has been quiet, so this is a handful
    // of calls across a cold start rather than one per delta.
    const rects = ingest.takePropRects(nowMs);
    if (rects.length > 0) {
      scene.refreshPropsWithin(rects);
      // And the ground the *predictor* stands on, on the same settle and for
      // the same reason (spec 146). A fresh colliders object costs a nav grid,
      // because `navGridFor` memoizes on its identity -- so this must happen
      // once per burst of arrivals rather than once per arrival. Warmed here
      // too, since the alternative is paying for it inside the frame that gives
      // the first move order.
      if (plan.mode === 'remote' && streamed) {
        fillGround(ground, streamed.snapshotColliders(), streamed.sampler());
        syncPathWorld();
      }
    }
  }

  /**
   * Pay down the nav grid a slice of a frame at a time (spec 165 follow-up).
   *
   * `warmNavGrids` used to be called straight from the settle above, and on the
   * grown map that is a **4.8 second** frame: 797k cells, one `heightAt` each at
   * 6us, and a fresh sampler per settle meant the whole map was re-sampled every
   * time a burst of chunks landed. Measured, not guessed -- 99% of the warm is
   * the sampling and 90ms is everything else.
   *
   * So the sampling is incremental now and the grid is built from it once there
   * is nothing outstanding. The work and the answer are identical; only when it
   * happens moves, which is the same argument `warmNavGrids` itself makes for
   * doing it at boot rather than at the first move order.
   */
  function stepNavWarm(nowMs: number): void {
    const world = navSource;
    if (!world) return;
    // Not while the stream is still working -- *once the world is up*. Nothing
    // can use the grid until the ground around the player is there, and two jobs
    // competing for one frame is how a budget stops being a budget.
    //
    // Behind the loading screen the opposite is true: there is no frame to
    // protect, and on the loopback path the gate is waiting for exactly this. So
    // it runs alongside the stream there, and the bar says what it is doing.
    if (gate.open && (pendingInserts.size > 0 || !ingest.idle)) return;
    const spend = new FrameBudget(nowMs, gate.open ? NAV_BUDGET_MS : LOAD_NAV_BUDGET_MS);
    let left = pendingNavHeights(world.ground, world.colliders);
    if (navTotalCells === 0) navTotalCells = left;
    while (left > 0 && !spend.spent()) {
      left = stepNavHeights(world.ground, world.colliders, NAV_CELLS_PER_SLICE);
    }
    navCellsLeft = left;
    if (left > 0 || navWarmed === world.colliders) return;
    // Sampled, but hold the ~110ms build until the stream has actually stopped.
    // Not while the loading screen is up: there the build *is* the thing being
    // waited for, and deferring it would be the gate waiting on a step that is
    // waiting on the gate.
    if (gate.open && nowMs - lastArrivalMs < NAV_GRID_QUIET_MS) return;
    // Everything sampled: the remaining ~90ms is the obstacle passes and the
    // component flood, and it is paid once per colliders object rather than once
    // per frame. The colliders only change when the prop field does, which is
    // the settle -- so this is a handful of times across a load, not a cadence.
    navWarmed = world.colliders;
    // Every radius the sim will ask for, not just the player's. A grid is per
    // radius, and `routeToward` asks with the *monster's* -- so warming one
    // radius leaves the first wolf to path building its own grid inside the sim
    // tick, which is the stall this is here to prevent wearing a smaller hat.
    // The set lives in build.ts precisely so two call sites cannot disagree
    // about it, and this is the second call site.
    warmNavGrids(world.colliders, world.ground, ROUTING_RADII);
    // Only now may a move order route through it.
    syncPathWorld();
  }

  /**
   * Whether to show the world yet, and what the bar says while we do not
   * (spec 165).
   *
   * `view.self` is the *predicted* position, and it is nonetheless the right
   * thing to gate on: `startPredictingIfReady` builds the prediction buffer only
   * once the server's `Welcome` has named an entity, that entity is in the
   * replicated world and its stats have arrived. So "there is a predicted
   * position at all" is exactly the fact this gate wants -- the server has
   * placed this body and said where. Before that there is no position to centre
   * a load on, and no honest world to draw.
   *
   * `worldReady` is written here rather than on the first prop settle, which is
   * what it used to mean and what made it wrong -- the first settle is the end of
   * the first pump of the stream, not the end of the load. Harnesses wait on it,
   * so it now means what they always read it as meaning.
   */
  function updateLoading(view: ReturnType<typeof client.view>): void {
    const self = view.self ?? null;
    const coverage =
      streamed && self ? streamed.coverage(self.x, self.y, READY_CHUNK_RADIUS) : { held: 0, needed: 0 };
    const progress = gate.progress({
      haveMap: view.map !== null,
      located: self !== null,
      held: coverage.held,
      needed: coverage.needed,
      meshPending: ingest.pending,
      // Only this tab's own sim can stall on it; a remote client's grid is a
      // prediction aid and warms behind the world.
      routingPending: ownsSimulation && pathWorld === null,
      routingProgress:
        navTotalCells > 0 ? 1 - navCellsLeft / navTotalCells : 0,
    });

    const label = `${progress.phase}:${Math.round(progress.fraction * 100)}`;
    if (label !== lastLoadLabel) {
      lastLoadLabel = label;
      loading.set(progress);
      if (progress.phase === 'ready') root.dataset['worldReady'] = 'true';
    }
    // The canvas is what is hidden, not the whole root: the overlay draws over
    // it and the HUD's own elements are already hidden behind the overlay's
    // backdrop. Hiding the canvas rather than pausing the renderer is deliberate
    // -- the frames still run, so the world that appears when the gate lifts is
    // a settled one rather than one that starts warming up at that moment.
    canvas.style.visibility = gate.open ? 'visible' : 'hidden';
  }

  /**
   * Mirrors the authored units' state onto the root element (spec 111).
   *
   * Written only when it changes, because a per-frame attribute write is a
   * per-frame style invalidation. Read by `preview-units.ts` and by nothing in
   * the game -- this is a window into the renderer, not an input to it.
   */
  let lastUnitReadout = '';
  function publishUnitReadout(): void {
    const readout = scene.authoredUnitReadout();
    const text = `${readout.loaded}:${readout.bones}:${readout.states}`;
    if (text === lastUnitReadout) return;
    lastUnitReadout = text;
    root.dataset['authoredUnits'] = String(readout.loaded);
    root.dataset['authoredBones'] = String(readout.bones);
    root.dataset['authoredStates'] = readout.states;
  }

  /**
   * Mirrors what the interface is showing onto the root element (spec 131).
   *
   * The same window `publishUnitReadout` opens, and needed for the same reason
   * turned up a level: the interface draws to a canvas, so a browser harness has
   * no DOM to ask whether the bag on screen is the bag the server sent. Written
   * only when it changes; read by `preview-world.ts` and by nothing in the game.
   */
  let lastUiReadout = '';
  let lastUiCost = '';
  /** The last camera pair published, so a still view invalidates no styles. */
  let lastCamera = '';
  function publishUiReadout(): void {
    const readout = ui.readout();
    // Its own comparison, because this one moves on its own: it is the worst of
    // a sliding window and would otherwise force a style invalidation on every
    // frame the interface got slightly slower.
    const cost = `${readout.frameMs.toFixed(2)}/${readout.worstFrameMs.toFixed(2)}`;
    if (cost !== lastUiCost) {
      lastUiCost = cost;
      root.dataset['uiFrameMs'] = readout.frameMs.toFixed(2);
      root.dataset['uiWorstMs'] = readout.worstFrameMs.toFixed(2);
    }
    const windows = readout.windows.join(',');
    const bag = readout.bag.filter((name) => name !== '').join(',');
    // The same list with its gaps kept, so a harness can say *which cell* holds
    // what (spec 137). Both, rather than one: the filtered one is what a person
    // reads in a log, and the raw one is what an index means something in.
    const cellNames = readout.bag.join(',');
    // The scale and the viewport are in the key as well as in the attributes: a
    // resize changes neither the windows nor the bag, and a readout that only
    // watched those would report the old frame forever.
    // The options window's tab strip, in UI pixels: `id:x,y,w,h` apiece (spec
    // 136). The harness clicks a tab with it, because the alternative is a
    // guessed offset that passes for the wrong reason the day the layout moves.
    const boxes = (rects: readonly { readonly id: string; readonly rect: Rect }[]): string =>
      rects.map((box) => `${box.id}:${box.rect.x},${box.rect.y},${box.rect.width},${box.rect.height}`).join(';');
    const tabs = boxes(readout.tabRects);
    const scales = boxes(readout.scaleRects);
    const cells = boxes(readout.bagRects);
    const binds = boxes(readout.bindRects);
    const resets = boxes(readout.resetRects);
    // Every window's placement, open or not (spec 147). In the key as well,
    // because a window dragged or resized changes nothing else on this line --
    // and a readout that did not watch it would report the old box forever,
    // which is exactly the state the whole feature is a claim about.
    const frames = boxes(readout.windowRects);
    const text =
      `${windows}|${bag}|${readout.scale}|${readout.viewport.width}x${readout.viewport.height}` +
      `|${readout.tab}|${tabs}|${readout.scaleChoice}|${scales}|${cells}|${cellNames}|${frames}`;
    if (text === lastUiReadout) return;
    lastUiReadout = text;
    root.dataset['uiWindows'] = windows;
    root.dataset['uiBag'] = bag;
    root.dataset['uiScale'] = String(readout.scale);
    root.dataset['uiViewport'] = `${readout.viewport.width}x${readout.viewport.height}`;
    root.dataset['uiTab'] = readout.tab;
    root.dataset['uiTabs'] = tabs;
    root.dataset['uiScaleChoice'] = readout.scaleChoice;
    root.dataset['uiScales'] = scales;
    root.dataset['uiCells'] = cells;
    root.dataset['uiCellNames'] = cellNames;
    root.dataset['uiBinds'] = binds;
    root.dataset['uiResets'] = resets;
    root.dataset['uiFrames'] = frames;
  }

  /**
   * What the bar holds (spec 164): four empty slots and the vial, unless
   * `?slots=` says otherwise.
   *
   * Built once, here, and handed to both readers -- the HUD draws it and the
   * key handler below presses it. Two copies would be two answers about what is
   * in slot 3, which is exactly the kind of disagreement `abilityForSlot` exists
   * to make impossible.
   */
  const actionBar = actionBarFromQuery(location.search);
  const hud = createHud((x, y, lift) => scene.projectPoint(x, y, lift), actionBar);
  /** The overlay's current box, so it is only rewritten when the letterbox moves. */
  let hudBox = { x: -1, y: -1, width: -1, height: -1 };
  hud.onUse((abilityId) => pressAbility(abilityId));
  // Picking a weapon is an ordinary equip (spec 079): the server puts it in the
  // hand, recomputes the stat block, and the new `basicAttackId` comes back on
  // `Stats`. Nothing here decides what the right-click then does -- the next
  // frame simply reads the stat and asks for whatever it names.
  hud.onEquip((itemId) => client.equip('mainHand', itemId));
  // The way back up (spec 164). The overlay is drawn from replicated health and
  // this is the only thing it does -- nothing on this side decides that a player
  // is alive again.
  hud.onRespawn(() => client.respawn());
  // The same call a key binding makes (spec 140). The button knows which window
  // it names and nothing else about what opening one costs.
  hud.onOpen((id) => ui.toggle(id));

  // The settings buttons float over the top-right corner of the game window: the
  // view cog (spec 034), the day/night clock, the player's lights, the retro
  // filter and the hike look (spec 107), then the weather (spec 075). A popover
  // each rather than one drawer for all of them -- and one group, so opening any
  // of them closes the rest instead of stacking six panels into one corner.
  //
  // Not on a phone (spec 140). They are tuning panels twenty rows deep, and on
  // an 844x390 frame the seven of them pile into the corner underneath the tab
  // bar. `scene.controls` is still *built* -- the camera reads its sliders, and
  // `orbitBy` writes them -- it simply has nowhere to be pressed, so a phone
  // gets the defaults and the options window (spec 135) instead.
  const showsTuningMenus = hudLayout(isHandheldDevice()).showsTuningMenus;
  if (showsTuningMenus) {
    const weather = createWeatherControls({ group: scene.controls.menus });
    // The seventh button (spec 121). Both settings are pushed straight into the
    // layer rather than polled: the intensity is a budget the sim reads, and gore
    // is a switch the decal field acts on rather than a flag anything draws past.
    const vfxControls = createVfxControls({
      group: scene.controls.menus,
      onChange: (settings) => {
        scene.setVfxIntensity(settings.intensity);
        scene.setGore(settings.gore);
      },
    });
    // The eighth button (spec 147). Writes into the conditions the channel
    // reads once a tick, the same "the widgets are the state" split the weather
    // panel uses -- there is nothing to copy and nothing to poll.
    const wireControls = createWireControls({
      group: scene.controls.menus,
      initial: wireConditions,
    });

    const buttons = document.createElement('div');
    // Inset against the notch and the home indicator (spec 093): in landscape the
    // cutout is on a side edge, which is exactly where these sit.
    buttons.style.cssText =
      'position:absolute;top:calc(8px + env(safe-area-inset-top));right:calc(10px + env(safe-area-inset-right));' +
      'z-index:30;display:flex;gap:6px;';
    buttons.append(scene.controls.element, weather.element, vfxControls.element, wireControls.element);
    // Polled once here rather than pushed per input: the channel asks for the
    // conditions itself, every tick.
    wireConditions = wireControls.conditions();
    for (const el of [wireControls.element]) {
      el.addEventListener('input', () => {
        wireConditions = wireControls.conditions();
      });
    }
    root.append(buttons);
  }
  root.append(hud.element);

  /** Where a blow lands on a body, in world units above its feet. */
  const BLOOD_HEIGHT = 26;

  client.onCombatResult((result) => {
    // What a blow looks like, decided in one pure place (spec 120). Nothing
    // about this changes a game outcome -- the server already resolved the blow
    // and this is reading the answer.
    const target = client.view().entities.find((entity) => entity.id === result.targetId);
    const attacker = client.view().entities.find((entity) => entity.id === result.attackerId);
    if (target) {
      for (const request of effectsForBlow(
        {
          attackerId: result.attackerId,
          targetId: result.targetId,
          damage: result.damage,
          killed: (result.flags & 1) !== 0,
          critical: (result.flags & 2) !== 0,
          blocked: (result.flags & 4) !== 0,
          damageType: 'physical',
          x: target.x,
          y: BLOOD_HEIGHT,
          z: target.y,
          fromX: attacker?.x ?? target.x,
          fromZ: attacker?.y ?? target.y,
          bleeds: true,
        },
        client.view().estimatedTick,
      )) {
        scene.playEffect(request);
      }
    }
    // Where it landed, asked for now and never again (spec 096). The scene is
    // the better answer -- it knows the pose actually on screen, and it still
    // holds the body of something this very blow killed -- and the replica is
    // the fallback for a hit on a body no frame has drawn yet.
    const at = scene.bodyAnchor(result.targetId) ?? replicaAnchor(result.targetId);
    if (!at) return;
    hud.addDamage(result.targetId, at, result.damage, (result.flags & 2) !== 0);
  });
  client.onEffect((effect) => {
    // A self-heal reports itself twice: once as this message and once as the
    // negative-damage blow that draws the heal (spec 157). The registry holds
    // no entry under an ability's own id, so drawing this one too would put
    // `addEffect`'s orange debug disc under the green heal for half a second.
    if (REDUNDANT_SERVER_EFFECTS.has(effect.effectId)) return;
    // The id the server has always sent and this view has always dropped.
    scene.addEffect(effect.effectId, effect.x, effect.y, effect.radius, effect.durationTicks);
  });
  client.onCastRejected((abilityId, reason) => {
    hud.error(castRefusalText(abilityById(abilityId)?.name ?? abilityId, reason));
  });
  // Every *other* refusal, into the same stack (spec 147).
  //
  // The server already answered a refused allocation, a refused respec and a
  // refused equip with a reason, and this client dropped all three on the floor:
  // nothing listened to `onError` at all. A "+" that goes grey and then does
  // nothing when pressed reads as the game being broken rather than as the rule
  // it is, and the refusal stack spec 143 built is exactly the place to say so.
  client.onError((_code, message) => {
    if (message.length > 0) hud.error(message);
  });

  /** The world point of a body the scene has not drawn, out of the last delta. */
  function replicaAnchor(entityId: number): WorldAnchor | null {
    const entity = client.view().entities.find((candidate) => candidate.id === entityId);
    return entity ? { x: entity.x, y: entity.y, lift: DEFAULT_HEADROOM } : null;
  }

  // --- input -------------------------------------------------------------
  /**
   * Held *actions*, not key codes (spec 125).
   *
   * The map is per-view and loaded from the player's profile at mount; the
   * storage is reached for here, at the DOM edge, exactly as the editor's
   * autosave does it -- everything under src/ui/ takes a `StorageLike`.
   */
  const held = new Set<string>();
  /**
   * Held raw key *codes*, for the input that is deliberately not rebindable.
   *
   * Today that is the two camera keys and nothing else (spec 129 chose two
   * hard-coded codes on purpose, since there was no binding surface when it was
   * written). It is a second set rather than an entry in `bindings.json` because
   * the profile is a versioned document with golden images over the actions it
   * lists, and a camera section in it is a larger change than this.
   *
   * It exists at all because the camera keys have been dead since spec 125:
   * `orbitStep` asks for `BracketLeft`/`BracketRight` and `held` has stored
   * rebindable action ids ever since, so nothing was ever added for them and
   * `[` and `]` turned nothing on any device (spec 140). The unit test passed
   * throughout -- the arithmetic was never wrong, the wiring was -- which is why
   * `scripts/probe-orbit.ts` drives a real page.
   */
  const heldKeys = new Set<string>();
  const inputMap = new InputMap();
  /**
   * Where the key profile lives. Reached for here, at the DOM edge, exactly as
   * the editor's autosave does it -- everything under src/ui/ takes a
   * `StorageLike` and never a `Window`.
   */
  const bindingStorage = globalThis.localStorage ?? {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  loadBindings(bindingStorage, inputMap);
  // The saved answer, before the first frame draws anything -- so a session that
  // asked for the readout last time has it from frame one rather than from
  // whenever the options window is next opened.
  showFps = loadShowFps(bindingStorage);

  /**
   * The framework's interface, over the world (spec 131).
   *
   * Built after the map so it sits above the world canvas in the DOM, and given
   * the same `inputMap` the keys are read through -- so rebinding a key in the
   * keybinding window rebinds it in the game, because there is one map.
   *
   * Every callback below is a *request*: the screens emit intents and the server
   * decides. Nothing here writes to a container, a purse or a skill tree.
   */
  const ui = new UiLayer(root, {
    map: inputMap,
    onMove: (from, to, count) => client.moveItem(from, to, count),
    onSpend: (skillId) => client.spendSkillPoint(skillId),
    onAllocate: (key) => client.allocateAttribute(key as BaseStatKey),
    onRespec: () => client.respecAttributes(),
    onBuy: (vendorId, defId) => client.buyItem(vendorId, defId),
    onSell: (vendorId, index) => client.sellItem(vendorId, index),
    onBuyBack: (vendorId, index) => client.buyBack(vendorId, index),
    onVendor: (vendorId) => client.openVendor(vendorId),
    onTradeOffer: (slots, coins) => client.offerInTrade(slots, coins),
    onTradeAccept: (revision) => client.acceptTrade(revision),
    onTradeRespond: (accept) => client.respondToTrade(accept),
    onTradeCancel: () => client.cancelTrade(),
    // Written straight through, because a key the player just changed and then
    // lost to a refresh is worse than one that never saved at all.
    onBindingsChanged: () => saveBindings(bindingStorage, inputMap),
    // Honoured and saved in the same breath, for the same reason (spec 136):
    // the interface re-frames on the next update, so a preference that failed
    // to save would be one the player watched work and then lose.
    onScaleChosen: (choice) => {
      ui.setScaleChoice(choice);
      saveScale(bindingStorage, choice);
    },
    // Same three steps as the scale, in the same order and for the same reason
    // (spec 165): honour it, tell the page so its tick matches what is drawn,
    // and save it before the frame that could lose it.
    onShowFpsChosen: (show) => {
      showFps = show;
      ui.setShowFps(show);
      saveShowFps(bindingStorage, show);
    },
    // The one place the platform is asked, beside the media queries.
    scale: loadScale(bindingStorage),
    showFps: loadShowFps(bindingStorage),
    // Where the windows were (spec 147). Read here and written back here, for
    // the third time and the third reason: the mount is pure, so the document
    // arrives as a value and leaves as a callback. `saveLayout` cannot throw --
    // this one is called from inside the frame.
    layout: loadLayout(bindingStorage),
    onLayoutChanged: (layout) => {
      saveLayout(bindingStorage, layout);
    },
    // Where the *player* is, not where the camera is looking: the server checks
    // the same distance from the same position, and asking about a shop the
    // server will refuse is how a window opens empty.
    nearestVendor: () => {
      const me = client.view().self;
      return me ? nearestVendorTo(me.x, me.y) : null;
    },
  });
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
   * The drop being walked over to, or null (spec 158).
   *
   * Beside {@link targetId} rather than folded into it because the two end
   * differently: an attack order stands until the body is down, and this one is
   * over the instant the server answers. It is also the only order in this file
   * whose object the client may not be able to name yet, which is exactly the
   * point of the feature.
   */
  let pickupId: number | null = null;
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
      // Said out loud in the same stack the server's refusals land in, so a
      // dead press is never silent. Nothing else moves: a key that does nothing
      // does nothing, so a standing aim is left exactly as it was.
      hud.error(castRefusalText(ability.name, start.reason));
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

  /**
   * Whether a right-click on this body is a pickup rather than an attack or a
   * walk (spec 158).
   *
   * As thin as `attackable` and for the same reason: whether the drop is
   * *yours*, whether you are close enough, and whether the bag has room are all
   * the server's to answer, and it answers them on every request. This only
   * decides which of the three things the button meant.
   */
  function collectable(entity: { kind: number }): boolean {
    return entity.kind === EntityKind.Drop;
  }

  /** Whether the cursor is over a drop this frame. Nothing else reads it. */
  function hoveringDrop(view: ReturnType<typeof client.view>, hovered: number | null): boolean {
    if (hovered === null) return false;
    const entity = view.entities.find((candidate) => candidate.id === hovered);
    return entity !== undefined && collectable(entity);
  }

  /**
   * The only place in the game that turns a `KeyboardEvent` into a decision
   * (spec 125).
   *
   * It asks the map what actions the key fires and acts on those; it never
   * branches on a code or a letter. That is what makes every key here
   * rebindable, and it is why `held` now holds action ids rather than key codes.
   */
  const modifiersOf = (event: KeyboardEvent): Modifiers => ({
    shift: event.shiftKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    meta: event.metaKey,
  });

  /**
   * The printable character a key produced, or undefined.
   *
   * A text field takes characters from a `text` event and control keys from a
   * `key` one, and a browser delivers both on one `keydown` -- so the character
   * has to be pulled out here, at the DOM edge. Anything with a modifier that
   * makes it a command rather than a letter is not text.
   */
  const textOf = (event: KeyboardEvent): string | undefined =>
    event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? event.key : undefined;

  const onKeyDown = (event: KeyboardEvent): void => {
    // Offered to the interface first, and gameplay hears it only if the
    // interface did not take it (spec 131). Tab is the one key the router never
    // routes: it moves focus, and it must not also reach the browser's own.
    if (event.code === 'Tab' && ui.anyOpen) {
      event.preventDefault();
      ui.moveFocus(event.shiftKey ? -1 : 1);
      return;
    }
    if (ui.handleKey(event.code, 'down', modifiersOf(event), textOf(event))) {
      // Held actions are cleared for the same reason `blur` clears them: keys
      // pressed while the interface has the keyboard get no release the game
      // will see, and a stranded `move.north` walks into a wall. A stranded
      // camera key is the same bug with the view spinning instead.
      held.clear();
      heldKeys.clear();
      return;
    }

    // Recorded before the map is consulted, because these are the keys the map
    // does not know about (spec 140).
    heldKeys.add(event.code);

    const decision = decideKeyDown(inputMap, event.code, modifiersOf(event));

    for (const id of decision.windows) {
      ui.toggle(id);
      event.preventDefault();
    }

    for (const action of decision.move) {
      held.add(action);
      // Any manual step also drops a standing order, for the same reason held
      // keys outrank one in `moveIntent`: taking the keys is taking control.
      //
      // A *pending* aim survives it. Walking while you decide where to put a
      // blast is the point of being allowed to decide; a confirmed order does
      // not survive, because from then on it is steering and a held key already
      // outranks a destination in `moveIntent`.
      destination = null;
      planner.clear();
      targetId = null;
      order = null;
    }

    for (const slot of decision.skillbar) {
      // The one gate (spec 164). An empty slot and a key past the last slot are
      // the same nothing here as they are on the button, because both ends ask
      // the same function -- a key that could cast out of a slot the bar draws
      // as empty would be a second answer about what the bar holds.
      const ability = abilityForSlot(actionBar, slot);
      if (!ability) continue;
      pressAbility(ability);
      event.preventDefault();
    }

    // Cancelling calls off a wind-up. It refunds the cost and the cooldown, so
    // what a called-off cast spends is exactly the time it took -- which is why
    // the action is worth having somewhere that is not also the move button.
    if (decision.cancel) {
      // What Escape means when there is nothing to back out of (spec 135).
      //
      // The interface has already had it and did not want it -- no drag, no
      // dialog, no window. So the question left is whether *gameplay* wants it,
      // and it does exactly when there is something committed to: a wind-up, an
      // aim, a standing order. When there is not, Escape is the menu, which is
      // what it means in every game that has one.
      //
      // Asked here rather than in `ui-screens.ts` because this is the only place
      // both facts are visible -- that half may not see a cast, on purpose.
      const committed =
        pendingAim !== null || order !== null || targetId !== null || client.view().selfRoot !== null;
      client.cancelCast();
      // Withdrawing from a blow that the auto-attack would re-commit to on the
      // next tick is not withdrawing from anything.
      targetId = null;
      clearAim();
      if (!committed) ui.toggle('options');
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    ui.handleKey(event.code, 'up', modifiersOf(event));
    // Dropped whatever the interface said, for the reason below: a release the
    // UI swallowed is a key held forever, and here that is a view that spins.
    heldKeys.delete(event.code);
    // Released whatever the interface said, always. A release that the UI
    // swallowed is a held action with no way out, and the symptom is walking
    // into a wall until the same key is pressed and released again.
    for (const action of decideKeyUp(inputMap, event.code)) held.delete(action);
  };

  const mouseModifiers = (event: MouseEvent): Modifiers => ({
    shift: event.shiftKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    meta: event.metaKey,
  });
  /** A mouse event in the coordinates the canvas and the UI layer share. */
  const pointIn = (event: MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onMove = (event: MouseEvent): void => {
    const at = pointIn(event);
    // A cursor over a window is not a cursor over the world: leaving it set
    // would go on highlighting a body under the panel and aiming at it.
    cursor = ui.handlePointer('move', at, -1, mouseModifiers(event)) ? null : at;
  };
  const onLeave = (): void => {
    cursor = null;
  };
  const onMouseUp = (event: MouseEvent): void => {
    // The world has nothing to do with a mouse release -- an order is given on
    // the press -- but a drag ends on one, so the interface has to hear it.
    ui.handlePointer('up', pointIn(event), event.button, mouseModifiers(event));
  };
  const onMouseDown = (event: MouseEvent): void => {
    if (ui.handlePointer('down', pointIn(event), event.button, mouseModifiers(event))) return;
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

    // ...and shift makes it a third thing (spec 134): an offer to trade with the
    // player under the cursor. On the button that already means "act on that
    // body" rather than a key of its own, because a trade is aimed at somebody
    // and a key is not. Anything that is not another player is left alone --
    // and the server checks again.
    if (event.shiftKey) {
      const under = cursor ? scene.pickUnitAt(cursor.x, cursor.y) : null;
      const picked = under === null ? null : client.view().entities.find((e) => e.id === under);
      if (picked && picked.kind === EntityKind.Player && picked.id !== client.view().selfEntityId) {
        client.inviteToTrade(picked.id);
      }
      return;
    }

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
    pickupId = null;

    const hovered = scene.pickUnitAt(cursor.x, cursor.y);
    const picked = hovered === null ? null : client.view().entities.find((e) => e.id === hovered);
    // A drop under the cursor is the third thing the button can mean, and it is
    // checked before `attackable` for clarity rather than for precedence -- a
    // drop is not attackable, so the two can never both be true.
    if (picked && collectable(picked)) {
      pickupId = picked.id;
      targetId = null;
      destination = null;
      planner.clear();
      return;
    }
    if (picked && attackable(picked, client.view().selfEntityId)) {
      // A new mark withdraws from the blow aimed at the old one (spec 155),
      // through exactly the call the empty-ground branch below makes. The button
      // that says "go there instead" and the button that says "hit that one
      // instead" are the same button giving a new order, and an order withdraws
      // -- otherwise the swing lands on the body you just stopped attacking and
      // the click you actually made waits out its follow-through.
      //
      // Guarded on the id, because right-clicking the body you are already
      // attacking is not a change of mind: unguarded, spam-clicking a mark would
      // cancel every wind-up it started.
      //
      // Not gated on the attack point, exactly as the ground click is not.
      // Skipping a backswing buys movement and never a faster next attack -- the
      // interval was stamped at the attack point and no cancellation path writes
      // it again (spec 144) -- so an explicit new order may end one.
      if (picked.id !== targetId) client.cancelCast();
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
    // And the only thing that says so on screen (spec 127): a wave where the
    // click landed, which is over long before the walk is. Presentation only --
    // the order above is what the sim hears, and it hears it either way.
    scene.playMoveOrder(destination.x, destination.y);
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

  // --- touch (specs 093, 140) --------------------------------------------
  //
  // One gesture has to carry both mouse buttons, so a tap is answered by
  // whatever is being asked rather than meaning one fixed thing. Two fingers
  // carry the zoom and the camera's swing at once (spec 140).
  const gestures = new TouchGestures();

  /**
   * The fingers the interface owns, decided on the way down (spec 140).
   *
   * Ownership is per pointer and settled once, at `pointerdown`, rather than
   * asked again on every move: a finger that started on a window must not become
   * half of a pinch when it slides off the edge of it, and a finger that started
   * on the world must not be swallowed by a window that opened underneath it
   * mid-gesture. It is also what keeps `TouchGestures` seeing a consistent set --
   * a `down` it never got must not be followed by an `up` it does.
   */
  const interfaceFingers = new Set<number>();

  /**
   * A touch has no modifier keys. Shared rather than built per event, because it
   * is the same four falses every time.
   */
  const touchModifiers: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };

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
    // Offered to the interface first, exactly as a mouse press is (spec 140).
    // Without this a window drawn over the world was scenery: the tap under it
    // ordered the player to walk to wherever the window was, and nothing in the
    // bag, the sheet or the options window could be pressed at all.
    if (ui.handlePointer('down', pointIn(event), 0, touchModifiers)) {
      interfaceFingers.add(event.pointerId);
      return;
    }
    gestures.down(sampleOf(event));
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') {
      onMove(event);
      return;
    }
    if (interfaceFingers.has(event.pointerId)) {
      ui.handlePointer('move', pointIn(event), 0, touchModifiers);
      return;
    }
    const gesture = gestures.move(sampleOf(event));
    if (gesture?.kind !== 'twoFinger') return;
    // Both halves of what two fingers did, applied together (spec 140). A pure
    // spread arrives with `dragX` at zero and a pure swipe with `ratio` at one,
    // so neither call costs anything when it is not what the hand meant -- and
    // nothing here has to decide which gesture this "really" is.
    scene.controls.pinchZoom(gesture.ratio);
    // Turning, not panning. The camera still follows the player (spec 039);
    // what a swipe moves is which side of them it watches from, which is the
    // one thing a rock standing in the way needs (spec 129).
    const swing = orbitDrag(gesture.dragX);
    if (swing !== 0) scene.controls.orbitBy(swing);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') {
      onMouseUp(event);
      return;
    }
    if (interfaceFingers.delete(event.pointerId)) {
      ui.handlePointer('up', pointIn(event), 0, touchModifiers);
      return;
    }
    const gesture = gestures.up(sampleOf(event));
    if (gesture?.kind === 'tap') onTap(gesture.x, gesture.y);
  };

  /**
   * The wheel, offered to the interface before the camera zoom takes it.
   *
   * On `root` and in the capture phase because the zoom listener is on the
   * canvas (`scene.controls.attachWheelZoom`), and stopping propagation here is
   * the only way to reach it first without that function learning about this
   * one. Scrolling a shop's stock must not also pull the camera in.
   *
   * `deltaY` is converted rather than forwarded: the interface counts notches
   * and points the other way (`wheelNotches`). Handed the raw number, every
   * window in the game scrolled backwards and a notch of it went end to end.
   */
  const onWheel = (event: WheelEvent): void => {
    if (!ui.handleWheel(pointIn(event), wheelNotches(event.deltaY), mouseModifiers(event))) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    // A finger the interface owns is dropped rather than lifted: a cancel is the
    // browser taking the gesture away, which is not a press being completed.
    if (interfaceFingers.delete(event.pointerId)) return;
    gestures.cancel(event.pointerId);
  };

  /** A pointer event as the recogniser's plain, canvas-relative sample. */
  function sampleOf(event: PointerEvent): TouchSample {
    const rect = canvas.getBoundingClientRect();
    return { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  const onContextMenu = (event: Event): void => event.preventDefault();
  const onBlur = (): void => {
    held.clear();
    heldKeys.clear();
    // A gesture interrupted by losing focus never sends its pointerup, and the
    // next finger down would otherwise land mid-pinch.
    gestures.clear();
    interfaceFingers.clear();
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

  /**
   * One tick of a pickup order (spec 158): close the gap, then ask once.
   *
   * The same shape as `driveAutoAttack` and `driveCastOrder` -- a destination
   * into `moveIntent` and a request to the server, which validates it exactly as
   * it validates the other two. The decision itself is
   * `pickupOrderFor`, so "does the player stop walking once they are close
   * enough" is a question answered in Node.
   *
   * The order is dropped the moment the drop leaves the view, which covers all
   * three endings at once: taken by us, taken by its owner, or expired.
   */
  function drivePickup(view: ReturnType<typeof client.view>, me: { x: number; y: number }): void {
    if (pickupId === null) return;
    const mark = view.entities.find((entity) => entity.id === pickupId);
    if (!mark) {
      pickupId = null;
      destination = null;
      planner.clear();
      return;
    }

    const self = view.entities.find((entity) => entity.id === view.selfEntityId);
    const reach = PICKUP_RANGE + SERVER_PLAYER_RADIUS;
    const decision = pickupOrderFor({
      self: me,
      selfHealth: self?.health ?? 1,
      drop: { entityId: mark.id, x: mark.x, y: mark.y },
      // The server's own reach, plus our body radius, because it measures from
      // the same two centres.
      reach,
      // ...and how far in front of the server this body's prediction may be,
      // measured rather than assumed. Without it the walk stopped at the
      // client's copy of the reach and the server refused from a stride
      // further back.
      lead: pickupLead(view.stats?.moveSpeed ?? 0, view.roundTripTicks, SERVER_TICK_RATE, reach),
      // Cleared by whichever `Inventory` answers it, so a refusal is asked
      // again on the next tick rather than leaving the order standing there.
      pending: view.awaitingPickup,
    });
    destination = decision.walkTo;
    if (!decision.walkTo) planner.clear();
    if (!decision.ask) return;

    client.pickUp(mark.id);
    // **One order, one request.** The order ends here rather than standing until
    // the drop leaves the view, and that is the whole of the second bug: the
    // `Inventory` answering a pickup is sent straight back from the handler
    // while the `Delta` that withdraws the entity rides the 20Hz broadcast, so
    // there is a window of a tick or two where the request has been answered
    // and the drop is *still in the replica*. An order that kept standing saw a
    // drop it was in reach of with nothing in flight, and asked again -- four
    // times, for something the server had already handed over, three of them
    // answered "there is nothing there".
    //
    // Nothing is lost by stopping. The one refusal walking could have fixed is
    // the range one, and the order no longer asks from a distance that produces
    // it (see `pickupLead`); every other refusal -- not yours, bag full, gone --
    // is one the player has to act on, and asking again would not help.
    pickupId = null;
    destination = null;
    planner.clear();
  }

  /**
   * Call off a blow whose mark has left the world (spec 155).
   *
   * Here rather than inside `driveAutoAttack` because it is not the attack
   * order's rule: a confirmed aim (spec 080) that names a body reaches the same
   * wind-up by a different road, and one rule in one place is what stops the two
   * disagreeing about it. `withdraw.ts` holds the decision; this finds the two
   * things it needs.
   */
  function withdrawIfMarkGone(view: ReturnType<typeof client.view>): void {
    if (windupLostItsMarkIn(view)) client.cancelCast();
  }

  function sendInput(): void {
    // First, and off its own read of the view, so everything below sees a body
    // that has already been let go: the legs come back on the tick the mark
    // died rather than on the one after it.
    withdrawIfMarkGone(client.view());
    const view = client.view();
    const me = selfPosition();
    driveCastOrder(view, me);
    driveAutoAttack(view, me);
    drivePickup(view, me);
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

  /** The wire's own clock: whole sim ticks, same as everything else here. */
  let wireTick = 0;
  /**
   * The reconnect backoff's clock, in the same ticks but off the wall (spec
   * 157). Separate from `wireTick` because that one stops with the frame loop,
   * and this one must not.
   */
  let backoffTick = 0;
  /** The wall-clock timer driving the heartbeat and the backoff. 0 when stopped. */
  let keepAlive = 0;

  function frame(now: number): void {
    const elapsed = last === 0 ? TICK_MS : now - last;
    last = now;
    // Before anything this frame does, so what is measured is the whole frame's
    // period rather than the part of it that happens to come after the work.
    frames.push(now);
    // Steered by the server's own count of what it has not consumed yet
    // (spec 148). This is the render loop doing the job CLAUDE.md gives it --
    // turning real time into a number of fixed ticks -- and not an `if` that
    // changes an outcome: the timestep the sim runs on is still 1/60, and what
    // moves is how often wall-clock time produces one.
    const tickMs = TICK_MS * (client.view().tickScale || 1);
    accumulator = Math.min(accumulator + elapsed, tickMs * MAX_CATCH_UP_TICKS);
    sinceDelta += elapsed;

    let ticks = 0;
    while (accumulator >= tickMs) {
      accumulator -= tickMs;
      ticks += 1;
      wireTick += 1;
      // The backoff used to be driven from here, on the sim clock. It is on the
      // wall clock now (spec 157): a hidden tab stops this loop, and a
      // reconnect that can only be attempted while somebody is looking at the
      // tab is not a reconnect.
      // Released before the tick that will read them, so a frame due on this
      // tick is one this tick sees (spec 147).
      wire.deliver(wireTick);
      // The in-tab server advances on the same fixed step it would over a wire;
      // this view just happens to be the thing driving its clock. Over a real
      // socket there is no server here to drive -- the client's own clock below
      // is the only one this tab owns (spec 144).
      server?.tick();
      // The client keeps its own clock (spec 065's follow-up): deltas are
      // suppressed when nothing changed, so `view.tick` is not one.
      client.advanceTick();
      sendInput();
    }

    // Turning the view is the player's job now (spec 129), which is why nothing
    // carves a hole in the rock any more. Driven off the held set rather than
    // off key events, so holding a bracket is a continuous swing rather than a
    // stutter at the OS repeat rate.
    //
    // `heldKeys`, not `held`: this reads key *codes*, and `held` has carried
    // rebindable action ids since spec 125 -- which is what left these two keys
    // dead for eleven specs (spec 140).
    const swing = orbitStep(heldKeys, elapsed / 1000);
    if (swing !== 0) scene.controls.orbitBy(swing);

    const view = client.view();
    ingestChunks(view, now);
    stepNavWarm(now);
    updateLoading(view);
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
      // What an authored unit's state machine advances by (spec 111). The whole
      // steps this frame actually drained, so an event lands on the same machine
      // tick whether the browser painted at 30fps or at 144 -- `dt` above cannot
      // say that and never could.
      ticks,
      alpha,
      tick: drawnTick,
      selfFacing: facing,
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

    hud.update(
      view,
      scene.screenAnchors(),
      drawnTick,
      client.correctionCount,
      targetId,
      {
        abilityId: pendingAim?.abilityId ?? order?.abilityId ?? null,
        pending: pendingAim !== null,
      },
      // What the cursor is over, for the drop's name (spec 158).
      scene.hoveredEntityId,
      now,
    );
    // The cursor says what the next click would do (spec 158).
    //
    // Only a drop changes it, and only because a drop is the one thing in the
    // world the cursor *does* something to that has no other affordance: a
    // monster lights up when hovered, a window has a border, and an item on the
    // ground has neither -- the pointer is what tells you it can be clicked at
    // all. Presentation, and the only `if` in this file that touches a style.
    canvas.style.cursor = hoveringDrop(client.view(), scene.hoveredEntityId) ? 'pointer' : '';
    // Read back off the interface rather than remembered from the press
    // (spec 140), so a window opened by a key lights its button too.
    hud.showOpenWindows(ui.opened());

    // Last, so what it reports is a whole frame's work rather than the part of
    // one that happens before the world is drawn (spec 165). `stats()` is only
    // computed when somebody is looking -- the sort over the window is cheap but
    // it is not free, and a meter that costs frame time misreports the frame
    // time it costs.
    fpsOverlay.set(showFps ? frames.stats() : null);

    // Where the view is looking from and how wide it frames, for the probes.
    // They used to read the Orbit and Zoom sliders, and on a phone the panel
    // those live in is not in the document at all now (spec 140) -- so the two
    // gestures that write them would be checkable everywhere except on the
    // device they exist for. Invisible, like every other `data-` handle here;
    // it is not a readout.
    const camera = `${scene.controls.orbitDegrees().toFixed(2)}|${scene.controls.viewHalfWidth().toFixed(2)}`;
    if (camera !== lastCamera) {
      lastCamera = camera;
      const [orbit, zoom] = camera.split('|');
      root.dataset['cameraOrbit'] = orbit;
      root.dataset['cameraZoom'] = zoom;
    }

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

    publishUnitReadout();

    // Last, over everything (spec 131). It is handed `now` rather than reading
    // one: nothing under `src/ui/` may touch a clock, which is what makes an
    // input replay of this interface exact rather than approximate.
    ui.update(view, now);
    publishUiReadout();

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
      root.addEventListener('wheel', onWheel, { capture: true, passive: false });
      document.documentElement.addEventListener('contextmenu', onContextMenu);

      // Exactly once, and here rather than at construction: `start()` is what
      // the shell calls when this tab becomes visible, and a Hello sent twice
      // on one socket used to spawn a second body and orphan the first.
      if (plan.mode === 'remote') {
        // On *every* welcome rather than in the `.then()` of this first one
        // (spec 157). The server mints a fresh token per welcome, so writing it
        // once left storage holding a stale one after any reconnect -- and the
        // next reload of the tab was then a fresh login rather than a resume.
        client.onWelcome(() => {
          // Kept for the next load of this tab, so a refresh is a resume
          // rather than a second body beside the first (spec 150).
          rememberSession(sessionStorage, client.sessionToken);
        });
        // The heartbeat and the backoff, on a clock a hidden tab cannot stop.
        keepAlive = window.setInterval(() => {
          client.keepAlive();
          backoffTick += KEEPALIVE_TICKS;
          reconnecting?.deliver(backoffTick);
        }, KEEPALIVE_MS);
        void client.connect().catch((error: unknown) => {
          banner.refuse(error instanceof Error ? error.message : String(error));
        });
      } else {
        void client.connect();
      }

      last = 0;
      accumulator = 0;
      raf = requestAnimationFrame(frame);
    },
    stop(): void {
      cancelAnimationFrame(raf);
      if (keepAlive !== 0) {
        window.clearInterval(keepAlive);
        keepAlive = 0;
      }
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('mouseleave', onLeave);
      root.removeEventListener('wheel', onWheel, { capture: true });
      document.documentElement.removeEventListener('contextmenu', onContextMenu);
      held.clear();
      heldKeys.clear();
      // A tab switched away mid-pinch must not leave fingers down.
      gestures.clear();
      interfaceFingers.clear();
      // The window that was hidden is not the window that comes back: every gap
      // across the pause would otherwise be averaged in as a frame that took a
      // minute (spec 165).
      frames.reset();
    },
  };
}
