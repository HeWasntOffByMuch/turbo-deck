import { initSpellGame, stepSpellGame, type SpellGameEvent, type SpellGameState } from '../../game/spell-session.js';
import { TICK_RATE } from '../../sim/constants.js';
import { GameAudio } from '../audio.js';
import { musicPhaseForEnemyCount } from '../music.js';
import { SCALE, SpellArenaView } from './arena.js';
import { SpellHud } from './hud.js';
import { SpellInputCapture } from './input.js';

/**
 * Entry point for the spell-card game (spec 018). Wires the DOM HUD + Canvas2D
 * arena to the deterministic spell sim through a fixed-timestep loop. The loop
 * is the only place real elapsed time becomes sim ticks; every gameplay decision
 * lives in the sim/cards/game layers below.
 */

const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP = 8;

function main(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('missing #app');

  const title = document.createElement('div');
  title.style.cssText = "font-family:'Segoe UI',system-ui,sans-serif;color:#c9c9d8;margin:6px 2px 10px;font-size:13px;";
  title.textContent =
    'turbo-deck · spell-card combat — attacks and dashes are cards. Play two of a kind fast to fuse them into something bigger. (M mutes)';
  app.appendChild(title);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.5);';
  app.appendChild(canvas);

  const hudRoot = document.createElement('div');
  app.appendChild(hudRoot);

  const arena = new SpellArenaView(canvas);
  const input = new SpellInputCapture(canvas);
  input.attach(window);
  const hud = new SpellHud(hudRoot, input);

  // Synthesized retro soundtrack + spell SFX. Browsers block autoplay, so the
  // AudioContext can only start from a user gesture — resume it on the first
  // key/pointer input; 'M' toggles mute.
  const audio = new GameAudio();
  const unlock = (): void => audio.resume();
  window.addEventListener('keydown', (e) => {
    unlock();
    if (e.code === 'KeyM') audio.toggleMute();
  });
  window.addEventListener('pointerdown', unlock);

  let state: SpellGameState = initSpellGame(Date.now() >>> 0);
  let accumulator = 0;
  let lastFrame: number | undefined;

  const frame = (time: number): void => {
    if (lastFrame !== undefined) accumulator = Math.min(accumulator + (time - lastFrame), TICK_MS * MAX_CATCH_UP);
    lastFrame = time;

    const events: SpellGameEvent[] = [];
    while (accumulator >= TICK_MS) {
      const playerScreen = arena.worldToScreen(state.combat.player.position);
      const result = stepSpellGame(state, input.sample(playerScreen, SCALE));
      state = result.state;
      events.push(...result.events);
      accumulator -= TICK_MS;
    }

    const playerScreen = arena.worldToScreen(state.combat.player.position);
    const mouse = input.mouseScreen();
    arena.render(state, events, { x: mouse.x - playerScreen.x, y: mouse.y - playerScreen.y });
    hud.render(state);
    audio.handleSpellEvents(events);
    // Calm theme in the between-wave lull, combat theme once a wave is on screen.
    audio.setMusicPhase(musicPhaseForEnemyCount(state.combat.enemies.length));
    audio.update();

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
