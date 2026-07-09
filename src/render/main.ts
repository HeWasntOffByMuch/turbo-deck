import { initGame } from '../game/session.js';
import { GameAudio } from './audio.js';
import { InputCapture } from './input.js';
import { GameLoop } from './loop.js';
import { Scene } from './scene.js';

// Cosmetic identity: seeds the deterministic dude sprites (one per player name,
// one per enemy type). Singleplayer for now, so a single fixed pair.
const IDENTITY = { playerName: 'Rook', enemyType: 'Brawler' };

// A deliberately mixed deck: active attacks/heals plus passives whose modifiers
// stack in ways the player discovers (e.g. Reckless Hex + Blood Pact = sustain).
const DECK = [
  'fireball',
  'fireball',
  'iceshard',
  'iceshard',
  'emberlash',
  'guardbreak',
  'mend',
  'warcry',
  'sharpen',
  'momentum',
  'vigor',
  'focus',
  'bloodpact',
  'recklesshex',
];

async function main(): Promise<void> {
  const container = document.getElementById('app');
  if (!container) throw new Error('missing #app element');

  const scene = await Scene.create(container, IDENTITY);

  const controls = document.createElement('div');
  controls.style.cssText = 'color:#9a9ab0;font:12px monospace;margin-top:8px;';
  controls.textContent =
    'move: WASD / arrows  |  aim: mouse  |  attack: click or space  |  parry: K  |  dodge: L  |  card: 1/2/3  |  bonus: B  |  mute: M';
  container.appendChild(controls);

  const seed = Date.now();
  const initialState = initGame(seed, DECK);

  const input = new InputCapture();
  input.attach(window, scene.canvas);

  // Synthesized retro-arcade soundtrack + attack SFX. The AudioContext can only
  // start from a user gesture, so we resume it on the first key/pointer input;
  // 'M' toggles mute.
  const audio = new GameAudio();
  const unlock = (): void => audio.resume();
  window.addEventListener('keydown', (e) => {
    unlock();
    if (e.key === 'm' || e.key === 'M') audio.toggleMute();
  });
  window.addEventListener('pointerdown', unlock);

  const loop = new GameLoop(
    initialState,
    (state) => input.sample(scene.worldToScreen(state.combat.player.position)),
    (state, events) => {
      const playerScreen = scene.worldToScreen(state.combat.player.position);
      const mouse = input.mouseScreen();
      scene.render(state, events, { x: mouse.x - playerScreen.x, y: mouse.y - playerScreen.y });
      audio.handleEvents(events);
      audio.update();
    },
  );
  loop.start();
}

void main();
