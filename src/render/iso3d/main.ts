import { initSpellGame, stepSpellGame, type SpellGameState } from '../../game/spell-session.js';
import { characterAt } from '../../sim/characters.js';
import { TICK_RATE } from '../../sim/constants.js';
import { IsoInputCapture } from './input.js';
import { IsoScene } from './scene.js';
import { mountMovement, type ViewHandle } from './movement.js';

/**
 * Entry point for the isometric 3D view (spec 031/032). A small tab shell mounts
 * one of two views: the **combat** view (the MOBA spell game) and a game-free
 * **movement sandbox** (spec 032). Each view is a fixed-timestep loop where real
 * elapsed time becomes a whole number of sim ticks, inputs are fed one tick at a
 * time, and the scene only ever reads the resulting state -- all game logic stays
 * in the sim/cards/game layers below. Switching tabs pauses the hidden view's
 * loop and releases its input.
 */

const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP = 8;

/**
 * Mount the combat view (spec 031): the MOBA move order raycasts the cursor onto
 * the ground each tick, a right-click issues a move order, and a left-click fires
 * a basic attack toward the cursor. Returns a start/stop handle for the shell.
 */
function mountCombat(container: HTMLElement): ViewHandle {
  const root = document.createElement('div');
  const title = document.createElement('div');
  title.style.cssText = "font-family:'Segoe UI',system-ui,sans-serif;color:#c9c9d8;margin:6px 2px 12px;font-size:13px;";
  root.appendChild(title);

  const seed = Date.now() >>> 0;
  const canvas = document.createElement('canvas');
  const scene = new IsoScene(canvas, seed);
  const input = new IsoInputCapture(canvas);

  // Canvas with the camera/light control panel alongside it (spec 033).
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;';
  row.append(canvas, scene.controls.element);
  root.appendChild(row);
  container.appendChild(root);

  let state: SpellGameState = initSpellGame(seed);

  const setTitle = (): void => {
    const name = characterAt(state.combat.player.characterIndex).name;
    title.textContent =
      `turbo-deck · isometric 3D (spec 031) — right-click move, left-click attack toward cursor ` +
      `(${name}: MOBA turn-rate movement — the unit turns before it moves/fires, and moving cancels an attack). ` +
      'C swaps character, Q summons a wave, 1-4 play cards.';
  };
  setTitle();

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

    while (accumulator >= TICK_MS) {
      const cursor = input.mouseCanvas();
      const worldCursor = scene.screenToWorld(cursor.x, cursor.y);
      state = stepSpellGame(state, input.sample(worldCursor, state.combat.player.position, attackSlot())).state;
      accumulator -= TICK_MS;
    }

    scene.render(state.combat);
    setTitle();
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
  ];

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;margin:0 2px 4px;';
  const container = document.createElement('div');
  app.append(bar, container);

  // Views are mounted lazily on first activation and reused thereafter.
  const handles: (ViewHandle | null)[] = tabs.map(() => null);
  const buttons: HTMLButtonElement[] = [];
  let active = -1;

  const styleButton = (btn: HTMLButtonElement, on: boolean): void => {
    btn.style.cssText =
      "font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;padding:6px 14px;border-radius:8px 8px 0 0;" +
      `cursor:pointer;border:1px solid #2a2a3a;border-bottom:none;` +
      (on ? 'background:#2a2a3a;color:#f0f0f8;' : 'background:#16161e;color:#9a9ab0;');
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
