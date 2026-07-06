import { initGame } from '../game/session.js';
import { InputCapture } from './input.js';
import { GameLoop } from './loop.js';
import { Scene } from './scene.js';

const DECK = [
  'fireball',
  'fireball',
  'fireball',
  'emberlash',
  'emberlash',
  'emberlash',
  'iceshard',
  'iceshard',
  'iceshard',
  'frostbite',
  'frostbite',
  'guardbreak',
  'guardbreak',
  'manasurge',
  'manasurge',
];

async function main(): Promise<void> {
  const container = document.getElementById('app');
  if (!container) throw new Error('missing #app element');

  const scene = await Scene.create(container);

  const controls = document.createElement('div');
  controls.style.cssText = 'color:#9a9ab0;font:12px monospace;margin-top:8px;';
  controls.textContent =
    'move: WASD / arrows  |  aim: mouse  |  attack: click or space  |  parry: K  |  dodge: L  |  card: 1/2/3  |  bonus: B';
  container.appendChild(controls);

  const seed = Date.now();
  const initialState = initGame(seed, DECK);

  const input = new InputCapture();
  input.attach(window, scene.canvas);

  const loop = new GameLoop(
    initialState,
    (state) => input.sample(scene.worldToScreen(state.combat.player.position)),
    (state, events) => {
      const playerScreen = scene.worldToScreen(state.combat.player.position);
      const mouse = input.mouseScreen();
      scene.render(state, events, { x: mouse.x - playerScreen.x, y: mouse.y - playerScreen.y });
    },
  );
  loop.start();
}

void main();
