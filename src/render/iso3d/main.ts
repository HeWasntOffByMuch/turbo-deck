/**
 * Entry point and tab shell (specs 031, 062).
 *
 * The combat, movement and rig-debug tabs went with the card game they existed
 * to exercise. What is left is the play view -- a plain canvas over a real
 * server session, so the ability system is testable now -- and the map editor,
 * which never depended on any of it.
 *
 * The shell makes no game decisions. It mounts a view, starts it when shown and
 * stops it when hidden; every rule lives on the server and every pixel is a
 * `ViewHandle`'s business.
 */

import { mountPlay } from '../play/view.js';
import { mountEditor } from './editor/view.js';
import type { ViewHandle } from './view-handle.js';

interface Tab {
  readonly label: string;
  readonly mount: (container: HTMLElement) => ViewHandle;
  /**
   * Whether the view owns the whole window (spec 041), with its own UI floating
   * over it, rather than laying out normally below the tab bar. A property
   * rather than an index check: the editor is the second such view, and which
   * ones they are is a fact about the views, not about their order in the bar.
   */
  readonly fullscreen?: boolean;
}

function main(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('missing #app');

  const tabs: readonly Tab[] = [
    { label: 'Play', mount: mountPlay, fullscreen: true },
    { label: 'Map editor', mount: mountEditor, fullscreen: true },
  ];

  // The bar floats over the game window rather than pushing it down (spec 041);
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
      // A fullscreen view owns the whole window; the sandbox tabs lay out
      // normally and just need headroom so the floating tab bar doesn't cover them.
      if (!tab.fullscreen) handle.element.style.padding = '44px 16px 16px';
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
