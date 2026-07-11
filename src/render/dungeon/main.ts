import { initDungeonGame, stepDungeonGame, type DungeonGameEvent, type DungeonGameState, type DungeonInput } from '../../game/dungeon-session.js';
import type { SpellGameEvent } from '../../game/spell-session.js';
import { TICK_RATE } from '../../sim/constants.js';
import { GameAudio } from '../audio.js';
import { musicPhaseFor } from '../music.js';
import { SpellHud } from '../spells/hud.js';
import { SpellInputCapture } from '../spells/input.js';
import { DungeonView } from './view.js';

/**
 * Entry point for the dungeon mode (spec 027). Wires the Canvas2D tileset view,
 * the reused spell-card HUD, and keyboard/mouse input to the deterministic
 * dungeon session (which wraps the full spell game) through a fixed-timestep
 * loop — the one place real elapsed time becomes sim ticks. No game rules here.
 */

const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP = 8;

function main(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('missing #app');

  const title = document.createElement('div');
  title.style.cssText = "font-family:'Segoe UI',system-ui,sans-serif;color:#c9c9d8;margin:6px 2px 10px;font-size:13px;";
  title.textContent =
    'turbo-deck · procedural dungeon — WASD move, mouse aim, play spell cards (1–4). Rooms seal on entry and reopen once every enemy inside is defeated. (R restarts · M mutes)';
  app.appendChild(title);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.5);cursor:crosshair;';
  app.appendChild(canvas);

  const hudRoot = document.createElement('div');
  app.appendChild(hudRoot);

  const view = new DungeonView(canvas);
  const input = new SpellInputCapture(canvas);
  input.attach(window);
  const hud = new SpellHud(hudRoot, input);
  // No waves in a dungeon: hide the reused HUD's Spawn Wave control.
  hudRoot.querySelector<HTMLElement>('.sp-wave')?.style.setProperty('display', 'none');

  const audio = new GameAudio();
  const unlock = (): void => audio.resume();
  let restart = false;
  window.addEventListener('keydown', (e) => {
    unlock();
    if (e.code === 'KeyM') audio.toggleMute();
    else if (e.code === 'KeyR') restart = true;
  });
  window.addEventListener('pointerdown', unlock);

  // A `#seed=123` hash pins the layout (handy for sharing/repro); else random.
  const hashSeed = Number.parseInt(new URLSearchParams(location.hash.slice(1)).get('seed') ?? '', 10);
  let seed = Number.isFinite(hashSeed) ? hashSeed >>> 0 : Date.now() >>> 0;
  let state: DungeonGameState = initDungeonGame(seed);
  let accumulator = 0;
  let lastFrame: number | undefined;

  const frame = (time: number): void => {
    if (lastFrame !== undefined) accumulator = Math.min(accumulator + (time - lastFrame), TICK_MS * MAX_CATCH_UP);
    lastFrame = time;

    if (restart) {
      restart = false;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      state = initDungeonGame(seed);
    }

    const events: DungeonGameEvent[] = [];
    while (accumulator >= TICK_MS) {
      const playerScreen = view.worldToScreen(state.spell.combat.player.position);
      const sampled = input.sample(playerScreen, 1);
      const world = view.screenToWorld(input.mouseScreen());
      // Aim comes from the cursor direction; the target is the world point under it.
      const dungInput: DungeonInput = {
        moveX: sampled.moveX,
        moveY: sampled.moveY,
        aimX: sampled.aimX,
        aimY: sampled.aimY,
        targetX: world.x,
        targetY: world.y,
        ...(sampled.playHandIndex !== undefined ? { playHandIndex: sampled.playHandIndex } : {}),
      };
      const result = stepDungeonGame(state, dungInput);
      state = result.state;
      events.push(...result.events);
      accumulator -= TICK_MS;
    }

    const playerScreen = view.worldToScreen(state.spell.combat.player.position);
    const mouse = input.mouseScreen();
    view.render(state, events, { x: mouse.x - playerScreen.x, y: mouse.y - playerScreen.y });
    hud.render(state.spell);
    const spellEvents = events.filter(
      (e): e is SpellGameEvent => e.kind !== 'roomEntered' && e.kind !== 'roomCleared' && e.kind !== 'dungeonComplete',
    );
    audio.handleSpellEvents(spellEvents);
    audio.setMusicPhase(musicPhaseFor(state.spell.combat.enemies.length, state.spell.combat.over));
    audio.update();

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
