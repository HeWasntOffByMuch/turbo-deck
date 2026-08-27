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
import { afflictionsFromQuery } from './affliction-vfx.js';
import { fieldsWantedByQuery } from './aura-vfx.js';

/**
 * How often `?afflict=` re-applies what it was asked for, in ticks (spec 215).
 *
 * Three seconds, and the number is chosen rather than picked. Two constraints
 * and they only leave a narrow band:
 *
 * **Inside the shortest window.** Burn is eight pulses of half a second, so it
 * is gone 241 ticks after it lands; anything past that and the paint lapses
 * while somebody is looking at it.
 *
 * **A common multiple of every pulse interval**, which is what 120 was not.
 * `applyStatus` refreshes rather than extends and deliberately does not move
 * `appliedAtTick`, so the *sim's* beat phase is unchanged by a refresh -- while
 * the client derives its own from the expiry, which a refresh does move. The
 * derived phase therefore shifts by `cadence mod intervalTicks` each time. The
 * table runs at 30, 45 and 60 ticks; 180 is a multiple of all three and 120 is
 * not, so at 120 Shock alone slid half an interval every three seconds and its
 * beat walked off the damage it is drawing. At 180 every row stays exactly in
 * step, which turns the header's stated post-refresh limit in
 * `affliction-vfx.ts` into something this path does not have to pay at all.
 *
 * It is also far enough apart that the re-application is not itself the thing
 * being watched: a status refreshed every tick has a beat phase that never
 * advances, which is precisely the half of this feature worth looking at.
 */
const FORCED_AFFLICTION_EVERY_TICKS = 180;
import { connectChannel } from '../../../server/net/transport-browser.js';
import { GameServer } from '../../../server/server.js';
import { planConnection, rememberAuthToken, rememberSession } from './connection.js';
import {
  ensureAuthToken,
  registerAccount,
  signInToAccount,
  signOutOfAccount,
  type CredentialOutcome,
} from './auth-client.js';
import { accountViewFrom, draftProblem, GUEST_STATE, type AuthState } from './account-model.js';
import type { AccountView } from '../../../ui/screens/account.js';
import { ReconnectingChannel } from '../../../server/net/reconnecting.js';
import { createConnectionBanner } from './connection-banner.js';
import { createGroundPredictor, emptyGround, fillGround } from './prediction-ground.js';
import type { Channel } from '../../../server/net/transport.js';
import type { WorldColliders } from '../../../sim/types.js';
import type { TerrainSampler } from '../../../server/world/terrain.js';
import { buildWorldFromMap } from '../../../server/world/build.js';
import { adoptNavGrid } from '../../../sim/pathfinding.js';
import {
  BROADCAST_EVERY_N_TICKS,
  MAP_CHUNK_REQUEST_RADIUS,
  SERVER_PLAYER_RADIUS,
  SERVER_TICK_RATE,
} from '../../../server/config.js';
import { abilityById, BASIC_ATTACK_ID } from '../../../server/data/abilities.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { CombatFlag } from '../../../server/net/messages.js';
import type { BaseStatKey } from '../../../server/state/types.js';
import { viewSeed } from '../seed.js';
import { DEFAULT_AUTHORED_UNITS, setAuthoredUnits, unitsFromQuery } from './unit-catalog.js';
import { ASSET_MANIFEST_HASH } from './unit-assets.js';
import { loadShippedMap } from '../map-asset.js';
import { StreamedMap } from '../../../server/client/streamed-map.js';
import type { HeldChunk } from '../../../server/client/map-cache.js';
import type { ViewHandle } from '../view-handle.js';
import { createWeatherControls } from '../weather-controls.js';
import { createVfxControls, VFX_DEFAULTS } from '../vfx-controls.js';
import { createWireControls } from '../wire-controls.js';
import { UnreliableChannel, type WireConditions } from '../../../server/net/unreliable.js';
import { parseWire } from '../../../server/net/wire-query.js';
import { Rng } from '../../../shared/prng.js';
import { orbitDrag, orbitStep } from './orbit-keys.js';
import { turnToward } from '../../../server/sim/movement.js';
import { facesAim } from '../../../server/sim/abilities.js';
import { createHud } from './hud.js';
import { ChunkIngest } from './chunk-ingest.js';
import { parsePerfFlags, parsePropRegionSize } from './perf-flags.js';
import { FrameBudget } from './frame-budget.js';
import { createMapWorker } from './map-worker-client.js';
import type { MapWorkerReply } from './map-worker-protocol.js';
import { LoadGate } from './loading.js';
import { createLoadingOverlay } from './loading-overlay.js';
import { CostMeter, FrameMeter } from './fps-meter.js';
import { createFpsOverlay } from './fps-overlay.js';
import { PROP_REGION_SIZE, propRegionSize, setPropRegionSize, type PropRect } from '../props.js';
import { orphanedPropRegions, propRegionHasGround } from './prop-residency.js';
import {
  abilityForSlot,
  actionBarFor,
  actionBarFromQuery,
  ACTION_BAR,
  sameBar,
  type ActionSlot,
} from './action-bar.js';
import { hudLayout } from './hud-layout.js';
import { isHandheldDevice } from '../device.js';
import { appearanceOf, bleedsFor } from './appearance.js';
import { weaponTypeFor } from './weapon-look.js';
import { effectsForBlow, REDUNDANT_SERVER_EFFECTS, type GoreLevel } from './vfx-wire.js';
import { createAudioEngine } from '../../audio/engine.js';
import { BUS_LABELS, BUSES } from '../../audio/events.js';
import { EMPTY_CATALOG, parseCatalog } from '../../audio/catalog.js';
import { loadMix, saveMix, withBus, withMaster, withMuted } from '../../audio/mix.js';
import { AudioDriver } from './audio-driver.js';
import { fieldStatusesOn } from './aura-vfx.js';
import { CastPhase } from '../../../server/sim/types.js';
import { TradeStageValue } from '../../../server/net/protocol.js';
import { HEAVY_ABILITY_DAMAGE } from '../../../server/sim/abilities.js';
import type { UiSoundId } from '../../../ui/core/sound.js';
import catalogUrl from '../../../../assets/audio/sfx.json?url';
import { moveIntent, RoutePlanner } from './intent.js';
import { pickupLead, pickupOrderFor } from './loot-drop.js';
import { PICKUP_RANGE } from '../../../server/sim/world.js';
import { decideControlDown, decideControlUp, type ControlDecision } from './control-actions.js';
import { pointerCode, wheelCode } from '../../../ui/input/actions.js';
import { UiLayer } from './ui-layer.js';
import { nearestVendorTo } from './shop-model.js';
import { InputMap, type Modifiers } from '../../../ui/input/input-map.js';
import { loadBindings, saveBindings } from '../../../ui/input/binding-store.js';
import {
  DEFAULT_SHOW_FPS,
  loadScale,
  loadMaxZoom,
  loadShowFps,
  resolveMaxZoom,
  saveScale,
  saveMaxZoom,
  saveShowFps,
} from '../../../ui/input/display-store.js';
import { SUPPORTED_MAX_VIEW_HALF_WIDTH } from '../view-settings.js';
import { loadLayout, saveLayout } from '../../../ui/core/layout-store.js';
import type { Rect } from '../../../ui/core/geom.js';
import { wheelNotches } from '../../../ui/core/events.js';
import { autoAttack } from './target.js';
import { windupLostItsMarkIn } from './withdraw.js';
import { aimShape, castOrder, startAim, type AimGesture, type AimOrder } from './aim.js';
import { worldCursor, worldMark } from './crosshair.js';
import { TouchGestures, type TouchSample } from './touch.js';
import { DEFAULT_HEADROOM, WorldScene, type AimIndicator } from './scene.js';
import { spawnerLabels } from './spawner-overlay.js';
import type { WorldAnchor } from './damage-popup.js';
import { XpGains } from './xp-gain.js';
import { castRefusalText } from './error-log.js';
import { backoffTicksFor, KEEPALIVE_MS } from './keepalive.js';

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
 * Finished chunks drawn into the scene per frame (spec 180).
 *
 * This used to bound the *meshing*, which was 3.4ms a chunk and the reason a
 * pump of arrivals was a visible lurch. Meshing is on the worker now and what is
 * left is 0.025ms of `BufferGeometry` per chunk plus a water quad -- so the
 * budget is no longer really about time. It is about the shape of the delivery:
 * a worker's replies arrive as one task on this thread's event loop, and one
 * arrival dirties five chunks, so a pump can hand back forty payloads between
 * two frames. This is what stops that being one frame's work.
 */
const ADOPT_BUDGET_PER_FRAME = 8;

/**
 * ...and how many while the loading screen is still up.
 *
 * Far more, because the constraint is different behind the gate: nothing is on
 * screen but a bar, and the load's *length* is what the player is waiting on.
 */
const ADOPT_BUDGET_LOADING = 64;

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
 * Chunks around the player that must arrive before the world is shown.
 *
 * The *whole request window*, deliberately -- everything this client is ever
 * going to ask for at this position (spec 165 follow-up 7).
 *
 * It used to be 2: the chunk the player stands in and the ring around it, on the
 * grounds that waiting for ground they cannot see is waiting for nothing. That
 * is true about what is *visible* and false about what it costs. The remaining
 * 144 chunks still arrived -- they just arrived after the gate lifted, into
 * frames that were being drawn, and every one of them cost an insert, five
 * builds, a mesh and eventually a prop rebuild. Fifteen seconds of stutter with
 * the world on screen, which is the report this follows.
 *
 * Loading is a thing a player understands and expects to wait for. A world that
 * keeps hitching for twenty seconds after it says it is ready is not.
 */
const READY_CHUNK_RADIUS = MAP_CHUNK_REQUEST_RADIUS;

/**
 * Prop regions rebuilt in one frame.
 *
 * One. A region is ~60ms of geometry construction, and the measured worst
 * streaming frame after load was 154ms with several landing together -- which is
 * a lurch a player feels while standing still. They settle in the same order
 * either way, a frame apart.
 */
const PROP_REGIONS_PER_FRAME = 1;

/** ...and while the loading screen is up, where a lurch costs nothing. */
const PROP_REGIONS_LOADING = 8;

/** How fast the streaming-cost readout falls back toward nothing. */
const INGEST_DECAY = 0.92;

/**
 * How long a prop region whose ground is still arriving waits before its trees
 * are drawn anyway (spec 180).
 *
 * The completeness rule handles the common case -- a leading-edge region
 * rebuilt once its whole ground is in, rather than once per column that reaches
 * it. What it cannot decide is ground that is declared and never coming: a chunk
 * outside the request radius arrives when the player walks toward it and not
 * before, and a region straddling that boundary would hold its trees for as long
 * as they stayed away. Four seconds is long enough that the rule wins every race
 * it can win and short enough that nobody stands in a bare field wondering.
 */
const PROP_INCOMPLETE_HOLD_MS = 4000;

/**
 * How much ground has to move before a fresh nav grid is worth building.
 *
 * Counted as **churn** since spec 215 -- chunks arrived plus chunks let go --
 * rather than as growth in the held set. Growth stopped being able to answer
 * the question the day spec 208 taught the client to forget: held bounded at 35
 * on the shipped map, this trigger fired *once* over a walk across it, and the
 * grid the client went on routing against was the one built over its spawn
 * point.
 *
 * A grid is ~190ms of obstacle passes and component flood whatever has changed,
 * so the question is not "has anything changed" but "has enough changed to be
 * worth building". That question survives moving the work off the thread --
 * cheaper is not free, and a grid per late chunk would keep one core busy for
 * the whole of a walk.
 *
 * The last chunks are not lost, only unhurried: the next grid that clears this
 * bar picks them up with everything else, and until then the standing one is a
 * prediction aid that the server's routing corrects.
 */
const GROUND_REFRESH_MIN_CHUNKS = 8;

/**
 * How long a chunk offered to the mesher may go unanswered before the ledger
 * gives up on it (spec 214).
 *
 * Ten seconds, which is far longer than a mesh has ever taken and is meant to
 * be: this is a backstop for a reply that is never coming, not a schedule for
 * one that is late. Sweeping a live chunk costs one extra prop rebuild;
 * sweeping too late costs nothing at all -- so the number errs long.
 *
 * What it protects is not the mesh, it is everything downstream of the count:
 * a chunk stuck in the queue holds every prop region it touches `inFlight` for
 * the session and keeps `ingest.pending` off zero, which is the condition both
 * the load gate and the first nav grid wait on.
 */
const MESH_TIMEOUT_MS = 10_000;

/**
 * How long a nav grid may be outstanding before another is allowed (spec 214).
 *
 * `navRequested` is a one-in-flight latch, and a latch with no way out is a
 * wedge: a reply that never arrives -- a worker that died, a message dropped on
 * a page that was backgrounded mid-build -- leaves the client routing and
 * predicting against the last grid it managed to adopt, for as long as the
 * session lasts. A generation counter already refuses a stale grid that lands
 * late, so the only cost of re-arming early is one extra build.
 *
 * Thirty seconds: the slowest measured grid on the shipped map is a first one
 * at 3.7 seconds, so this is most of an order of magnitude of headroom.
 */
const NAV_REPLY_TIMEOUT_MS = 30_000;
/** Never advance more than this many ticks in one frame, after a long pause. */
const MAX_CATCH_UP_TICKS = 10;
/** Ms between deltas -- the interval the renderer interpolates across. */
const DELTA_MS = TICK_MS * BROADCAST_EVERY_N_TICKS;

