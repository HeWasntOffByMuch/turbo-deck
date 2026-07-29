import { initComboGame, stepComboGame, type ComboGameState } from '../../game/combo-session.js';
import { TICK_RATE } from '../../sim/constants.js';
import { IsoInputCapture } from './input.js';
import { IsoScene } from './scene.js';

/**
 * Entry point for the isometric 3D view (spec 018). Same fixed-timestep loop as
 * the combo prototype: real elapsed time becomes a whole number of sim ticks,
 * inputs are fed one tick at a time, and the scene only ever reads the resulting
 * state. All game logic stays in the sim/cards/game layers below.
 */

const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP = 8;

function main(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('missing #app');

  const title = document.createElement('div');
  title.style.cssText = "font-family:'Segoe UI',system-ui,sans-serif;color:#c9c9d8;margin:6px 2px 12px;font-size:13px;";
  title.textContent =
    'turbo-deck · isometric 3D slice — WASD/arrows to move, Q to summon a wave. Flat-shaded, single-light, fixed iso camera.';
  app.appendChild(title);

  const canvas = document.createElement('canvas');
  app.appendChild(canvas);

  const seed = Date.now() >>> 0;
  const scene = new IsoScene(canvas, seed);
  const input = new IsoInputCapture();
  input.attach(window);

  let state: ComboGameState = initComboGame(seed);
  let accumulator = 0;
  let lastFrame: number | undefined;

  const frame = (time: number): void => {
    if (lastFrame !== undefined) accumulator = Math.min(accumulator + (time - lastFrame), TICK_MS * MAX_CATCH_UP);
    lastFrame = time;

    while (accumulator >= TICK_MS) {
      state = stepComboGame(state, input.sample()).state;
      accumulator -= TICK_MS;
    }

    scene.render(state.combat);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
