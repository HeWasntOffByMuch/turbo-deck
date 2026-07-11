import { initDungeonGame, stepDungeonGame, type DungeonGameEvent, type DungeonGameState } from '../../game/dungeon-session.js';
import { TICK_RATE } from '../../sim/constants.js';
import { DungeonInputCapture } from './input.js';
import { CANVAS_H, CANVAS_W, DungeonView } from './view.js';

/**
 * Entry point for the dungeon mode (spec 027). Wires the Canvas2D tileset view
 * and keyboard/mouse input to the deterministic dungeon session through a
 * fixed-timestep loop — the one place real elapsed time becomes sim ticks. Every
 * gameplay decision lives in the sim/game layers below; this only draws and
 * samples input.
 */

const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP = 8;

function main(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('missing #app');

  const title = document.createElement('div');
  title.style.cssText = "font-family:'Segoe UI',system-ui,sans-serif;color:#c9c9d8;margin:6px 2px 10px;font-size:13px;";
  title.textContent =
    'turbo-deck · procedural dungeon — WASD move, mouse aim, hold Left-click / J attack, Space parry, Shift / Right-click dodge. Rooms seal on entry and reopen when cleared. (R restarts)';
  app.appendChild(title);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.5);cursor:crosshair;';
  app.appendChild(canvas);

  const view = new DungeonView(canvas);
  const input = new DungeonInputCapture(canvas);
  input.attach(window);

  // A `#seed=123` hash pins the layout (handy for sharing/repro); else random.
  const hashSeed = Number.parseInt(new URLSearchParams(location.hash.slice(1)).get('seed') ?? '', 10);
  let seed = Number.isFinite(hashSeed) ? hashSeed >>> 0 : Date.now() >>> 0;
  let state: DungeonGameState = initDungeonGame(seed);
  let accumulator = 0;
  let lastFrame: number | undefined;

  const frame = (time: number): void => {
    if (lastFrame !== undefined) accumulator = Math.min(accumulator + (time - lastFrame), TICK_MS * MAX_CATCH_UP);
    lastFrame = time;

    if (input.takeRestart()) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      state = initDungeonGame(seed);
    }

    const events: DungeonGameEvent[] = [];
    while (accumulator >= TICK_MS) {
      const playerScreen = view.worldToScreen(state.combat.player.position);
      const result = stepDungeonGame(state, input.sample(playerScreen));
      state = result.state;
      events.push(...result.events);
      accumulator -= TICK_MS;
    }

    const playerScreen = view.worldToScreen(state.combat.player.position);
    const mouse = input.mouseScreen();
    view.render(state, events, { x: mouse.x - playerScreen.x, y: mouse.y - playerScreen.y });

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();

// Keep exports so bundlers/tsc treat this as a module; canvas dims are handy for embeds.
export { CANVAS_W, CANVAS_H };
