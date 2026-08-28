/**
 * Entry point and tab shell (specs 031, 062, 063, 066).
 *
 * Six tabs, and only the first of them is the game: since spec 063 it is the
 * isometric world -- terrain, props, rigs and shadows -- reading a replicated
 * server view rather than simulating anything itself.
 *
 * The others are workshops. The movement sandbox and the rig debugger
 * (specs 032/035, back since 066) drive one unit over the sandbox mover so a
 * gait, a cloth solve or a turn rate can be watched and tuned with no game in
 * the way; the map editor authors the world document. The flat debug canvas 062
 * stood up as a stopgap left with 066 -- the isometric view it stood in for came
 * back a spec earlier.
 *
 * The shell makes no game decisions. It mounts a view, starts it when shown and
 * stops it when hidden; every rule lives on the server and every pixel is a
 * `ViewHandle`'s business.
 */

import { mountEditor } from './editor/view.js';
import { mountStudio } from './studio/view.js';
import { mountVfxStudio } from './studio/vfx-view.js';
import { mountSfx } from './sfx/view.js';
import { mountWorld } from './world/view.js';
import { mountMovement } from './movement.js';
import { mountDebug } from './debug-view.js';
import type { ViewHandle } from './view-handle.js';
import { createFullscreenButton } from './fullscreen.js';
import { isHandheldDevice } from './device.js';
import { showsWorkbenches } from './client-build.js';
import { mountLanded, showsTabButtons, tabPress, visibleTabs } from './shell-tabs.js';

interface Tab {
  readonly label: string;
  /**
   * Asynchronous since spec 203: the Play tab and the editor fetch the shipped
   * map rather than carrying it in the bundle, and the await belongs at this
   * boundary rather than threaded through a 1700-line view. A tab that needs
   * nothing may still return a handle directly.
   */
  readonly mount: (container: HTMLElement) => ViewHandle | Promise<ViewHandle>;
  /**
   * Whether this tab is the game rather than a workbench (spec 140).
   *
   * A phone is offered only the tabs that carry it: the editor is a three-button
   * drag model and the sandboxes and studios are walls of sliders, so on a
   * finger they are buttons that lead somewhere unusable.
   */
  readonly game?: boolean;
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

  const all: readonly Tab[] = [
    { label: 'Play', mount: mountWorld, fullscreen: true, game: true },
    { label: 'Movement sandbox', mount: mountMovement },
    { label: 'Rig debug', mount: mountDebug },
    { label: 'Map editor', mount: mountEditor, fullscreen: true },
    // Spec 109. Not fullscreen: Play and the editor own the window because they
    // are a window onto the world, and this is a form.
    { label: 'Studio', mount: mountStudio },
    // Spec 122. Also a workshop rather than a window onto the world: a browser, a
    // preview and a wall of parameters, so it lays out under the bar like the
    // other benches rather than owning the screen.
    { label: 'VFX', mount: mountVfxStudio },
    // Spec 229, and the seventh. A tree and a form, so it lays out under the bar
    // like the VFX bench beside it rather than owning the screen -- and a
    // workbench, so a phone is not offered it: assigning files to events is a
    // two-column tool with a file picker in it.
    { label: 'SFX', mount: mountSfx },
  ];

  // A phone gets the game and nothing else (spec 140), and so does the shipped
  // client (spec 252) -- two reasons, one filter, because two would be two
  // answers to which tabs are the game. `showsTabButtons` then draws no strip at
  // all, so the game build opens with nothing across the top of the world.
  const tabs = visibleTabs(all, isHandheldDevice() || !showsWorkbenches());