export async function mountWorld(container: HTMLElement): Promise<ViewHandle> {
  /**
   * The shipped map, fetched rather than bundled (spec 203).
   *
   * Awaited here and nowhere deeper: everything below is synchronous from
   * `buildWorldFromMap` through `warmRouting`, `fillGround` and the transport,
   * and threading a promise into that would be a rewrite of the whole function.
   * The mount boundary is the one place a wait costs nothing but a frame.
   *
   * Fetched on the remote path too, even though only a loopback tab builds a
   * world from it: the manifest's `mapId` is how this tab tells the server it
   * is on the same document, and a client that skipped the fetch could not make
   * that comparison at all.
   */
  const shippedMap = await loadShippedMap();
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
  const plan = planConnection(
    location.search,
    location,
    // Per tab: which body this one drives, and the token that resumes it.
    sessionStorage,
    () => crypto.randomUUID(),
    // Per person: the account session, read from where it is written.
    localStorage,
  );

  /**
   * Sign in before dialling, so a server that authenticates will talk to us
   * (spec 226).
   *
   * `POST /api/auth/guest` asks for nothing and hands back a character, which
   * is what makes "play without registering" true in the client rather than
   * only in the API. Awaited here because `Hello` carries the token and the
   * socket is opened a few lines below.
   *
   * A failure is **not** fatal and does not stop the connection: a server with
   * no auth gate ignores the token entirely, and one that wanted it refuses the
   * `Hello` itself with a message the banner already knows how to show. Trying
   * anyway is what keeps this compatible with a server that predates it.
   */
  // A `?server=` value that was not one of the four schemes is dropped and the
  // page's own origin used instead (spec 226). Said out loud, because the
  // silent version is a tab that connects somewhere nobody asked for.
  if (plan.mode === 'remote' && plan.ignoredServerValue !== '') {
    console.warn(
      `[net] ignored ?server=${plan.ignoredServerValue} -- it must start with ws://, wss://, http:// or https://. ` +
        `Connecting to ${plan.url} instead.`,
    );
  }

  let authToken = plan.mode === 'remote' ? plan.authToken : '';
  /**
   * What the account window is showing (spec 226).
   *
   * Held here rather than in the screen, because it is a fact about the
   * *session* and the screen's rule is that it renders what it is handed.
   */
  let authState: AuthState = GUEST_STATE;
  if (plan.mode === 'remote') {
    const signedIn = await ensureAuthToken(plan.httpOrigin, plan.authToken, localStorage);
    if (signedIn.ok) {
      authToken = signedIn.token;
      // A stored token the server recognised says who it belongs to, which is
      // how a returning account holder's window opens with their name on it
      // rather than telling them they are a guest.
      if (signedIn.identity?.kind === 'account') {
        authState = { ...authState, signedInAs: signedIn.identity.displayName };
      }
    } else console.warn(`[net] could not sign in: ${signedIn.reason}`);
  }

  /**
   * Where an account update goes once there is an interface to put it in.
   *
   * A sink assigned after the mount rather than a direct call on `ui`, which is
   * declared several hundred lines below this: reaching it from here would be a
   * temporal dead zone the moment anything called `setAuthState` early. Null
   * until then, and nothing does call it early -- every caller is a button.
   */
  // A box rather than a bare `let`: assigned only below the mount, TypeScript
  // narrows a nullable binding to `null` for every reader above it.
  const accountSink: { push: ((view: AccountView) => void) | null } = { push: null };
  const setAuthState = (next: AuthState): void => {
    authState = next;
    accountSink.push?.(accountViewFrom(next));
    /**
     * What a browser harness can ask about the account (spec 226).
     *
     * Published from the state the window is *given* rather than from what was
     * clicked, so a registration that failed reads as a guest -- the same rule
     * `data-held-weapons` follows about publishing what is attached rather than
     * what was wanted. `scripts/probe-account.ts` is the only reader; the whole
     * of this state is closure variables in this file, which is exactly why a
     * probe has nothing else to ask.
     */
    root.dataset['account'] =
      `${next.signedInAs ?? 'guest'}|${next.busy ? 'busy' : 'idle'}|` +
      // Whether this tab has anywhere to sign in *at all*. A window whose
      // buttons reach nothing is the failure this repository keeps finding --
      // a complete screen beside a mount that never wired it up -- and it is
      // invisible from a screenshot, because the form looks identical either
      // way. `local` is the honest answer for single player.
      `${plan.mode === 'remote' ? 'remote' : 'local'}`;
  };

  /**
   * Run one auth request, with the busy flag and the failure path in one place.
   *
   * The three callbacks differ only in which endpoint they call and what a
   * success means, so everything else -- refusing to overlap, storing the
   * rotated token, reporting the server's own words on a refusal -- lives here
   * and cannot be got right in two of the three.
   */
  const runAuth = async (
    request: () => Promise<CredentialOutcome>,
    succeeded: (outcome: Extract<CredentialOutcome, { ok: true }>) => {
      message: string;
      tone: AuthState['tone'];
      signedInAs: string | null;
      reload: boolean;
    },
  ): Promise<void> => {
    // A second press while one is in flight would race two claims of the same
    // guest -- which the server refuses correctly, and which would still put a
    // confusing refusal on screen.
    if (authState.busy) return;
    setAuthState({ ...authState, busy: true, message: 'Talking to the server…', tone: 'neutral' });

    const outcome = await request();
    if (!outcome.ok) {
      // The server's own sentence, which is written for the person who typed
      // the form. Inventing a second wording here would be a worse copy of it.
      setAuthState({ ...authState, busy: false, message: outcome.reason, tone: 'bad' });
      return;
    }

    // Stored before anything else: the credential this browser holds is the
    // only thing that reaches the character, and a reload below must find it.
    authToken = outcome.token;
    rememberAuthToken(localStorage, outcome.token);

    const result = succeeded(outcome);
    setAuthState({
      signedInAs: result.signedInAs,
      // Left busy through a reload, so the window cannot be pressed again in
      // the moment between asking for one and getting it.
      busy: result.reload,
      message: result.message,
      tone: result.tone,
    });
    if (result.reload) location.reload();
  };


  /**
   * The bundled map -- built for single-player, and for nothing else (spec 146).
   *
   * A remote client does not read this file at all now. Its ground arrives as
   * `MapInfo` plus chunks and its colliders grow with them, which is both the
   * only correct answer for a server on a map nobody bundled and the only way
   * that path is ever exercised: used whenever the two happened to agree, it
   * would be a path that only runs in the case it is broken in.
   */
  const local = plan.mode === 'loopback' ? buildWorldFromMap(shippedMap.doc, shippedMap.mapId) : null;
  // Same reason as the server (spec 130): sampling the ground into a nav grid is
  // around a second on a real map, and it belongs beside the rest of the page's
  // start-up rather than in the frame where the first move order is given. The
  // streaming client's equivalent is on the settle in `ingestChunks`, which is
  // the earliest moment it could possibly be done.
  //
  // There used to be a `warmRouting(local)` here, and spec 165's follow-up spent
  // real effort making it blocking again: the sim reached `navGridFor` inside
  // `routeToward`, so a world-sized grid had to exist before the first tick, and
  // slicing the build across frames made the wall-clock cost of loading a
  // function of the frame rate -- five seconds of work became thirty of waiting
  // on a slow machine.
  //
  // Spec 205 deleted the thing being warmed. Nav is windows now, and a window is
  // built inside the tick that first wants one: ~140ms of sampling for one
  // player's surroundings rather than 3.6s for the world, on a map where the
  // window does not grow when the map does. There is nothing left to have ready.

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
  /**
   * The afflictions `?afflict=` asks for (spec 215), as ordinals into `ALL_DOTS`.
   *
   * Loopback only, and not by omission: this drives `triggerEvent`, which is the
   * server's own developer path, and over a socket there is no server on this
   * thread to ask. A remote session that wants one uses the admin console, which
   * is where an operator's authority already lives.
   */
  const forcedAfflictions = server === null ? [] : afflictionsFromQuery(location.search);
  /**
   * When the forced afflictions are topped up again.
   *
   * They have to be, and that is the honest shape of the thing rather than a
   * shortcut: the longest row in the table runs ten seconds and the shortest
   * four, so a one-shot application would be a feature you had to reload the
   * page to look at twice. Re-applied on a cadence comfortably inside the
   * shortest window, at the player's own position, so walking somewhere else
   * takes the paint with you and whatever you walk up to gets it too.
   */
  let afflictAgainAtTick = 0;
  /**
   * Whether `?field=` asks for an aura field on the player (spec 223).
   *
   * Loopback only, exactly as the afflictions above are and for the same stated
   * reason. Topped up on the same cadence, which is comfortably inside the
   * eight seconds `FIELD_DEMO_TICKS` grants -- so the ring stays up while
   * somebody walks around under it rather than going out mid-look.
   */
  const forcedField = server === null ? false : fieldsWantedByQuery(location.search);
  let fieldAgainAtTick = 0;
  let wireConditions: WireConditions = parseWire(new URLSearchParams(location.search).get('wire'));
  const wire = new UnreliableChannel(channel, () => wireConditions, Rng.fromSeed(seed));

  const client = new GameClient(wire, {
    playerId: plan.mode === 'remote' ? plan.playerId : 'you',
    displayName: plan.mode === 'remote' ? plan.displayName : 'You',
    // A token from this tab's last load, so a reload comes back to the same
    // body rather than spawning a second one beside it (spec 150).
    ...(plan.mode === 'remote' ? { resumeToken: plan.resumeToken } : {}),
    // Who this tab signed in as (spec 226). A server with an auth gate reads
    // the player off this and ignores `playerId` above; one without ignores
    // this instead, which is why the loopback path never sets it.
    ...(authToken === '' ? {} : { authToken }),
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
  function syncPathWorld(): void {
    const { colliders, terrain } = ground;
    pathWorld =
      colliders && terrain
        ? { colliders, radius: SERVER_PLAYER_RADIUS, ground: terrain }
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
  // `?perf=noshadow,noprops,noterrain,noworker` -- a measuring affordance, not a
  // setting. See perf-flags.ts for why the frame is being taken apart this way.
  const perfFlags = parsePerfFlags(location.search);
  scene.setPerfFlags(perfFlags);
  // Before a single prop is bucketed (spec 195), and before the worker is told
  // about the map -- the size rides that message, so both threads agree by
  // construction rather than by both happening to read the same URL.
  setPropRegionSize(parsePropRegionSize(location.search) ?? PROP_REGION_SIZE);
  let streamed: StreamedMap | null = null;
  /**
   * The meshing queue and the prop-region bookkeeping (spec 165).
   *
   * Both used to be implicit in the loop below -- mesh everything that arrived,
   * rebuild every prop after two quiet frames -- and both were sized for a map a
   * quarter of this one's size. See chunk-ingest.ts.
   */
  const ingest = new ChunkIngest({
    settleMs: PROP_SETTLE_MS,
    regionSize: propRegionSize(),
    regionsPerFlush: PROP_REGIONS_PER_FRAME,
    incompleteHoldMs: PROP_INCOMPLETE_HOLD_MS,
    meshTimeoutMs: MESH_TIMEOUT_MS,
  });
  /**
   * Where the load actually happens (spec 180).
   *
   * Replies land in an inbox rather than being acted on where they arrive: a
   * message is delivered as a task on this thread's event loop, so adopting
   * inside the handler would put an unbounded amount of scene-graph work
   * between two frames -- the exact shape spec 165 spent ten follow-ups
   * removing, rebuilt on the other side of the boundary.
   *
   * `?perf=noworker` runs the identical core on this thread, which is how the
   * two are compared on one machine.
   */
  const meshInbox: MapWorkerReply[] = [];
  const propInbox: MapWorkerReply[] = [];
  const navInbox: MapWorkerReply[] = [];
  const mapWorker = createMapWorker(
    (reply) => {
      if (reply.kind === 'mesh') meshInbox.push(reply);
      else if (reply.kind === 'props') propInbox.push(reply);
      else navInbox.push(reply);
    },
    { threaded: !perfFlags.noWorker },
  );
  /**
   * Prop regions asked for and not yet on screen (spec 181).
   *
   * The load gate reads it, and it has to: `takePropRects` empties itself when
   * the rectangles are *taken*, which used to be the same instant they were
   * drawn because the rebuild was synchronous. It is not any more, and a gate
   * counting only what is still queued would lift over a world whose trees are
   * still being composed.
   *
   * `takePropRects` returns one rectangle per region, so this counts regions.
   */
  let propsInFlight = 0;
  /**
   * Chunks the server has sent that this client has not inserted yet.
   *
   * Keyed by coordinate, because `client.view()` hands back the whole held set
   * every frame: without this the same arrival would be queued again on every
   * frame until the budget got to it.
   */
  const pendingInserts = new Map<string, HeldChunk>();
  const gate = new LoadGate();
  const loading = createLoadingOverlay(root);
  /** The load as the overlay last drew it, so the DOM is written only on change. */
  let lastLoadLabel = '';
  /** Whether the remote path has built its collision ground and nav grid once. */
  let firstGroundBuilt = false;
  /**
   * The store's churn when a nav grid was last asked for (spec 215).
   *
   * Churn rather than the held count, because the held count is bounded now and
   * a bounded number cannot say how much has changed. Measured on a walk over
   * the shipped map: with the count pinned at 35 this trigger fired **once** in
   * a session, and the grid the client kept describes the ground it spawned on.
   */
  let chunksAtGroundRefresh = -1;
  /** Whether a grid is being built right now, so only one is ever in flight. */
  let navRequested = false;
  /** When that request went out, so a reply that never comes is not forever. */
  let navRequestedAtMs = 0;
  /**
   * The chunk count of the newest grid adopted.
   *
   * A grid takes long enough that chunks keep arriving while it is built, so a
   * reply answers for the world as it was. Without this a slow grid lands on
   * top of a newer one and the client routes against ground that has changed.
   */
  let navGeneration = -1;
  let navAsked = 0;
  let navAdopted = 0;
  let navStale = 0;
  /** The last published mesh readout, so the DOM is written only on change. */
  let lastMeshState = '';
  /**
   * Every chunk coordinate the scene has actually been given.
   *
   * Distinct, so it can be compared against the number the streamed map holds.
   * See the readout in {@link updateLoading} for why that comparison matters.
   */
  const drawnChunks = new Set<string>();
  /**
   * Prop regions composed and then not drawn, because their ground had gone
   * (spec 215).
   *
   * A readout rather than an input -- nothing branches on it -- kept for the
   * reason `ChunkIngest.abandonedCount` is kept: a compose thrown away is work
   * this client paid for and a picture nobody saw, and a number is what makes
   * that visible rather than something to be inferred from a bare field. It
   * counts the in-flight race the guard exists for *and* the neighbour regions
   * `propRegionKeysIn` hands the worker on a region-aligned rectangle, which is
   * why it is not expected to be zero.
   */
  let propsRefused = 0;

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
  /**
   * What advancing the simulation costs the frame (spec 192).
   *
   * The one number the meter could not produce and the one the frame graph most
   * needed: single-player is a whole server on this thread, so `server.tick()`
   * is frame time, and a tick that got more expensive arrives as a picket fence
   * rather than as a stall -- below 60fps the accumulator drains one tick on
   * some frames and two on others. Reading the graph alone, that is
   * indistinguishable from a renderer that got slower.
   *
   * Measured on a socket too, where there is no server here to time: what is
   * left is the predictor, which walks the same colliders per predicted tick and
   * replays its whole input buffer on a correction. That half never leaves this
   * thread, so a reading of zero would be a lie about the remote path.
   */
  const simCosts = new CostMeter();
  const simTicks = new CostMeter();
  /** The frame's JavaScript, either side of the first draw call (spec 194). */
  const prepCosts = new CostMeter();
  const drawCosts = new CostMeter();
  /**
   * The streaming cost of recent frames, decayed rather than averaged.
   *
   * A spike has to stay legible long enough to read -- at the frame rates this
   * is diagnosing, an instantaneous number is gone before the eye lands on it --
   * and it has to fall back to nothing once the world has settled, or the
   * readout would claim the loader is still working when it is not.
   */
  let worstIngestMs = 0;
  /**
   * Which stage of the ingest was the worst one recently, and how bad.
   *
   * Named rather than summed, because "the loader cost you 150ms" and "the
   * *props* cost you 150ms" are one question apart, and guessing which stage it
   * was cost three build-and-measure rounds that a label would have answered
   * outright.
   */
  let worstStage = '';
  let worstStageMs = 0;
  function stage(name: string, ms: number): void {
    if (ms <= worstStageMs) return;
    worstStageMs = ms;
    worstStage = name;
  }
  const fpsOverlay = createFpsOverlay(root);
  let showFps = DEFAULT_SHOW_FPS;

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
      // The worker builds its own store from the same `MapInfo` (spec 180).
      // Both sides are then fed the same chunks in the same order, and neither
      // is authoritative over the other -- this side answers `heightAt` now,
      // that side answers what the ground looks like later.
      mapWorker.send({ kind: 'map', info: map.info, propRegionSize: propRegionSize() });
      // Reported, not acted on (spec 146). Under 144 a mismatch turned
      // prediction off, because the alternative was colliding against a forest
      // the server did not have; now the colliders come from the stream either
      // way and this is just a useful thing to see in a screenshot.
      if (plan.mode === 'remote' && map.info.mapId !== shippedMap.mapId) {
        banner.note(`server map ${map.info.mapId.slice(0, 8)}`);
      }
    }

    // Still budgeted, even though this side no longer builds anything: the
    // insert is 0.1ms and forwarding is a `postMessage`, but `client.view()`
    // hands back the whole held set every frame and a cold start delivers 169
    // of them. A budget here is what keeps that a stream rather than one frame.
    for (const held of map.chunks) {
      if (streamed.has(held.layer, held.cx, held.cz)) continue;
      pendingInserts.set(`${held.layer}:${held.cx},${held.cz}`, held);
    }

    // Ground the cache has let go of (spec 208).
    //
    // Reconciled against the cache's held list rather than being told, because
    // the cache is what decides residency and a message saying "these went"
    // would be a second description of the same fact -- one that can be dropped,
    // leaving geometry drawn over ground nothing holds. Comparing is O(held),
    // and held is bounded by exactly the thing this pass enforces.
    const live = new Set<string>();
    for (const held of map.chunks) live.add(`${String(held.layer)}:${String(held.cx)},${String(held.cz)}`);
    const stale = streamed
      .heldRefs()
      .filter((ref) => !live.has(`${String(ref.layer)}:${String(ref.cx)},${String(ref.cz)}`));
    if (stale.length > 0) {
      const { removed, restitch } = streamed.remove(stale);
      for (const ref of removed) {
        const key = `${String(ref.layer)}:${String(ref.cx)},${String(ref.cz)}`;
        pendingInserts.delete(key);
        // The ledger too (spec 215). `drawnChunks` is what `data-chunks-drawn`
        // publishes, and spec 208 left it growing for the session -- so it
        // counted chunks *ever* drawn against chunks *now* held, and
        // `probe-streaming.ts`'s one invariant, `drawn >= held`, quietly became
        // satisfiable by anything. Pruned here it means "drawn and still held"
        // and the check has its teeth back.
        drawnChunks.delete(key);
        const layerId = streamed.meshLayers[ref.layer]?.id;
        if (layerId !== undefined) scene.dropTerrainChunk(layerId, ref.cx, ref.cz);
      }
      // The neighbours are stitched to ground that has gone, so they are dirty
      // in exactly the sense an arrival makes its neighbours dirty.
      if (restitch.length > 0) ingest.offer(restitch, nowMs);
      // The height memo held samples over ground this side no longer has
      // (spec 153), the same reason an insert invalidates it.
      scene.invalidateGroundSamples();
      mapWorker.send({ kind: 'evict', refs: stale });

      // The trees standing on it (spec 215).
      //
      // Reconciled against the *field's own* region list rather than derived
      // from the chunks that just went, for the reason the terrain reconcile
      // above is written the same way: a region only loses its last ground when
      // a chunk in it is removed, so the two are the same set today -- and
      // reading what is actually on the scene graph is the version that stays
      // right if a region ever arrives by some other path. It is O(regions
      // held), and regions held is bounded by exactly the thing this enforces.
      //
      // Ground rather than a radius of its own: a region is drawn because
      // something under it is held, so it is dropped when nothing is. That is
      // what makes this unable to fight the streamer without deriving a second
      // keep distance -- the trees cannot go while their ground is there, and
      // cannot be asked for before it arrives, because both read one held set.
      const ground = streamed;
      const holds = (rect: PropRect): boolean => ground.holdsAnyIn(rect);
      for (const key of orphanedPropRegions(scene.heldPropRegions(), holds)) {
        scene.dropPropRegion(key);
      }
      // ...and nothing is owed for ground that has gone. Over the ingest's own
      // ledger rather than over what was just dropped, because a region whose
      // ground arrived and went inside one settle period was never drawn and so
      // was never dropped -- and it is the one still waiting to be composed.
      ingest.forgetRegions((key) => !propRegionHasGround(key, holds));
    }

    const insertStart = performance.now();
    const spend = new FrameBudget(nowMs, INGEST_BUDGET_MS);
    for (const [key, held] of pendingInserts) {
      if (spend.spent()) break;
      pendingInserts.delete(key);
      // One arrival, but up to five chunks to draw: a neighbour's mesh was baked
      // against ground this chunk has only now supplied (spec 078). The worker
      // works the same dirty set out from its own store; this side computes it
      // to keep the ledger and the prop regions, which is 0.1ms against the
      // 3.4ms a build is (spec 180).
      const dirty = streamed.add(held);
      // Forwarded whether or not it dirtied anything here (spec 214). The two
      // stores are only the same world because they are fed the same chunks:
      // skipping the send for a chunk this side declined to insert -- an unknown
      // layer, a refused `insertChunk` -- leaves the worker's store short of
      // ground it would otherwise have had, permanently, and the nav grid and
      // the prop regions it builds are then of a map nobody is playing. The
      // worker takes a duplicate as a no-op, which is the cheap side of the
      // trade.
      mapWorker.send({ kind: 'chunk', held });
      if (dirty.length === 0) continue;
      ingest.offer(dirty, nowMs);
      // The memo is over the ground this chunk just changed. Everything it
      // holds near here was sampled over a hole (spec 153), and it is
      // invalidated on the *insert* rather than when the triangles come back,
      // because the memo is about the store and the store has this ground now.
      scene.invalidateGroundSamples();
    }

    stage('insert', performance.now() - insertStart);

    // Whatever the worker has finished, up to a budget.
    //
    // Budgeted even though adopting is 0.025ms of three.js: a burst arrives as
    // one task on this thread's event loop, and one chunk dirties five, so a
    // pump of arrivals can hand back forty payloads at once. What is *not* done
    // here is dropping the overflow -- the inbox keeps it. `takeMesh` used to
    // dequeue what it returned, and a caller that dropped part of that list
    // left a hole in the world that never filled in (spec 165 follow-up 4);
    // this is the same trap on the other side of a thread boundary.
    const meshStart = performance.now();
    const adoptBudget = gate.open ? ADOPT_BUDGET_PER_FRAME : ADOPT_BUDGET_LOADING;
    let adopted = 0;
    while (meshInbox.length > 0 && adopted < adoptBudget) {
      const reply = meshInbox.shift();
      if (!reply || reply.kind !== 'mesh') continue;
      adopted++;
      if (!scene.adoptTerrainChunk(reply.footprint, reply.arrays)) continue;
      ingest.complete(reply.layer, reply.cx, reply.cz, nowMs);
      drawnChunks.add(`${reply.layer}:${reply.cx},${reply.cz}`);
    }
    stage('mesh', performance.now() - meshStart);

    // Props wait for the stream to go quiet rather than rebuilding per chunk.
    // One instanced mesh per species over the whole map is a few draw calls;
    // one per chunk would be two hundred of them on every frame from then on.
    //
    // What changed in 165 is the *unit*: the regions the arrived ground
    // actually covers, not the whole field. What changed in 176 is the
    // *condition*: a region also waits until every chunk the map declares over
    // it has arrived, because a leading-edge region was otherwise rebuilt once
    // per column that reached it -- the same 34ms two to four times over.
    const propStart = performance.now();
    const held = streamed;
    const rects = ingest.takePropRects(
      nowMs,
      gate.open ? PROP_REGIONS_PER_FRAME : PROP_REGIONS_LOADING,
      (rect) => held.rectCovered(rect),
    );
    if (rects.length > 0) {
      propsInFlight += rects.length;
      mapWorker.send({ kind: 'props', rects });
    }
    // ...and hanging what comes back, which is the 4ms half of what a region
    // rebuild used to be. Budgeted for the same reason the meshes are: a burst
    // arrives as one task on this thread's event loop.
    const adoptRegions = gate.open ? PROP_REGIONS_PER_FRAME : PROP_REGIONS_LOADING;
    let adoptedRegions = 0;
    while (propInbox.length > 0 && adoptedRegions < adoptRegions) {
      const reply = propInbox.shift();
      if (!reply || reply.kind !== 'props') continue;
      adoptedRegions++;
      propsInFlight = Math.max(0, propsInFlight - 1);
      // Ground that went while this was being composed (spec 215). A region
      // asked for on one frame, evicted on the next and delivered on the one
      // after would be hung up *behind* the drop pass, and nothing would ever
      // take it down again -- the drop is driven by eviction, and this ground
      // has already been evicted. The same predicate the drop pass reads,
      // asked at the moment it would be drawn.
      if (!propRegionHasGround(reply.region, (rect) => held.holdsAnyIn(rect))) { propsRefused++; continue; }
      scene.adoptPropRegion(reply.region, reply.instances);
    }
    stage('props', performance.now() - propStart);

    // The ground the *predictor* stands on is a different question from the
    // trees, and it is now somebody else's work (spec 180).
    //
    // It used to ride the prop settle, which fired dozens of times once the
    // settle became per region -- each one a ~190ms `createNavGrid` over 797k
    // cells, which is what "not smooth even standing still" was. Spec 165
    // answered that with three clocks: the whole world quiet, at least eight new
    // chunks, and at most one rebuild every five seconds. Two of those existed
    // only because the rebuild was a hitch on this thread, and the five-second
    // one was a stated compromise -- "a few seconds of staleness costs a
    // predicted path that walks at a tree". Off the thread there is nothing to
    // trade, so what is left is the one condition that was ever about
    // correctness: enough new ground to be worth a grid, and only one in flight.
    //
    // Not before the first one, which `updateLoading` asks for once the request
    // window is covered. Without that clause this fires the moment eight chunks
    // exist and spends the worker on a grid of a map that is one twentieth
    // arrived -- and then again at sixteen, and again at twenty-four, each one
    // queued behind the last, so the grid that matters arrives last.
    //
    // `navRequested` is a one-in-flight latch, and a latch is a wedge when the
    // reply can fail to arrive (spec 214). A worker that died, or a message
    // dropped on a page backgrounded mid-build, used to leave this client
    // routing and predicting against the last grid it managed to adopt for the
    // rest of the session. Re-arming costs at worst one extra build, and
    // `navGeneration` already refuses a stale grid that lands after it.
    if (navRequested && nowMs - navRequestedAtMs > NAV_REPLY_TIMEOUT_MS) navRequested = false;
    if (
      plan.mode === 'remote' &&
      firstGroundBuilt &&
      !navRequested &&
      streamed.revision - chunksAtGroundRefresh >= GROUND_REFRESH_MIN_CHUNKS
    ) {
      navRequested = true;
      navRequestedAtMs = nowMs;
      chunksAtGroundRefresh = streamed.revision;
      navAsked++;
      mapWorker.send({ kind: 'nav', radius: SERVER_PLAYER_RADIUS });
    }

    // ...and adopting what comes back, which is the whole of what it costs here.
    const navStart = performance.now();
    while (navInbox.length > 0) {
      const reply = navInbox.shift();
      if (!reply || reply.kind !== 'nav') continue;
      navRequested = false;
      // A grid answers for the world as it was when it started, and chunks kept
      // arriving. Older than what is already installed is not a smaller
      // improvement, it is a worse world: it would route around trees that have
      // since been joined by others and over ground that has since turned into a
      // hill.
      if (reply.generation <= navGeneration) { navStale++; continue; }
      navGeneration = reply.generation;
      navAdopted++;
      // The worker's colliders, not a fresh snapshot of our own: `navGridFor`
      // memoizes on identity, so the set the grid was graded against and the set
      // it is filed under have to be the same object. The *sampler* stays ours,
      // because the predictor asks it for heights synchronously.
      fillGround(ground, reply.colliders, streamed.sampler());
      syncPathWorld();
      adoptNavGrid(reply.colliders, streamed.sampler(), reply.grid);
    }
    stage('nav', performance.now() - navStart);
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

    // The remote path's first grid, asked for as soon as the ground is in.
    //
    // A remote client has no bundled map, so nothing pre-warms its colliders or
    // its nav grid the way `warmRouting` does at a loopback mount -- the first
    // build samples every nav cell over the declared map and then floods it,
    // which is ~5 seconds. Spec 165 found that landing a few hundred
    // milliseconds *after* the world was shown, and moved it in front of the
    // gate: terrain on screen and the tab locked solid was what "shows some
    // terrain early, but it's unresponsive" had been.
    //
    // The gate no longer waits for it (spec 180). It is on the worker, so the
    // five seconds are not a freeze and not a bar the player watches -- and
    // until it lands `RoutePlanner` reads a null world as "walk straight at it",
    // which is the same fail-safe the flat predictor is and is wrong only in the
    // direction the server quietly corrects.
    if (
      plan.mode === 'remote' &&
      !firstGroundBuilt &&
      streamed &&
      self &&
      coverage.needed > 0 &&
      coverage.held >= coverage.needed &&
      ingest.pending === 0
    ) {
      firstGroundBuilt = true;
      chunksAtGroundRefresh = streamed.revision;
      navRequested = true;
      navRequestedAtMs = performance.now();
      mapWorker.send({ kind: 'nav', radius: SERVER_PLAYER_RADIUS });
    }

    const progress = gate.progress({
      haveMap: view.map !== null,
      located: self !== null,
      held: coverage.held,
      needed: coverage.needed,
      // Prop regions count as outstanding work too: one rebuilt after the gate
      // opens is a ~170ms hitch in a world that has said it is ready, and behind
      // the screen it is just part of the load.
      meshPending: ingest.pending + ingest.dirtyRegionCount + propsInFlight,
      // Only this tab's own sim can stall on it; a remote client's grid is a
      // prediction aid and warms behind the world.
    });

    // How much ground has arrived against how much has actually been drawn
    // (spec 165 follow-up 4).
    //
    // *Distinct* chunks drawn, not meshes built: a chunk is re-meshed whenever a
    // neighbour lands, so counting rebuilds would sail past the number held and
    // say nothing. What has to hold is that every chunk the streamed map accepted
    // has been handed to the scene at least once. When it does not, the symptom
    // is a hole in the world that never fills in -- invisible to every headless
    // test, and easy to miss on screen unless you look the right way.
    //
    // A readout, not an input: nothing in the game reads these.
    const streamedCount = streamed?.size ?? 0;
    // Published from what is *attached* rather than from what was asked for, the
    // same rule `data-held-weapons` follows: a region composed and hung on
    // nothing should read as absent, which is the failure this number exists to
    // make visible (spec 215).
    const regionsDrawn = scene.heldPropRegions().length;
    // Bodies wearing an aura ring (spec 223), from the driver's held set rather
    // than from the statuses that asked for one -- so a ring refused by the
    // effect budget or evicted by the instance pool reads as absent.
    const aurasDrawn = scene.heldAuras().length;
    const meshState =
      `${streamedCount}:${drawnChunks.size}:${ingest.pending}:${regionsDrawn}` +
      `:${ingest.dirtyRegionCount}:${propsRefused}:${navGeneration}:${navAdopted}:${navStale}` +
      `:${aurasDrawn}`;
    if (meshState !== lastMeshState) {
      lastMeshState = meshState;
      root.dataset['chunksHeld'] = String(streamedCount);
      root.dataset['chunksDrawn'] = String(drawnChunks.size);
      root.dataset['chunksPending'] = String(ingest.pending);
      root.dataset['propRegions'] = String(regionsDrawn);
      root.dataset['propDirty'] = String(ingest.dirtyRegionCount);
      root.dataset['propRefused'] = String(propsRefused);
      root.dataset['auras'] = String(aurasDrawn);
      root.dataset['nav'] =
        `gen=${String(navGeneration)} asked=${String(navAsked)}` +
        ` adopted=${String(navAdopted)} refused=${String(navStale)}`;
    }

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
    const text = `${readout.loaded}:${readout.bones}:${readout.states}:${readout.held}`;
    if (text === lastUnitReadout) return;
    lastUnitReadout = text;
    root.dataset['authoredUnits'] = String(readout.loaded);
    root.dataset['authoredBones'] = String(readout.bones);
    root.dataset['authoredStates'] = readout.states;
    root.dataset['heldWeapons'] = readout.held;
  }

  /**
   * Mirrors the effects settings onto the root element (spec 182).
   *
   * Read back off the layer that acts on them rather than off the panel that
   * asked, which is the whole point: a button that lit up and reached nothing
   * publishes the old numbers. `data-held-weapons` is published from the bone
   * for the same reason (spec 165).
   */
  let lastVfxReadout = '';
  let lastAudioReadout = '';
  /**
   * Mirrors the audio engine's own numbers onto the root element (spec 229).
   *
   * `started` is what actually **started a voice**, not what was asked for, and
   * that is the whole point: every rule in this framework is green in Node
   * beside a mount that might call none of them -- the state spec 176 found map
   * markers in, with every test passing beside a tab that saved nothing. A
   * readout of what was requested would report a working game for a view that
   * requests and an engine that refuses.
   */
  function publishAudioReadout(): void {
    const stats = audioEngine.stats();
    const started = Object.entries(stats.started)
      .map(([id, count]) => `${id}=${String(count)}`)
      .sort()
      .join(',');
    const text = `${stats.state}:${String(stats.voices)}:${String(stats.held)}:${String(stats.buffers)}:${started}`;
    if (text === lastAudioReadout) return;
    lastAudioReadout = text;
    root.dataset['audioState'] = stats.state;
    root.dataset['audioVoices'] = String(stats.voices);
    root.dataset['audioHeld'] = String(stats.held);
    root.dataset['audioBuffers'] = String(stats.buffers);
    root.dataset['audioMissing'] = String(stats.missing);
    root.dataset['audioStarted'] = started;
  }

  function publishVfxReadout(): void {
    const readout = scene.vfxReadout();
    const playing = readout.effectIds.join(',');
    const text = `${readout.intensity}:${readout.gore}:${readout.particles}:${readout.decals}:${playing}`;
    if (text === lastVfxReadout) return;
    lastVfxReadout = text;
    root.dataset['vfxIntensity'] = String(readout.intensity);
    root.dataset['vfxGore'] = String(readout.gore);
    root.dataset['vfxParticles'] = String(readout.particles);
    root.dataset['vfxDecals'] = String(readout.decals);
    root.dataset['vfxStarted'] = playing;
  }

  /**
   * Mirrors what the body is committed to onto the root element (spec 199).
   *
   * The same window `publishUnitReadout` opens, for the same reason and read by
   * nobody in the game: what a stop drops lives as half a dozen closure `let`s
   * in this file, so a browser harness has nothing to ask about them -- and
   * `scripts/probe-stop.ts` is the only thing that can say whether the branch
   * this spec added reaches any of them. Two attributes rather than one, because
   * they answer different questions: `data-orders` is what has been *asked for*,
   * and `data-self-at` is whether the body is actually still moving, which is a
   * fact about the server rather than about this file's bookkeeping.
   *
   * Named in the vocabulary the spec's table uses, in a fixed order, so a
   * missing word is a specific drop that did not happen rather than a diff.
   * Written only when it changes: a per-frame attribute write is a per-frame
   * style invalidation, and a walking body writes one every frame anyway --
   * which is exactly why the position is rounded to a whole world unit here.
   */
  let lastOrders = '';
  function publishOrders(): void {
    const me = selfPosition();
    const orders = [
      destination !== null ? 'walk' : '',
      targetId !== null ? 'attack' : '',
      pickupId !== null ? 'pickup' : '',
      pendingAim !== null ? 'aim' : '',
      order !== null ? 'cast' : '',
      held.size > 0 ? 'keys' : '',
    ]
      .filter((word) => word !== '')
      .join(' ');
    const at = `${Math.round(me.x)},${Math.round(me.y)}`;
    const text = `${orders}|${at}`;
    if (text === lastOrders) return;
    lastOrders = text;
    root.dataset['orders'] = orders;
    root.dataset['selfAt'] = at;
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
    // The trade table (spec 134). In the key as well as the attributes: a trade
    // can change stage without moving a window or touching the bag, and the
    // ending changes only the reason.
    const tradeRects = boxes(readout.tradeRects);
    const trade =
      `${readout.tradeStage}|${readout.tradeReason}|${readout.tradeInvited}` +
      `|${readout.tradeYou}|${readout.tradeThem}`;
    // The chat (spec 189). In the key as well, because a line arriving changes
    // nothing else on this line -- and the whole claim the feature makes is
    // that a line somebody else said turns up on this screen.
    const chatRects = boxes(readout.chatRects);
    const chat = `${readout.chat.join(';')}|${String(readout.chatOpen)}|${readout.chatInput}|${chatRects}`;
    // The bar (spec 196) and the mini HUD beside it. Both are drawn to the
    // interface canvas, so neither has an element a harness could ask -- and
    // both are claims about *what is on screen* rather than about a number in a
    // model, which is the half a Node test cannot reach.
    const barSlots = boxes(readout.barSlots);
    const selectedRows = readout.selectedRows.join(';');
    const selected = `${readout.selected}|${selectedRows}|${readout.selectedRect ? 'shown' : 'hidden'}`;
    const text =
      `${windows}|${bag}|${readout.scale}|${readout.viewport.width}x${readout.viewport.height}` +
      `|${readout.tab}|${tabs}|${readout.scaleChoice}|${scales}|${cells}|${cellNames}|${frames}` +
      `|${trade}|${tradeRects}|${chat}|${barSlots}|${selected}`;
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
    root.dataset['uiTradeStage'] = readout.tradeStage;
    root.dataset['uiTradeReason'] = readout.tradeReason;
    root.dataset['uiTradeInvited'] = readout.tradeInvited;
    root.dataset['uiTradeYou'] = readout.tradeYou;
    root.dataset['uiTradeThem'] = readout.tradeThem;
    root.dataset['uiTradeRects'] = tradeRects;
    root.dataset['uiBarSlots'] = barSlots;
    root.dataset['uiSelected'] = readout.selected;
    root.dataset['uiSelectedRows'] = selectedRows;
    root.dataset['uiChat'] = readout.chat.join(';');
    root.dataset['uiChatOpen'] = String(readout.chatOpen);
    root.dataset['uiChatInput'] = readout.chatInput;
    root.dataset['uiChatRects'] = chatRects;
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
  /**
   * The bar `?slots=` forced, or null for "read it off the player's equipment"
   * (spec 188).
   *
   * An override rather than the only source: a skill is an item worn in one of
   * the four skill slots, so the ordinary bar is a view of the equipment and
   * changes when the player changes one. The query parameter stays because the
   * browser harnesses need to press an ability without looting a sigil for it
   * first.
   */
  const forcedBar = actionBarFromQuery(location.search);
  let actionBar: readonly ActionSlot[] = forcedBar ?? ACTION_BAR;
  const hud = createHud((x, y, lift) => scene.projectPoint(x, y, lift));
  /** The overlay's current box, so it is only rewritten when the letterbox moves. */
  let hudBox = { x: -1, y: -1, width: -1, height: -1 };
  // Picking a weapon is an ordinary equip (spec 079): the server puts it in the
  // hand, recomputes the stat block, and the new `basicAttackId` comes back on
  // `Stats`. Nothing here decides what the right-click then does -- the next
  // frame simply reads the stat and asks for whatever it names.
  hud.onEquip((itemId) => client.equip('mainHand', itemId));
  // The way back up (spec 164). The overlay is drawn from replicated health and
  // this is the only thing it does -- nothing on this side decides that a player
  // is alive again.
  hud.onRespawn(() => {
    // At the intent, like every other press (spec 229). The body coming back is
    // a round trip away and the button is the thing that was pressed.
    audioDriver.flat('player.respawn');
    client.respawn();
  });
  // The same call a key binding makes (spec 140). The button knows which window
  // it names and nothing else about what opening one costs.
  /**
   * Push the mix into the engine, into the page, and into storage.
   *
   * Declared as a function so it is hoisted above the `UiLayer` options that
   * call it -- `ui` does not exist yet when they are built, and it does by the
   * time any of them fires.
   */
  function applyMix(): void {
    audioEngine.setMix(audioMix);
    ui.setAudioMix(audioMix);
    saveMix(bindingStorage, audioMix);
  }

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
  /**
   * How much blood the effects panel is currently asking for (spec 182).
   *
   * Held out here because the panel is not built on a handheld and
   * `onCombatResult` is registered whatever the device -- a phone keeps
   * `VFX_DEFAULTS`, which is the same answer spec 140 gives for every other
   * setting in this corner. It is the *blow* this feeds, not the decal field:
   * that half was already wired and was never the half anybody could see.
   */
  let gore: GoreLevel = VFX_DEFAULTS.gore;
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
        gore = settings.gore;
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
    // How far down this corner is occupied, for the mini HUD docked under it
    // (spec 196). A marked element rather than a constant, exactly as
    // `data-hud-bottom` is: seven popovers of different heights wrap on a narrow
    // window, so where they end is a measurement and not a sum.
    buttons.dataset['hudRight'] = 'settings';
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

  /**
   * Experience, as gains rather than as a running total (spec 184).
   *
   * The arithmetic is pure and lives in `xp-gain.ts`; this is the memory it
   * needs between frames and nothing else.
   */
  const xpGains = new XpGains();
  /**
   * The last body this player killed, and where its number went.
   *
   * Cleared when it is spent, so a grant that arrives with no kill behind it --
   * an admin `AddExperience`, a quest one day -- cannot land on a corpse from
   * five minutes ago. It falls back to the player's own body instead, which is
   * the only other place a number about the player could honestly go.
   */
  let lastKill: { group: number; at: WorldAnchor } | null = null;

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
          killed: (result.flags & CombatFlag.Killed) !== 0,
          critical: (result.flags & CombatFlag.Critical) !== 0,
          blocked: (result.flags & CombatFlag.Blocked) !== 0,
          // An affliction's beat draws no blow at all (spec 219). It still
          // floats its number below, and its own paint is `affliction-vfx.ts`'s.
          periodic: (result.flags & CombatFlag.Periodic) !== 0,
          damageType: 'physical',
          x: target.x,
          y: BLOOD_HEIGHT,
          z: target.y,
          fromX: attacker?.x ?? target.x,
          fromZ: attacker?.y ?? target.y,
          // What the body is made of, rather than the `true` that was here:
          // hardcoded, a construct threw blood and `combat.hit.armored` was
          // unreachable for every blow in the game.
          bleeds: bleedsFor(target),
        },
        client.view().estimatedTick,
        gore,
      )) {
        scene.playEffect(request);
      }
    }
    // What a blow *sounds* like, decided in the same pure place and off the same
    // facts (spec 229). Beside `effectsForBlow` rather than folded into it: a
    // picture and a sound answer different questions about one event, and a
    // pulse is the case that proves it -- `effectsForBlow` draws nothing for one
    // and `soundsForBlow` refuses it too, but the affliction's own beat and its
    // own paint are two separate drivers.
    if (target) {
      audioDriver.blow({
        damage: result.damage,
        killed: (result.flags & CombatFlag.Killed) !== 0,
        critical: (result.flags & CombatFlag.Critical) !== 0,
        blocked: (result.flags & CombatFlag.Blocked) !== 0,
        periodic: (result.flags & CombatFlag.Periodic) !== 0,
        // The same answer the picture above got, from the same function -- so a
        // blow that throws sparks cannot also sound like a cut.
        bleeds: bleedsFor(target),
        x: target.x,
        y: scene.groundAt(target.x, target.y) + BLOOD_HEIGHT,
        z: target.y,
        onSelf: result.targetId === client.view().selfEntityId,
      });
    }
    // Where it landed, asked for now and never again (spec 096). The scene is
    // the better answer -- it knows the pose actually on screen, and it still
    // holds the body of something this very blow killed -- and the replica is
    // the fallback for a hit on a body no frame has drawn yet.
    const at = scene.bodyAnchor(result.targetId) ?? replicaAnchor(result.targetId);
    if (!at) return;
    hud.addDamage(result.targetId, at, result.damage, (result.flags & CombatFlag.Critical) !== 0);
    // Where the reward for this body will go, if there turns out to be one
    // (spec 184). Remembered rather than acted on, because the experience is not
    // in this message: the server grants it against the store and sends a whole
    // `Stats` some frames later, with nothing in it saying which kill it was
    // for. This is the client's half of that join -- the same anchor the damage
    // number was given, held until a total moves.
    if ((result.flags & CombatFlag.Killed) !== 0 && result.attackerId === client.view().selfEntityId) {
      lastKill = { group: result.targetId, at };
    }
  });
  client.onEffect((effect) => {
    // A self-heal reports itself twice: once as this message and once as the
    // negative-damage blow that draws the heal (spec 157). The registry holds
    // no entry under an ability's own id, so drawing this one too would put
    // `addEffect`'s orange debug disc under the green heal for half a second.
    if (REDUNDANT_SERVER_EFFECTS.has(effect.effectId)) return;
    // The id the server has always sent and this view has always dropped.
    scene.addEffect(effect.effectId, effect.x, effect.y, effect.radius, effect.durationTicks);
    // And what it sounds like (spec 229). This message is the **only** place an
    // ability id reaches the client at impact time -- `CombatResultMessage`
    // carries none, which is why `view.ts` has hardcoded `damageType:
    // 'physical'` for the picture since spec 121 -- so it is where an element's
    // impact comes from. `soundForEffect` answers null for anything that is not
    // an `.impact`, because a `.self` cue is the cast and the cast was heard at
    // the wind-up.
    audioDriver.serverEffect(effect.effectId, {
      x: effect.x,
      y: scene.groundAt(effect.x, effect.y) + BLOOD_HEIGHT,
      z: effect.y,
    });
  });
  /**
   * A wind-up begins (spec 229).
   *
   * `onCastStarted` has existed since spec 144 and had **no listener in the
   * shipped renderer** -- only in four tests -- so a live hook carrying the
   * ability id, the phase and all three ticks was fanning out to nobody.
   *
   * At the wind-up rather than at the contact, which is the point: this game is
   * built on a blow being long enough to read and withdraw from, and a sword
   * that makes no sound until it lands has no tell. `CastPhase.Windup` is 0 --
   * the backswing and the channel both re-announce themselves on this message
   * and must not each play the swing again.
   */
  client.onCastStarted((cast) => {
    if (cast.phase !== CastPhase.Windup) return;
    const caster = client.view().entities.find((entity) => entity.id === cast.entityId);
    if (!caster) return;
    const ability = abilityById(cast.abilityId);
    audioDriver.windup(
      cast.abilityId,
      (ability?.damage ?? 0) >= HEAVY_ABILITY_DAMAGE,
      {
        x: caster.x,
        y: scene.groundAt(caster.x, caster.y) + BLOOD_HEIGHT,
        z: caster.y,
      },
      // What it throws, so a bow is heard being drawn whatever ability drew it
      // -- the rule `unit-driver.ts` already picks the *animation* by.
      ability?.projectile?.look ?? null,
      // ...and what it is being swung with, for the one body whose weapon this
      // client knows. Equipment is replicated to its owner alone, so a monster
      // has none and another player's is not knowable: both fall to the
      // light/heavy pair, which is what those two rows exist for.
      cast.entityId === client.view().selfEntityId
        ? weaponTypeFor(client.view().equipment.mainHand)
        : null,
    );
  });
  client.onCastRejected((abilityId, reason) => {
    hud.error(castRefusalText(abilityById(abilityId)?.name ?? abilityId, reason));
    // A refusal is a refusal wherever it came from (spec 229). The same row the
    // interface's own `ui.error` plays, because from where the player is sitting
    // "the server said no" and "a rule said no" are one event.
    audioDriver.flat('ui.error');
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
    if (message.length > 0) audioDriver.flat('ui.error');
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
  /**
   * Key codes that were physically down when a stop fired (spec 199).
   *
   * The rule without which the stop does not work at all, and one no unit test
   * in this tree could have found, because it is a fact about the browser rather
   * than about the game: a key held down repeats `keydown` at the platform's own
   * rate, and `onKeyDown` has never looked at `event.repeat`. So every repeat
   * puts `move.north` straight back into {@link held}, and a player walking north
   * who asks to stop watches the walk resume on its own half a second later.
   *
   * A code goes in when the stop is applied and comes out when it is actually
   * released. It costs nothing anywhere else -- a repeat only ever re-adds what
   * its own first press already added -- and it catches the stop's own key first:
   * Space held down fires once rather than sending `cancelCast` thirty times a
   * second.
   */
  const disarmed = new Set<string>();
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

  // --- audio (spec 229) ---------------------------------------------------
  /**
   * The one `AudioContext` in the game, and the driver over it.
   *
   * `createAudioEngine` answers `SILENT_AUDIO` where there is no Web Audio, so
   * everything below takes a non-nullable engine and no call site carries a
   * `?.` -- the argument `src/ui/core/sound.ts` already makes about an optional
   * sink, and the reason `presentation-only.test.ts` can drive this whole layer
   * in Node.
   *
   * **Nothing is created here.** The context is constructed by the first
   * `resume()`, which `start()` arms off the first real input: a browser refuses
   * to make noise before somebody has interacted with the page, and a context
   * built anyway starts suspended and stays there in a way that is invisible
   * until a playtester says there is no sound.
   */
  const audioEngine = createAudioEngine();
  const audioDriver = new AudioDriver(audioEngine);
  let audioMix = loadMix(bindingStorage);
  audioEngine.setMix(audioMix);
  /**
   * The sound catalog, fetched rather than bundled.
   *
   * `?url` and a fetch, the convention `map-asset.ts` sets and `bundle-budget.ts`
   * enforces: a `?raw` import would compile the document into the bundle, which
   * is the regression that put 11.5 MB of map in `index-*.js`.
   *
   * A failure is silence and a line in the log, never a throw. The catalog is
   * presentation: a game that refused to start because a sound file was
   * unreadable would be a worse game than a quiet one.
   */
  void fetch(catalogUrl)
    .then(async (response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
    .then((text) => {
      const parsed = parseCatalog(text);
      if ('error' in parsed) {
        console.warn(`[audio] sfx.json: ${parsed.error}`);
        return;
      }
      audioEngine.setCatalog(parsed.catalog);
      // Two calls, and the order is the policy. The first names the buses that
      // fire in the first ten seconds of play, so the first footstep and the
      // first swing are not the two that are silent -- a cache miss plays
      // *nothing* rather than playing late, because a hit that arrives 200ms
      // after the blow is worse than one that did not arrive.
      //
      // The second puts everything else behind them in the same queue. That is
      // not "load it all at startup": one queue at a bounded concurrency, hot
      // buses first, and the game is playable throughout. What it buys is that
      // the first Ember Shot of a session makes a noise, which the browser
      // probe is what caught -- and it is affordable only because the bake is
      // 1.36 MB in total. If the library ever grows past what is reasonable to
      // fetch in the background, this second line is the one to take out.
      audioEngine.warm(['player', 'combat', 'ui']);
      audioEngine.warm(BUSES);
    })
    .catch((error: unknown) => {
      console.warn(`[audio] could not load sfx.json: ${error instanceof Error ? error.message : String(error)}`);
      audioEngine.setCatalog(EMPTY_CATALOG);
    });

  /**
   * A cue **name**, from a table that is not ours.
   *
   * Two seams reach this: the loot cues in `RARITIES[].cues` (spec 158, whose
   * rule is *"the renderer decides what a name sounds and looks like"*) and the
   * particle system's own `VfxHooks.sound`, whose comment has said *"a sink
   * today; there is no audio system to wire it to"* since spec 121. Both had
   * been complete at one end and connected to nothing at the other.
   */
  scene.onCue = (cue, x, y, z) => {
    audioDriver.cue(cue, { x, y, z });
  };

  /** What the interface emits into. `Widget.sounds` explains why it is one sink. */
  const uiSounds = { play: (id: UiSoundId): void => { audioEngine.play(id); } };

  /**
   * The level a `Stats` message last reported (spec 229).
   *
   * A level-up is a *difference*, exactly as an experience gain is (spec 184),
   * and it needs the same two rules for the same reasons: the **first reading
   * only establishes the baseline**, or logging in plays a level-up for the
   * level you already had; and a move **backwards re-baselines silently**,
   * because an admin `setLevel` is not a reward.
   */
  let lastLevel: number | null = null;
  /**
   * The trade stage last seen, so the two moments worth hearing can be found.
   *
   * A trade has no callback: it arrives as a `TradeView` on the frame like every
   * other replicated fact, so *being asked* and *it going through* are
   * transitions rather than events -- which needs the previous reading, exactly
   * as a level-up does. Null is "no trade", which is a stage in its own right
   * here: it is what the transition into `Offered` is measured from.
   */
  let lastTradeStage: number | null = null;

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
  // The widest zoom the player has asked for (spec 202), read once and applied
  // to the camera before the first frame -- a ceiling honoured only on the next
  // change would leave a restored session framing wider than it was told to.
  const storedMaxZoom = loadMaxZoom(bindingStorage);
  scene.controls.restoreMaxZoom(resolveMaxZoom(storedMaxZoom, SUPPORTED_MAX_VIEW_HALF_WIDTH));

  const ui = new UiLayer(root, {
    map: inputMap,
    // The interface's sink (spec 229). One for the whole tree -- every widget
    // under the root finds it by walking `parent`, which is what stops this
    // being eleven screens each remembering to pass it on.
    sounds: uiSounds,
    /**
     * The Audio page's three sliders (spec 229).
     *
     * The same three steps every other preference on this window takes (spec
     * 136), in the same order and for the same reason: honour it on the engine,
     * tell the page so the control matches what is being heard, and save it
     * before the frame that could lose it. A page that edited itself would be a
     * page that could disagree with the mix.
     */
    audio: {
      buses: BUSES.map((bus) => ({ id: bus, label: BUS_LABELS[bus] })),
      mix: audioMix,
      onMaster: (value) => {
        audioMix = withMaster(audioMix, value);
        applyMix();
      },
      onBus: (bus, value) => {
        // The page hands back a `string`, because `src/ui/` may not import
        // `BusId`. Checked here rather than cast, so a stale page cannot write
        // a level under a name the engine has no gain node for.
        const known = BUSES.find((candidate) => candidate === bus);
        if (!known) return;
        audioMix = withBus(audioMix, known, value);
        applyMix();
      },
      onMute: (muted) => {
        audioMix = withMuted(audioMix, muted);
        applyMix();
      },
    },
    onMove: (from, to, count) => client.moveItem(from, to, count),
    // Aimed at the press, not at the body (spec 172). `offering` is the point
    // the interface is being handed *right now* -- this fires from inside
    // `offerPress` -- so the aim is the press that caused it rather than
    // wherever the cursor was last seen.
    onDropItem: (at, count) => {
      const me = client.view().self;
      const world = offering ? scene.screenToWorld(offering.x, offering.y) : null;
      // With no press behind it there is nothing to aim at, so it aims at our
      // own feet -- which the server reads as no direction at all and leaves
      // the body's own heading standing.
      client.dropItem(at, world ?? { x: me?.x ?? 0, y: me?.y ?? 0 }, count);
      // The throw, at the body rather than where it will land: the server
      // decides the landing and this happens on the frame of the gesture.
      audioDriver.flat('player.dropItem');
    },
    // Both at the intent, and both safe there because the button is greyed out
    // when the points are not available -- `character-model.ts` runs the
    // server's own rule, so a refusal here is rare and has `ui.error` of its
    // own when it happens (spec 229).
    onSpend: (skillId) => {
      audioDriver.flat('player.skillUp');
      client.spendSkillPoint(skillId);
    },
    onAllocate: (key) => {
      audioDriver.flat('player.attributeUp');
      client.allocateAttribute(key as BaseStatKey);
    },
    onRespec: () => client.respecAttributes(),
    // Money changing hands, in all three directions.
    onBuy: (vendorId, defId) => {
      audioDriver.flat('ui.coin');
      client.buyItem(vendorId, defId);
    },
    onSell: (vendorId, index) => {
      audioDriver.flat('ui.coin');
      client.sellItem(vendorId, index);
    },
    onBuyBack: (vendorId, index) => {
      audioDriver.flat('ui.coin');
      client.buyBack(vendorId, index);
    },
    onVendor: (vendorId) => client.openVendor(vendorId),
    onTradeOffer: (slots, coins) => client.offerInTrade(slots, coins),
    onTradeAccept: (revision) => client.acceptTrade(revision),
    onTradeRespond: (accept) => client.respondToTrade(accept),
    onTradeCancel: () => client.cancelTrade(),
    onTradeDismiss: () => client.dismissEndedTrade(),
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
    // The same three steps again (spec 202): honour it on the camera, tell the
    // page so its slider matches what is drawn, and save it before the frame
    // that could lose it. The *choice* is stored rather than the number it
    // resolves to, so `'supported'` keeps tracking the cap when the cap moves.
    //
    // `chooseMaxZoom` rather than `restoreMaxZoom`, which is the whole fix: a
    // player dragging the slider has to see the width they picked, and clamping
    // alone only ever moves the camera *in*.
    onMaxZoomChosen: (choice) => {
      scene.controls.chooseMaxZoom(resolveMaxZoom(choice, SUPPORTED_MAX_VIEW_HALF_WIDTH));
      ui.setMaxZoom(choice);
      saveMaxZoom(bindingStorage, choice);
    },
    /**
     * Signing in from inside the game (spec 226).
     *
     * Supplied only in remote mode, and the absence is the feature: an in-tab
     * single-player session has no server to have an account on, so the window
     * opens, says what it is, and every button in it does nothing rather than
     * failing against an endpoint that is not there.
     *
     * `validate` is `draftProblem`, which runs the server's own
     * `validateLogin`/`validatePassword` -- so the greyed-out button and the
     * refused request cannot disagree.
     */
    ...(plan.mode === 'remote'
      ? {
          account: {
            validate: draftProblem,
            onRegister: (login: string, password: string, displayName: string): void => {
              void runAuth(
                () => registerAccount(plan.httpOrigin, authToken, { login, password, displayName }),
                // A claim keeps the same player, so nothing about this session
                // changes: same body, same bag, same connection. Only the
                // credential rotates, and storing it is the whole of the work.
                (outcome) => ({
                  message: `Account created. This character is yours — ${outcome.displayName}.`,
                  tone: 'good' as const,
                  signedInAs: outcome.displayName,
                  reload: false,
                }),
              );
            },
            onSignIn: (login: string, password: string): void => {
              void runAuth(
                () => signInToAccount(plan.httpOrigin, authToken, { login, password }),
                // A sign-in changes *which character this is*, and a live
                // connection cannot become a different body: the world, the
                // bag and the entity all belong to the session that is open.
                // So the token is stored and the page is reloaded, which is
                // the one operation that honestly re-runs the handshake.
                () => ({
                  message: 'Signed in. Loading that character…',
                  tone: 'good' as const,
                  signedInAs: null,
                  reload: true,
                }),
              );
            },
            onSignOut: (): void => {
              void (async (): Promise<void> => {
                setAuthState({ ...authState, busy: true, message: 'Signing out…', tone: 'neutral' });
                await signOutOfAccount(plan.httpOrigin, authToken, localStorage);
                // Reloaded rather than patched, for the reason a sign-in is:
                // the next session is a different character -- a fresh guest.
                location.reload();
              })();
            },
          },
        }
      : {}),
    // The one place the platform is asked, beside the media queries.
    scale: loadScale(bindingStorage),
    showFps: loadShowFps(bindingStorage),
    maxZoom: storedMaxZoom,
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
    // A request like every other one here (spec 189). The server truncates,
    // refuses a muted player and broadcasts to everyone including the sender --
    // so what the player sees of their own line comes back the same way as
    // everybody else's, and nothing is echoed locally.
    onSay: (text) => {
      client.say(text);
    },
    // A slot was pressed on the bar (spec 196). The same `pressAbility` a key
    // calls, because the bar and the keyboard reach one ability list.
    onCastSlot: (abilityId) => {
      pressAbility(abilityId);
    },
  });

  // The account window can be shown now (spec 226). Assigned rather than called
  // through `ui` from above, and pushed once here so a session that opened
  // holding an account's token says so before anybody presses anything.
  accountSink.push = (view): void => ui.setAccount(view);
  // Through `setAuthState` rather than straight at `ui`, so the initial state
  // goes down *both* paths: the window, and the `data-account` readout a probe
  // reads. Publishing only on change left that attribute empty until somebody
  // pressed something, which is exactly the state a harness starts measuring in.
  setAuthState(authState);

  // The bar is on the interface canvas now (spec 196), so two facts have to
  // cross once at the mount: what the frame's floor already holds -- the
  // experience strip, which spans the whole width -- and, when `?slots=` forced
  // a bar, which bar. The ordinary case is pushed per frame off the equipment.
  ui.setActionBarFloorCss(hud.floorCss);
  ui.setActionBarSlotCss(hud.slotSideCss);
  ui.setShowsSlotKeys(hud.showsSlotKeys);
  if (forcedBar) ui.setActionBarPlan(forcedBar);

  // The other half of that, and the half that had never been connected to
  // anything: `GameClient.onChat` has existed since the protocol did and its
  // listener list was empty for the life of every session, so the `System` line
  // the server sends on every death and every admin broadcast were encoded,
  // framed, sent, decoded and dropped.
  client.onChat((message) => {
    ui.pushChat(message.channel, message.from, message.text);
  });
  let cursor: { x: number; y: number } | null = null;
  /**
   * The canvas point of the press the interface is being offered, or null.
   *
   * Set for exactly the length of one `handlePointer('down')` call, because
   * that is when a screen can answer with something that needs to know *where*
   * -- putting a carried item down aims at the press (spec 172). Read from a
   * variable rather than passed through the interface because `src/ui/` speaks
   * UI pixels and the world is picked in canvas ones, and `UiLayer.toUi` is
   * deliberately the one conversion between them.
   */
  let offering: { x: number; y: number } | null = null;
  /** Offer a press to the interface, with the point it landed on to hand. */
  const offerPress = (
    at: { x: number; y: number },
    button: number,
    mods: Modifiers,
  ): boolean => {
    offering = at;
    try {
      return ui.handlePointer('down', at, button, mods);
    } finally {
      offering = null;
    }
  };
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

  /**
   * Point the mini HUD at whatever the cursor is over (spec 196).
   *
   * A click on empty ground clears it, because `pickUnitAt` answers null there
   * and null is what "nothing is selected" is -- there is no second gesture for
   * putting the panel away, and there should not be: the way you stop looking
   * at something is to look at something else.
   *
   * Nothing is sent. A selection is a camera decision rather than a game one,
   * so the server has no opinion about it, there is nothing to predict and
   * nothing to be corrected. It is deliberately *not* an attack order either:
   * `world.order` is what names a target, and a readout that also started a
   * fight would make looking at a body dangerous.
   */
  function selectAtCursor(): void {
    ui.select(cursor ? scene.pickUnitAt(cursor.x, cursor.y) : null);
  }

  /** Throw the aim away. Nothing was asked for, so there is nothing to refund. */
  function clearAim(): void {
    pendingAim = null;
    order = null;
  }

  /**
   * Call off the blow, and the orders whose whole job is to aim one (spec 199).
   *
   * What a stop shares with Escape, said once. Both used to write these three
   * lines out, and two lists of what "calling off a blow" drops is two answers
   * that drift the first time a fourth kind of order is added.
   *
   * `cancelCast` refunds the cost and the cooldown before the attack point and
   * returns only the legs after it (spec 144) -- so what a called-off cast spends
   * is exactly the time it took. `targetId` goes with it because withdrawing from
   * a blow the auto-attack would re-commit to on the next tick is not withdrawing
   * from anything.
   */
  function dropCommitments(): void {
    client.cancelCast();
    targetId = null;
    clearAim();
  }

  /**
   * Everything the body is committed to, dropped in one press (spec 199).
   *
   * `dropCommitments` plus the legs: the walk over to a drop, the standing move
   * order and the route planned for it, and whatever is held. Unconditional --
   * a stop asked at rest drops nothing, opens nothing and costs nothing, which
   * is the whole difference from Escape, whose rule is to reach for the menu
   * when there is nothing to back out of (spec 135). One control that sometimes
   * opens a menu is enough.
   *
   * Nothing new crosses the wire, because stopping is the *absence* of a
   * request: with `held` empty and no destination, `moveIntent` asks for (0, 0)
   * and the server stops the body on the next tick it applies. The one thing
   * that does need saying is already a message, and `cancelCast` sends it.
   */
  function stopEverything(): void {
    dropCommitments();
    pickupId = null;
    destination = null;
    planner.clear();
    held.clear();
    // The keys and buttons still down when this fired. Without this the walk
    // resumes on its own at the browser's repeat rate; see `disarmed`.
    for (const code of heldKeys) disarmed.add(code);
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
      disarmed.clear();
      return;
    }

    // Recorded before the map is consulted, because these are the keys the map
    // does not know about (spec 140).
    heldKeys.add(event.code);

    // A key the stop disarmed, still down and repeating (spec 199). Dropped
    // whole rather than filtered down to its non-move half: a repeat carries no
    // new intent by construction, since its own first press already did
    // everything this one would. The default is prevented anyway, because the
    // press this repeats prevented it -- and the disarmed key most often held
    // down is the stop's own Space, which scrolls a page that does not stop it.
    if (event.repeat && disarmed.has(event.code)) {
      event.preventDefault();
      return;
    }

    if (applyDecision(decideControlDown(inputMap, event.code, modifiersOf(event)))) {
      event.preventDefault();
    }
  };

  /**
   * Everything the Play tab does about one control press (specs 125, 189).
   *
   * One applier for the keyboard, the mouse and the wheel, because a decision is
   * about an *action* and an action does not know what pressed it. Two appliers
   * would be two answers to "what does `skillbar.3` do", and the one that a
   * player could not reach from a mouse button would be the one that quietly
   * stopped matching.
   *
   * Returns whether the browser's own default should be prevented. Only the
   * branches that had a default worth taking say so, which is exactly the set
   * that said so while this was inline.
   */
  function applyDecision(decision: ControlDecision): boolean {
    let prevent = false;

    for (const id of decision.windows) {
      ui.toggle(id);
      prevent = true;
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

    // The readout the top-left corner has drawn unconditionally since spec 063
    // (spec 183). `preventDefault` because F3 is a key the browser has its own
    // plans for -- and because the action is rebindable, so is whatever key
    // gets here.
    if (decision.toggleStats) {
      hud.toggleReadout();
      prevent = true;
    }

    // Enter opens the chat (spec 189). It only gets this far while the chat is
    // *closed*: once it is open the field holds the keyboard, `ui.handleKey`
    // above takes the key and this whole function is skipped -- which is what
    // makes the same key send the line without a second branch saying so.
    //
    // The default is prevented because a page-level Enter is the browser's to
    // interpret, and because the action is rebindable, so is whatever gets here
    // -- said by returning rather than by touching the event, since spec 189
    // made this one applier for the keyboard, the mouse and the wheel and a
    // decision no longer knows what produced it.
    if (decision.chat) {
      ui.openChat();
      return true;
    }

    for (const slot of decision.skillbar) {
      // The one gate (spec 164). An empty slot and a key past the last slot are
      // the same nothing here as they are on the button, because both ends ask
      // the same function -- a key that could cast out of a slot the bar draws
      // as empty would be a second answer about what the bar holds.
      const ability = abilityForSlot(actionBar, slot);
      if (!ability) continue;
      pressAbility(ability);
      prevent = true;
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
      dropCommitments();
      if (!committed) ui.toggle('options');
    }

    // And the control that means all of it (spec 199). It is Escape's three
    // drops plus the legs and the route, with no condition on any of it: the
    // row has been in the keybindings window since spec 125 asserting that a key
    // does something, and until now the key did nothing at all.
    //
    // The default is prevented because Space scrolls a page, and because the
    // action is rebindable -- so is whatever gets here.
    if (decision.stop) {
      stopEverything();
      prevent = true;
    }

    // The verbs the pointer ships bound to, and they are branches on an action
    // exactly like every other one above (spec 189). Which is the whole change:
    // they used to be `if (event.button === 2)` a hundred lines down, with no id,
    // no label and no row in the window that offers to rebind everything else.
    // Nothing here asks what pressed them, so a key bound to `world.order` gives
    // an order at the cursor and a button bound to `skillbar.3` casts.
    // One press, two readings (spec 196), in exactly the shape `world.order`
    // below already has: with an aim pending it commits to it, and with none it
    // names the body under the cursor. Two actions on one chord would be a
    // conflict the keybindings window reports and a player could put on two
    // different buttons -- and "left click" is one press, so it is one binding
    // whose meaning is read off what the player is committed to. Which is why
    // the reading is taken *here*: this is the only place `pendingAim` is
    // visible.
    if (decision.confirmAim) {
      if (pendingAim) confirmAim();
      else selectAtCursor();
    }

    if (decision.trade) offerTradeAtCursor();

    if (decision.order) {
      // An order over a pending aim means *no*, and only that: no move order, no
      // attack order, nothing under the cursor acted on. The control that calls a
      // blow off cannot also mean "and go there instead" -- and it is the only
      // reading under which changing your mind is genuinely free.
      if (pendingAim) pendingAim = null;
      else issueOrder();
    }

    return prevent;
  }

  /**
   * Offer a trade to the player under the cursor (spec 134).
   *
   * Anything that is not another player is left alone, and the server checks
   * again. Its own function since spec 189, because it is now reachable from
   * whatever `world.trade` is bound to rather than from one `if` inside the
   * right-button branch.
   */
  function offerTradeAtCursor(): void {
    const under = cursor ? scene.pickUnitAt(cursor.x, cursor.y) : null;
    const picked = under === null ? null : client.view().entities.find((e) => e.id === under);
    if (picked && picked.kind === EntityKind.Player && picked.id !== client.view().selfEntityId) {
      client.inviteToTrade(picked.id);
    }
  }

  const onKeyUp = (event: KeyboardEvent): void => {
    ui.handleKey(event.code, 'up', modifiersOf(event));
    // Dropped whatever the interface said, for the reason below: a release the
    // UI swallowed is a key held forever, and here that is a view that spins.
    heldKeys.delete(event.code);
    // Letting go is what re-arms a control the stop disarmed (spec 199).
    disarmed.delete(event.code);
    // Released whatever the interface said, always. A release that the UI
    // swallowed is a held action with no way out, and the symptom is walking
    // into a wall until the same key is pressed and released again.
    for (const action of decideControlUp(inputMap, event.code)) held.delete(action);
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
    // The world gives its orders on the press -- but a drag ends on a release, so
    // the interface has to hear it.
    ui.handlePointer('up', pointIn(event), event.button, mouseModifiers(event));
    // And a *held* action can be on a button since spec 189, so a release has to
    // clear one. Unconditionally, exactly as `onKeyUp` does and for the same
    // reason: a release the interface swallowed is an action held forever, and
    // the symptom is walking into a wall until the same button is pressed and
    // released again.
    const code = pointerCode(event.button);
    if (code === null) return;
    for (const action of decideControlUp(inputMap, code)) held.delete(action);
  };
  const onMouseDown = (event: MouseEvent): void => {
    if (offerPress(pointIn(event), event.button, mouseModifiers(event))) return;
    // Before the decision is applied, because three of the four pointer verbs
    // read it: an order, a trade and an aim are all aimed at a point.
    const rect = canvas.getBoundingClientRect();
    cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };

    // And that is the whole handler now (spec 189). A button past the fifth has
    // no code, so it has no binding and nothing happens -- which is what the
    // middle button and the thumb buttons already did, said once instead of by
    // falling off the end of a chain of `if`s.
    const code = pointerCode(event.button);
    if (code === null) return;
    applyDecision(decideControlDown(inputMap, code, mouseModifiers(event)));
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

  /**
   * Say what the next click would do (specs 158, 201).
   *
   * Three things change the pointer, and the arrow is what stands the rest of
   * the time. A pending aim gets the full crosshair, because that is the one
   * state in which the pointer is choosing a *point* rather than pointing at a
   * thing. A body a click would act on gets the same mark with its arms pulled
   * in. A drop keeps the pointing hand it has had since spec 158, being the one
   * thing in the world the cursor does something to that has no affordance of
   * its own: a monster lights up when hovered, a window has a border, and an
   * item on the ground has neither. Which of the three wins is `crosshair.ts`'s
   * to answer, in a module a test can reach; this only carries it out.
   *
   * Our two marks are *drawn*, by the HUD, at the pointer position this file
   * already tracks -- they were CSS cursor images for two cuts of spec 200, and
   * on a real machine the image landed four to seven pixels up and left of the
   * point it was marking, because a cursor is placed by a hotspot applied
   * somewhere between the style and the glass. Nothing in a page can see where
   * that put it; every pixel of this can be measured.
   *
   * Called from the frame **and from the end of every pointer and key event**,
   * which is the whole reason it is a function rather than four lines in the
   * frame: the events keep the mark with the pointer that moved it, in the same
   * task, and the frame covers what the *world* changed -- a monster walking
   * under a pointer that never moved raises no event at all.
   *
   * The hovered body is resolved once and asked both questions rather than found
   * twice -- a drop and an attackable body are two readings of the same id.
   */
  function applyCursor(): void {
    const view = client.view();
    const hovered =
      scene.hoveredEntityId === null
        ? undefined
        : view.entities.find((entity) => entity.id === scene.hoveredEntityId);
    const pointer = {
      aiming: pendingAim !== null,
      overEnemy: hovered !== undefined && attackable(hovered, view.selfEntityId),
      overDrop: hovered !== undefined && collectable(hovered),
    };
    // The mark and the cursor under it are one decision read twice, so "we hid
    // the pointer" and "we drew a mark" cannot come apart.
    //
    // `cursor` is null while the pointer is over a window or off the canvas
    // (`onMove`, `onLeave`), and a mark with nowhere to go draws nothing --
    // which is also what stops a hidden cursor being left over the interface.
    canvas.style.cursor = cursor === null ? '' : worldCursor(pointer);
    hud.setCrosshair(cursor === null ? null : worldMark(pointer), cursor);
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
    if (offerPress(pointIn(event), 0, touchModifiers)) {
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
   * The wheel, offered to the interface before the camera takes it.
   *
   * `deltaY` is converted rather than forwarded: the interface counts notches
   * and points the other way (`wheelNotches`). Handed the raw number, every
   * window in the game scrolled backwards and a notch of it went end to end.
   *
   * The zoom is decided here rather than by a listener the scene attaches
   * (spec 189). A notch is a chord -- `WheelUp` and `WheelDown` -- so which way
   * the view moves comes from the action that fired and how far comes from the
   * browser, which is what makes the two rows in the window rebindable rather
   * than merely listed: swap them and the zoom inverts, unbind both and the
   * wheel does nothing. Told only that *some* zoom fired, and zooming by raw
   * `deltaY`, they would be two rows a player can capture and cannot change.
   *
   * Nothing is prevented when the notch resolves to nothing, on purpose: this
   * listener is on `root` in the capture phase, so it also sees the wheel over
   * the settings popovers, and an unconditional `preventDefault` here would stop
   * those scrolling.
   */
  const onWheel = (event: WheelEvent): void => {
    const notches = wheelNotches(event.deltaY);
    if (ui.handleWheel(pointIn(event), notches, mouseModifiers(event))) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const code = wheelCode(notches);
    if (code === null) return;
    const decision = decideControlDown(inputMap, code, mouseModifiers(event));
    const acted = applyDecision(decision);
    if (decision.zoom !== 0) scene.controls.zoomNotch(decision.zoom, event.deltaY, event.deltaMode);
    if (!acted && decision.zoom === 0) return;
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
    // Beside the two above and for the reason they are here: focus lost is every
    // key released as far as this tab is concerned, and a code left disarmed
    // would swallow the repeats of the next press of it.
    disarmed.clear();
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
      // Something done to this body rather than by it (spec 173): while it
      // holds, the order stands and asks for nothing.
      staggered: view.selfStaggered,
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
      // A break clears the cast, so `rooted` is false right through a
      // stagger and cannot stand in for it (spec 173).
      staggered: view.selfStaggered,
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
    // At the intent again, and here that is more than a convention: the pickup
    // is a *walk* away -- the order is given, the body goes and gets it -- and a
    // sound that waited for the grant would land a second after the click that
    // asked for it, at which point it reads as the click having been dropped.
    audioDriver.flat('player.pickUp');
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
      // Turning to put something down (spec 172): the same aim the server is
      // turning the body with, so the drawn heading is the one it is about to
      // arrive at rather than the one it left.
      dropAim: view.dropAim,
      // Face the mark while the swing is still on cooldown (spec 090). Without
      // it the body stood facing wherever it happened to be looking for up to a
      // whole attack delay, and only turned once the blow committed -- so the
      // turn was paid for *after* the wait instead of during it.
      targetAim: aimedMark(view),
      // A poise break holds the legs *and* the heading (spec 173). The heading
      // is the half that matters here: a correction carries a position, so a
      // predicted step is pulled back, and it carries no facing at all -- so a
      // body that kept turning through its own stagger would be an error the
      // server never corrects.
      staggered: view.selfStaggered,
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
  /** When `pump` last ran, so the backoff can be advanced by the gap it got. */
  let lastPumpMs = 0;

  /**
   * One beat of the clock that outlives the frame loop (spec 197).
   *
   * Called by the interval, and again the instant the tab becomes visible --
   * which is the one moment we know the reason for an outage has gone, and the
   * one moment the old code did nothing, because it sat waiting for the very
   * timer the browser had throttled. Both callers want exactly this, so it is a
   * function rather than two copies that could drift.
   *
   * The gap is measured rather than assumed: see `keepalive.ts` for why a
   * constant per firing halved the reconnect ladder in a hidden tab.
   */
  function pump(nowMs: number): void {
    const elapsed = lastPumpMs === 0 ? KEEPALIVE_MS : nowMs - lastPumpMs;
    lastPumpMs = nowMs;
    client.keepAlive();
    backoffTick += backoffTicksFor(elapsed, SERVER_TICK_RATE);
    reconnecting?.deliver(backoffTick);
  }

  /**
   * The tab being looked at again.
   *
   * Two things, and the second is the reason this is not only about the socket:
   * the frame clock is reset the way `start()` resets it, so the first frame
   * after ten hidden minutes is one tick long rather than a ten-minute `dt`
   * handed to the camera and averaged into the frame meter.
   */
  function onVisible(): void {
    if (document.visibilityState !== 'visible') {
      // A hidden tab stops `requestAnimationFrame`, so nothing is left to move
      // a held loop or stop one -- but Web Audio keeps playing regardless, and
      // a fire loop droning out of a tab nobody is looking at is the version of
      // this that gets reported (spec 229). Suspended rather than stopped: the
      // held handles stay valid, and coming back is one call rather than a
      // frame of re-starting every loop in the world.
      audioEngine.suspend();
      return;
    }
    audioEngine.resume();
    last = 0;
    frames.reset();
    pump(performance.now());
  }

  /**
   * Arm the audio on the first real input (spec 229).
   *
   * A browser refuses to let a page make noise before somebody has interacted
   * with it, so the `AudioContext` is constructed by the first `resume()` rather
   * than at mount -- one built earlier starts `suspended` and stays there in a
   * way that is invisible until a playtester says there is no sound.
   *
   * Called on *every* input rather than once, and that is not laziness: a
   * browser can suspend a context on its own (an OS audio-focus change, a
   * policy), and the cheapest correct answer is to ask again than to track
   * whose fault it was. `resume` is a no-op on a running context.
   */
  function armAudio(): void {
    audioEngine.resume();
  }

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
    // The whole loop, not `server.tick()` alone (spec 192): what the frame pays
    // to advance the simulation includes releasing the wire, the client's own
    // clock and the input it sends, and a number that timed only the server
    // would read as zero on a socket -- where the predictor is the entire cost.
    const simStart = performance.now();
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
      // Top the forced afflictions up (spec 215). Inside the sim loop rather
      // than in the frame, because the cadence is measured in ticks and a frame
      // is however long this machine took -- the same reason everything else
      // that has to happen "every N ticks" is counted here.
      if (server !== null && forcedAfflictions.length > 0) {
        afflictAgainAtTick -= 1;
        if (afflictAgainAtTick <= 0) {
          afflictAgainAtTick = FORCED_AFFLICTION_EVERY_TICKS;
          const at = client.view().self;
          if (at) {
            for (const ordinal of forcedAfflictions) {
              server.triggerEvent('affliction', at.x, at.y, ordinal);
            }
          }
        }
      }
      // And the same for a forced aura field (spec 223). A tight reach, because
      // the trigger's magnitude is its radius and what is wanted is the ring on
      // the player rather than on everything they walked past -- which would be
      // several fields overlapping and no way to tell whose is whose.
      if (server !== null && forcedField) {
        fieldAgainAtTick -= 1;
        if (fieldAgainAtTick <= 0) {
          fieldAgainAtTick = FORCED_AFFLICTION_EVERY_TICKS;
          const at = client.view().self;
          if (at) server.triggerEvent('field', at.x, at.y, 1);
        }
      }
      // The client keeps its own clock (spec 065's follow-up): deltas are
      // suppressed when nothing changed, so `view.tick` is not one.
      client.advanceTick();
      sendInput();
    }
    simCosts.push(performance.now() - simStart);
    simTicks.push(ticks);

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
    // Timed, because "is this frame slow because of the loader or because of
    // the machine" is the first question anybody debugging the cold start has,
    // and the frame time alone cannot tell them (spec 165 follow-up 6).
    const ingestStart = performance.now();
    ingestChunks(view, now);
    const ingestMs = performance.now() - ingestStart;
    worstIngestMs = Math.max(worstIngestMs * INGEST_DECAY, ingestMs);
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
    // --- audio (spec 229) --------------------------------------------------
    //
    // After `scene.render`, because the listener is read from the camera that
    // frame moved -- a voice allocated against last frame's listener is panned
    // to where the camera used to be. Before anything is played, for the same
    // reason and in the same breath.
    //
    // The bodies come from the **replica** rather than from the drawn poses.
    // What that costs is up to one broadcast interval of staleness in a pan,
    // which is 50ms and inaudible; what it buys is that the whole audio layer
    // is driven from here rather than threaded through the 3,000-line scene,
    // and that it is the same list `soundsForBlow` recovers a position from.
    audioDriver.listener(scene.listenerPose());
    // The map's bed. Asked every frame because a refusal is the ordinary state
    // for the first second of a session -- see `AudioDriver.ambience`.
    audioDriver.ambience();
    for (const entity of view.entities) {
      // --- the one body that is not where the replica says ------------------
      //
      // The listener sits on the **predicted** self (`scene.listenerPose`), and
      // every body here comes from the replica, which lags it. For a monster
      // across the arena that lag is 50ms of a long vector and inaudible, which
      // is what the note below says and it is true of everything except this
      // one body: your own.
      //
      // At zero distance there is no vector for the error to be small against.
      // The offset between prediction and replica *is* the whole source
      // position, so a panner given it pans your own footsteps entirely by your
      // own network lag -- and because the lag points backwards along the way
      // you are going, walking one way puts your feet in the other speaker.
      // Which is exactly the report: move left, hear it on the right.
      //
      // So the local player is emitted at the listener. Not as a correction to
      // the lag but because it is simply true: a sound your own body makes is
      // at your own head, and the only honest offset there is none.
      const self = entity.id === view.selfEntityId ? (view.self ?? null) : null;
      audioDriver.body(
        {
          entityId: entity.id,
          x: self?.x ?? entity.x,
          // The sim is 2D: its `Vec2 {x, y}` is world (x, z). Getting this
          // backwards mirrors every sound across the NW-SE diagonal, which at
          // the default camera azimuth is exactly a left/right swap.
          z: self?.y ?? entity.y,
          // The height the body is *drawn* at, which `syncBodies` already
          // computed this frame -- a map lookup against a 5.6us height sample,
          // thirty times a frame. `groundAt` is the fallback for a body no
          // frame has drawn yet.
          ground:
            self === null
              ? (scene.bodyGround(entity.id) ?? scene.groundAt(entity.x, entity.y))
              : scene.groundAt(self.x, self.y),
          activity: entity.activity,
          activityUntilTick: entity.activityUntilTick,
          // Legs. A projectile, a drop, a mote and a prop have none, and a
          // drop sliding down its throw arc would otherwise take footsteps.
          walks: entity.kind === EntityKind.Player || entity.kind === EntityKind.Monster,
          projectileLook:
            entity.kind === EntityKind.Projectile
              ? (abilityById(entity.typeId)?.projectile?.look ?? null)
              : null,
          // Whether it is standing in its own fire (spec 223). The same
          // predicate `aura-vfx.ts` draws the ring from, so the sound and the
          // ring cannot disagree about who is carrying a field.
          field: fieldStatusesOn(entity.statuses, drawnTick).length > 0,
        },
        drawnTick,
      );
    }
    // The owed stop: anything not offered this frame lets go of whatever it was
    // holding. Nothing in the engine notices an absence.
    audioDriver.sweep();

    // Split at the first draw call (spec 194), because "the renderer is slow"
    // has two unrelated causes: too much JavaScript preparing the frame, and too
    // many commands handed to the driver. The remainder the overlay computes --
    // the frame minus the sim, the preparation and the submission -- is
    // everything this thread cannot see, which is where the answer lives when
    // all three of these are small and the frame is not.
    const cost = scene.renderCost();
    prepCosts.push(cost.prepareMs);
    drawCosts.push(cost.drawMs);
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

    // What the last kill was worth, once the server has said (spec 184).
    //
    // Read here rather than in a message handler because the reward has no
    // message of its own: a `Stats` arrives, and the only way to tell a gain
    // from a re-send of the same character is to have kept the last one. The
    // popup wants a place, and the frame is where the scene can still be asked
    // for one.
    const gained = xpGains.observe(view.level, view.experience);
    if (gained > 0) {
      const kill = lastKill;
      lastKill = null;
      // The corpse's own ground when there is a kill behind it; the player's
      // body when there is not. Never nothing -- a reward with nowhere to go is
      // still a reward, and the strip alone is what this spec exists to fix.
      const at =
        kill?.at ?? scene.bodyAnchor(view.selfEntityId) ?? replicaAnchor(view.selfEntityId);
      if (at) hud.addExperience(kill?.group ?? view.selfEntityId, at, gained);
    }
    // A level-up, on the same message and by the same rule (spec 229). The two
    // that make it honest are `XpGains`': the **first reading only baselines**,
    // or connecting plays a level-up for the level you already had, and a move
    // **backwards re-baselines silently**, because an admin `setLevel` is not a
    // reward.
    if (lastLevel !== null && view.level > lastLevel) audioDriver.flat('player.levelUp');
    lastLevel = view.level;

    // Being asked to trade, and a trade going through (spec 229). Two
    // transitions, and only two: `Open` and `Confirmed` are a table being
    // worked at, which the interface already shows and which does not want a
    // noise per revision.
    //
    // `invited` is what makes the first one right: the side that *sent* the
    // invitation knows it sent one, and playing them a "somebody wants to
    // trade" is the interface telling them something they just did.
    const stage = view.trade?.stage ?? null;
    if (stage !== lastTradeStage) {
      if (stage === TradeStageValue.Offered && view.trade?.invited === true) {
        audioDriver.flat('ui.tradeRequest');
      }
      // Read off `endedTrade` rather than off `stage`, because the server
      // forgets a trade the instant it is over -- the same reason the mount
      // reads `view.trade ?? view.endedTrade` (spec 169). By the time there is
      // a reason to say anything, the live field is already null.
      if (stage === null && lastTradeStage !== null && view.endedTrade?.stage === TradeStageValue.Done) {
        audioDriver.flat('ui.tradeComplete');
      }
      lastTradeStage = stage;
    }

    // What the four skill slots hold, read off the equipment every frame
    // (spec 188). Pushed rather than remembered, for the reason the window
    // buttons are: the equipment is the state, and a bar that kept its own copy
    // would be a second opinion about what the player is carrying -- which is
    // exactly what a swap the server refused would leave behind. `sameBar`
    // compares before anything is pushed, so a resend that changed nothing is
    // free -- and the array pushed is the same one the *keys* are resolved
    // against below, which is the rule spec 164 wrote `action-bar.ts` for.
    if (forcedBar === null) {
      const next = actionBarFor(view.equipment);
      if (!sameBar(next, actionBar)) {
        actionBar = next;
        ui.setActionBarPlan(next);
      }
    }
    // The slot an aim came from, lit in the aim's own colour (spec 080), so the
    // question on the ground and the button it came from are one thing. Pushed
    // rather than read, because the interface may not reach into the game.
    ui.setAiming(pendingAim?.abilityId ?? null);
    // ...and back the other way: everything left along the bottom edge is placed
    // against the bar, and the bar is now drawn on the interface canvas at the
    // player's own scale (spec 196). The measured row rather than a second sum,
    // because a second description of somebody else's layout is the mistake that
    // put the chat log on the weapon switch.
    hud.setActionBar(ui.actionBarBoxCss());
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
    applyCursor();
    // Read back off the interface rather than remembered from the press
    // (spec 140), so a window opened by a key lights its button too.
    hud.showOpenWindows(ui.opened());
    // Read off the same session state the account window itself renders
    // (spec 227), so the button in the corner and the window it opens cannot
    // disagree about who is signed in.
    hud.setAccount({ signedInAs: authState.signedInAs });

    // Last, so what it reports is a whole frame's work rather than the part of
    // one that happens before the world is drawn (spec 165). `stats()` is only
    // computed when somebody is looking -- the sort over the window is cheap but
    // it is not free, and a meter that costs frame time misreports the frame
    // time it costs.
    fpsOverlay.set(
      showFps ? frames.stats() : null,
      worstIngestMs,
      worstStage,
      worstStageMs,
      scene.renderStats(),
      { ...simCosts.read(), ticksPerFrame: simTicks.read().meanMs },
      { prepareMs: prepCosts.read().meanMs, drawMs: drawCosts.read().meanMs },
    );

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
    publishVfxReadout();
    publishAudioReadout();
    publishOrders();

    // Last, over everything (spec 131). It is handed `now` rather than reading
    // one: nothing under `src/ui/` may touch a clock, which is what makes an
    // input replay of this interface exact rather than approximate.
    ui.update(view, now, drawnTick);
    publishUiReadout();

    raf = requestAnimationFrame(frame);
  }

  container.append(root);

  return {
    element: root,
    start(): void {
      // The autoplay unlock. `pointerdown` and `keydown` on the window, because
      // the canvas does not see a click that lands on the interface canvas over
      // it and the first thing a player presses might be a window button.
      window.addEventListener('pointerdown', armAudio);
      window.addEventListener('keydown', armAudio);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
      document.addEventListener('visibilitychange', onVisible);
      // Pointer events rather than mouse events, so a tap is read once: the
      // compatibility `mousedown` a touch also fires would arrive as button 0
      // and confirm an aim nobody asked about (spec 093).
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerCancel);
      canvas.addEventListener('mouseleave', onLeave);
      // Last on purpose: these run after the handlers above have decided
      // whatever this event decides, in the same task, so the cursor the frame
      // would have set a moment later is set while the browser still has the
      // input in hand. See `applyCursor`.
      for (const kind of ['pointermove', 'pointerdown', 'pointerup'] as const) {
        canvas.addEventListener(kind, applyCursor);
      }
      window.addEventListener('keydown', applyCursor);
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
        // The heartbeat and the backoff, on a clock the frame loop cannot
        // stop. Not one a *browser* cannot stop -- it throttles this to one
        // firing a minute past five minutes hidden, which is why the
        // connection is held from the far end now (spec 197's `SERVER_PING_MS`)
        // and this drives the visible case and the reconnect ladder.
        keepAlive = window.setInterval(() => pump(performance.now()), KEEPALIVE_MS);
        void client.connect().catch((error: unknown) => {
          banner.refuse(error instanceof Error ? error.message : String(error));
        });
      } else {
        void client.connect();
      }

      last = 0;
      accumulator = 0;
      lastPumpMs = 0;
      raf = requestAnimationFrame(frame);
    },
    stop(): void {
      cancelAnimationFrame(raf);
      // Leaving the tab. Every held loop is stopped explicitly rather than left
      // to the sweep: `stop()` is what the shell calls when this tab is hidden,
      // and the frame loop that would have swept them is the thing being
      // cancelled on the line above -- so an ember in flight when you switched
      // to the map editor would drone until the page was closed.
      audioDriver.stopAll();
      audioEngine.suspend();
      window.removeEventListener('pointerdown', armAudio);
      window.removeEventListener('keydown', armAudio);
      if (keepAlive !== 0) {
        window.clearInterval(keepAlive);
        keepAlive = 0;
      }
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisible);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      for (const kind of ['pointermove', 'pointerdown', 'pointerup'] as const) {
        canvas.removeEventListener(kind, applyCursor);
      }
      window.removeEventListener('keydown', applyCursor);
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
