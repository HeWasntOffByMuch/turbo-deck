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
    'move: ←/→ or A/D  |  attack: space  |  parry: K  |  dodge: L  |  play card: 1/2/3  |  play bonus: B';
  container.appendChild(controls);

  const seed = Date.now();
  const initialState = initGame(seed, DECK);

  const input = new InputCapture();
  input.attach(window);

  const loop = new GameLoop(
    initialState,
    () => input.sample(),
    (state, events) => scene.render(state, events),
  );
  loop.start();
}

void main();