  // The bar floats over the game window rather than pushing it down (spec 041);
  // the container beneath it is the full viewport, and the sandbox tabs scroll
  // inside it with enough headroom to clear the bar.
  const bar = document.createElement('div');
  // The inset keeps the bar out from under a notch in landscape, where the
  // cutout is on the left edge rather than the top (spec 093).
  bar.style.cssText =
    'position:fixed;top:0;left:0;z-index:50;display:flex;gap:6px;flex-wrap:wrap;' +
    'padding:calc(6px + env(safe-area-inset-top)) 8px 0 calc(8px + env(safe-area-inset-left));';
  // Named so a view can ask where the app's chrome ends. The bar is fixed and
  // floats over the whole container, so anything a view opens at the top of the
  // screen -- a framework window (spec 131) -- opens underneath it unless it
  // knows. It wraps, so the height is a measurement rather than a constant.
  bar.dataset['tabBar'] = '';
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

  /**
   * Which tabs are mid-mount (spec 203).
   *
   * A mount can take a network round trip now, and two things go wrong without
   * this. Pressing a tab twice would mount it twice -- two views, two servers,
   * one of them orphaned and still running. And `active` is set when the mount
   * *finishes*, so a second press during the wait would see `i !== active` and
   * start a second one.
   */
  const mounting = new Set<number>();

  const activate = (i: number): void => {
    const tab = tabs[i];
    if (!tab) return;
    const press = tabPress(i, active, mounting, handles[i]);
    if (press === 'ignore') return;
    const prev = active >= 0 ? handles[active] : null;
    if (prev) {
      prev.stop();
      prev.element.style.display = 'none';
    }
    // The button lights immediately: the press is answered even when the view
    // behind it is still fetching, and a bar that does nothing for a second
    // reads as a dropped click.
    active = i;
    buttons.forEach((btn, j) => styleButton(btn, j === i));

    if (press === 'show') {
      const held = handles[i];
      if (held) show(tab, held);
      return;
    }
    const mounted = tab.mount(container);
    if (!(mounted instanceof Promise)) {
      handles[i] = mounted;
      show(tab, mounted);
      return;
    }
    mounting.add(i);
    void mounted
      .then((handle) => {
        mounting.delete(i);
        handles[i] = handle;
        if (mountLanded(i, active) === 'shelve') {
          handle.element.style.display = 'none';
          return;
        }
        show(tab, handle);
      })
      .catch((error: unknown) => {
        mounting.delete(i);
        // A tab that could not load says so where the tab would have been. The
        // alternative is a blank rectangle, which reads as the app being broken
        // rather than as one view failing.
        if (active !== i) return;
        const message = document.createElement('pre');
        message.style.cssText = 'padding:44px 16px 16px;color:#f0a0a0;font-family:ui-monospace,monospace;';
        message.textContent = `${tab.label} could not start:\n${error instanceof Error ? error.message : String(error)}`;
        container.appendChild(message);
      });
  };

  const show = (tab: Tab, handle: ViewHandle): void => {
    // A fullscreen view owns the whole window; the sandbox tabs lay out
    // normally and just need headroom so the floating tab bar doesn't cover them.
    if (!tab.fullscreen) handle.element.style.padding = '44px 16px 16px';
    handle.element.style.display = 'block';
    handle.start();
  };

  // No buttons when there is only one tab to be on: a strip you cannot leave is
  // furniture, and on a phone it is furniture across the top of the world. The
  // bar itself stays -- `ui-layer.ts` measures it to know where the app's chrome
  // ends, and the fullscreen button below lives in it.
  if (showsTabButtons(tabs)) {
    tabs.forEach((tab, i) => {
      const btn = document.createElement('button');
      btn.textContent = tab.label;
      styleButton(btn, false);
      btn.addEventListener('click', () => activate(i));
      bar.appendChild(btn);
      buttons.push(btn);
    });
  }

  // On a phone the browser chrome is a third of a landscape screen (spec 093).
  // Null on anything that cannot go fullscreen or is not driven by a finger, so
  // the desktop bar keeps its tab buttons and nothing else.
  //
  // It is the one control left in the bar on a phone (spec 140), and it stays
  // for the reason the rest went: the whole point of a phone pass is the frame,
  // and a third of this one is browser chrome.
  const fullscreen = createFullscreenButton(app, { style: (btn) => styleButton(btn, false) });
  if (fullscreen) bar.appendChild(fullscreen);

  activate(0);
}

main();
