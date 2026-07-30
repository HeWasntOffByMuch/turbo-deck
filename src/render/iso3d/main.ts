import { initSpellGame, stepSpellGame, type SpellGameState } from '../../game/spell-session.js';
import { TICK_RATE } from '../../sim/constants.js';
import { IsoInputCapture } from './input.js';
import { IsoHud } from './hud.js';
import { IsoScene } from './scene.js';
import { mountMovement, type ViewHandle } from './movement.js';
import { mountDebug } from './debug-view.js';

/**
 * Entry point for the isometric 3D view (spec 031/032). A small tab shell mounts
 * one of three views: the **combat** view (the MOBA spell game), a game-free
 * **movement sandbox** (spec 032), and a **rig debug** viewport (spec 035) that
 * shows the unit from two angles with slow-mo and joint overlays. Each view is a
 * fixed-timestep loop where real
 * elapsed time becomes a whole number of sim ticks, inputs are fed one tick at a
 * time, and the scene only ever reads the resulting state -- all game logic stays
 * in the sim/cards/game layers below. Switching tabs pauses the hidden view's
 * loop and releases its input.
 *
 * The combat view is the *game window*: it fills the viewport, and every piece of
 * UI -- the tab bar, the settings cog, the HUD and its tooltips -- floats on top
 * of it (spec 039). The two sandbox tabs keep their ordinary scrolling layout.
 */

const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP = 8;

/**
 * Mount the combat view (spec 031/039): a fullscreen game window with the HUD
 * overlaid. The MOBA move order raycasts the cursor onto the ground each tick, a
 * right-click issues a move order (shift-click queues one, spec 038), and a
 * left-click fires a basic attack toward the cursor. Returns a start/stop handle.
 */
function mountCombat(container: HTMLElement): ViewHandle {
  const root = document.createElement('div');
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#0b0b12;';

  const seed = Date.now() >>> 0;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;';
  const scene = new IsoScene(canvas, seed);
  const input = new IsoInputCapture(canvas);
  const hud = new IsoHud(input);

  // The camera/light cog floats over the top-right corner of the game window.
  const cog = document.createElement('div');
  cog.style.cssText = 'position:absolute;top:8px;right:10px;z-index:30;';
  cog.appendChild(scene.controls.element);

  root.append(canvas, hud.element, cog);
  container.appendChild(root);

  let state: SpellGameState = initSpellGame(seed);

  // The hand slot holding a basic `attack` card, for left-click attacks (null if none).
  const attackSlot = (): 0 | 1 | 2 | 3 | null => {
    const i = state.deck.hand.findIndex((c) => c?.id === 'attack');
    return i === 0 || i === 1 || i === 2 || i === 3 ? i : null;
  };

  let running = false;
  let accumulator = 0;
  let lastFrame: number | undefined;

  const frame = (time: number): void => {
    if (!running) return;
    if (lastFrame !== undefined) accumulator = Math.min(accumulator + (time - lastFrame), TICK_MS * MAX_CATCH_UP);
    lastFrame = time;

    const cursor = input.mouseCanvas();
    const worldCursor = scene.screenToWorld(cursor.x, cursor.y);
    while (accumulator >= TICK_MS) {
      state = stepSpellGame(state, input.sample(worldCursor, state.combat.player.position, attackSlot())).state;
      accumulator -= TICK_MS;
    }

    // Hovering is presentation only, so it is read per frame, not per tick.
    scene.setCursorScreen(cursor);
    scene.render(state.combat);
    hud.render(state);
    requestAnimationFrame(frame);
  };

  return {
    element: root,
    start(): void {
      if (running) return;
      running = true;
      lastFrame = undefined;
      accumulator = 0;
      input.attach(window);
      requestAnimationFrame(frame);
    },
    stop(): void {
      running = false;
      input.detach();
    },
  };
}

interface Tab {
  readonly label: string;
  readonly mount: (container: HTMLElement) => ViewHandle;
}

function main(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('missing #app');

  const tabs: readonly Tab[] = [
    { label: 'Combat (isometric 3D)', mount: mountCombat },
    { label: 'Movement sandbox', mount: mountMovement },
    { label: 'Rig debug', mount: mountDebug },
  ];

  // The bar floats over the game window rather than pushing it down (spec 039);
  // the container beneath it is the full viewport, and the sandbox tabs scroll
  // inside it with enough headroom to clear the bar.
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:0;left:0;z-index:50;display:flex;gap:6px;padding:6px 8px 0;';
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;inset:0;overflow:auto;';
  app.append(container, bar);

  // Views are mounted lazily on first activation and reused thereafter.
  const handles: (ViewHandle | null)[] = tabs.map(() => null);
  const buttons: HTMLButtonElement[] = [];
  let active = -1;

  const styleButton = (btn: HTMLButtonElement, on: boolean): void => {
    btn.style.cssText =
      "font-family:'Courier New',ui-monospace,monospace;font-size:12px;letter-spacing:.06em;padding:5px 12px;" +
      'cursor:pointer;border:2px solid #4a4a5e;box-shadow:2px 2px 0 rgba(0,0,0,.55);' +
      (on ? 'background:#3a3a4e;color:#f0f0f8;' : 'background:rgba(12,12,18,.82);color:#9a9ab0;');
  };

  const activate = (i: number): void => {
    if (i === active) return;
    const tab = tabs[i];
    if (!tab) return;
    const prev = active >= 0 ? handles[active] : null;
    if (prev) {
      prev.stop();
      prev.element.style.display = 'none';
    }
    let handle = handles[i];
    if (!handle) {
      handle = tab.mount(container);
      // The combat view owns the whole window; the sandbox tabs lay out normally
      // and just need headroom so the floating tab bar doesn't cover them.
      if (i !== 0) handle.element.style.padding = '44px 16px 16px';
      handles[i] = handle;
    }
    handle.element.style.display = 'block';
    handle.start();
    active = i;
    buttons.forEach((btn, j) => styleButton(btn, j === i));
  };

  tabs.forEach((tab, i) => {
    const btn = document.createElement('button');
    btn.textContent = tab.label;
    styleButton(btn, false);
    btn.addEventListener('click', () => activate(i));
    bar.appendChild(btn);
    buttons.push(btn);
  });

  activate(0);
}

main();
