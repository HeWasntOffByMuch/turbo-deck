import { initSpellGame, stepSpellGame, type SpellGameState } from '../../game/spell-session.js';
import { characterAt } from '../../sim/characters.js';
import { TICK_RATE } from '../../sim/constants.js';
import { IsoInputCapture } from './input.js';
import { IsoScene } from './scene.js';

/**
 * Entry point for the isometric 3D view (spec 031). Same fixed-timestep loop as
 * the 2D spell renderer: real elapsed time becomes a whole number of sim ticks,
 * inputs are fed one tick at a time, and the scene only ever reads the resulting
 * state. Movement is the MOBA move order (spec 028): the cursor is raycast onto
 * the ground each tick, and a right-click issues a move order to that point. All
 * game logic stays in the sim/cards/game layers below.
 */

const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP = 8;

function main(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('missing #app');

  const title = document.createElement('div');
  title.style.cssText = "font-family:'Segoe UI',system-ui,sans-serif;color:#c9c9d8;margin:6px 2px 12px;font-size:13px;";
  app.appendChild(title);

  const canvas = document.createElement('canvas');
  app.appendChild(canvas);

  const seed = Date.now() >>> 0;
  const scene = new IsoScene(canvas, seed);
  const input = new IsoInputCapture(canvas);
  input.attach(window);

  let state: SpellGameState = initSpellGame(seed);

  const setTitle = (): void => {
    const name = characterAt(state.combat.player.characterIndex).name;
    title.textContent =
      `turbo-deck · isometric 3D (spec 031) — right-click to move (${name}: MOBA turn-rate movement), ` +
      'C swaps character, Q summons a wave, 1-4 play cards. Flat-shaded, single-light, fixed iso camera.';
  };
  setTitle();

  let accumulator = 0;
  let lastFrame: number | undefined;

  const frame = (time: number): void => {
    if (lastFrame !== undefined) accumulator = Math.min(accumulator + (time - lastFrame), TICK_MS * MAX_CATCH_UP);
    lastFrame = time;

    while (accumulator >= TICK_MS) {
      const cursor = input.mouseCanvas();
      const worldCursor = scene.screenToWorld(cursor.x, cursor.y);
      state = stepSpellGame(state, input.sample(worldCursor, state.combat.player.position)).state;
      accumulator -= TICK_MS;
    }

    scene.render(state.combat);
    setTitle();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
