/**
 * The front door (spec 255).
 *
 * DOM rather than the UI canvas, and the reason is the same one
 * `loading-overlay.ts` gives one file over: `src/ui/` can draw the theme atlas
 * and nothing else -- there is no seventh method on `UiSurface` that takes a
 * bitmap, and `docs/ui/00-architecture.md` says in as many words that the
 * client has zero image assets and is not getting a painted atlas. A title
 * screen is a *painting* with three words on it, so it is built the way the
 * loading screen and the death banner are built.
 *
 * What it is *not* is a second font. The three words are `pixelTextSvg` -- the
 * game's own 5x7 face, the one the death banner and the respawn button are set
 * in -- so the menu is the same lettering as the rest of the game rather than
 * whatever the browser would have picked.
 *
 * It sits at `z-index:35`: over the world canvas and the DOM HUD, and
 * deliberately *under* the interface canvas at 40. That one number is what lets
 * Options work. The framework's windows are drawn on the canvas above this, so
 * the options window opens over the title art the way it would in any other
 * game; and the canvas is `pointer-events:none`, so the menu underneath it
 * still takes its own clicks.
 */

import type { LoadProgress } from './loading.js';
import { withBase } from '../../audio/paths.js';
import { pixelTextSvg } from './pixel-font.js';

/**
 * Where the art lives.
 *
 * `public/`, so it is copied into `dist/` verbatim and served at the same path
 * in dev and on Pages -- and resolved through `withBase`, because Pages serves
 * the app from `/turbo-deck/` and a root-relative URL there is a 404. That is
 * spec 153's finding, and the audio catalog's own reason for `withBase`.
 *
 * Neither file is required and neither is in the repository: see
 * `docs/title-art.md` for what each one is and what it is drawn at. The
 * fallbacks below are what the screen is until they are dropped in.
 */
export const TITLE_BACKGROUND_URL = '/title/background.png';
export const TITLE_LOGO_URL = '/title/logo.png';

/**
 * What the screen is called when the logotype has not been dropped in yet.
 *
 * A missing `<img>` draws a broken-image glyph, which reads as a bug rather
 * than as art nobody has supplied -- so the fallback is the game's own face at
 * a size that carries a title, and the screen is never *wrong*, only plainer.
 */
export const TITLE_FALLBACK_WORDMARK = 'HALFSWING';

/** The line under the wordmark. */
export const TITLE_TAGLINE = 'A COZY ADVENTURE AWAITS';

/**
 * How long the title screen takes to fade once Start is pressed.
 *
 * Longer than `loading-overlay.ts`'s 260, and for the opposite reason: that one
 * is getting out of the way of something the player is waiting for, and this one
 * is a beat between deciding to play and playing. Short enough that it is never
 * something to sit through -- the world is already live underneath, and the
 * interface comes back on the frame Start is pressed rather than at the end of
 * this.
 */
export const TITLE_FADE_MS = 420;

export interface TitleOverlayOptions {
  /**
   * Begin play. The overlay hides itself before this is called, so a caller
   * with nothing to add may leave it out -- pressing Start is complete on its
   * own, and the first-run controls card (spec 255) is what hangs off it.
   */
  readonly onStart?: (() => void) | undefined;
  /** Open the options window, which is drawn on the canvas above this. */
  readonly onOptions: () => void;
  /** `import.meta.env.BASE_URL`. Injected, so this module reads no globals. */
  readonly base?: string;
}

export interface TitleOverlay {
  readonly element: HTMLElement;
  /**
   * How far the world has got.
   *
   * The title screen **is** the loading screen when it is up, which is what the
   * z-order forced and what turned out to be right anyway: at `z-index:35` the
   * overlay sits under `loading-overlay.ts`'s 50, so a player would have
   * watched a bare progress bar and *then* been shown the title -- the wrong
   * way round, and for the several seconds the world takes to stream. So
   * `view.ts` builds one or the other, never both, and this is the half that
   * greets somebody.
   *
   * Until the world is ready the menu is a progress line; after it, the menu.
   * Start cannot be pressed early because it is not there to press, which is a
   * stronger guarantee than disabling it and needs no disabled state to draw.
   */
  setProgress(progress: LoadProgress): void;
  /** Take it down. Idempotent, and it removes itself rather than going clear. */
  dismiss(): void;
  dispose(): void;
}

/** One menu entry, in the order the screen offers them. */
interface Entry {
  readonly label: string;
  readonly act: () => void;
}

export function createTitleOverlay(
  parent: HTMLElement,
  options: TitleOverlayOptions,
): TitleOverlay {
  const base = options.base ?? '/';
  const root = document.createElement('div');
  root.dataset['title'] = 'true';
  root.style.cssText = [
    'position:absolute',
    'inset:0',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:26px',
    // The ground under the art. A colour rather than nothing, so a background
    // that has not been supplied -- or has not arrived yet -- is a dark screen
    // with a title on it instead of a transparent hole onto the world.
    'background:#171423 center/cover no-repeat',
    `background-image:url("${withBase(TITLE_BACKGROUND_URL, base)}")`,
    // The art is pixel art. Whatever it is scaled to, it must not be smoothed.
    'image-rendering:pixelated',
    'user-select:none',
    // The art does not take the pointer; only the menu does.
    //
    // Options opens a framework window, and the framework hears the pointer
    // through the *world canvas*'s listeners -- which are underneath this. An
    // overlay that ate every press would therefore draw an options window
    // nobody could touch. So the painting is transparent to the pointer and the
    // buttons below re-arm it, and `view.ts` holds gameplay off for as long as
    // this is up rather than relying on the overlay to swallow it.
    'pointer-events:none',
    // Over the world and the DOM HUD, under the interface canvas. See the note
    // at the top of this file -- this number is load-bearing, not a guess.
    'z-index:35',
  ].join(';');

  /**
   * The logotype's slot, and it is a **reserved box** rather than something the
   * logotype sizes (spec 255).
   *
   * An `<img>` has no height until its bytes have arrived, so a column centred
   * on its own content is laid out twice: once around a logotype 0 pixels tall,
   * and again around one 253 pixels tall when the PNG lands. Everything on the
   * screen jumps at the moment the art appears, which is exactly the frame a
   * player is looking at it.
   *
   * A fixed height with `object-fit:contain` inside reserves the space before
   * there is anything to put in it, and does it without this file knowing the
   * art's aspect ratio -- so a logotype of any shape drops in and nothing here
   * moves. It is also what the fallback wordmark hangs in, so the two are the
   * same size on screen rather than the same font size.
   */
  const logoSlot = document.createElement('div');
  logoSlot.dataset['titleLogoSlot'] = '';
  logoSlot.style.cssText =
    'height:min(26vh,240px);width:min(62%,760px);display:flex;align-items:center;' +
    'justify-content:center;';

  const wordmark = document.createElement('img');
  wordmark.alt = TITLE_FALLBACK_WORDMARK;
  wordmark.src = withBase(TITLE_LOGO_URL, base);
  wordmark.style.cssText =
    'max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;' +
    'image-rendering:pixelated;display:block;';
  wordmark.dataset['titleLogo'] = 'image';
  // A logotype nobody has supplied yet falls back to the game's own face rather
  // than to a broken-image glyph. Replaced rather than hidden, because a title
  // screen with no title on it is the worse of the two failures.
  wordmark.addEventListener('error', () => {
    const drawn = document.createElement('div');
    drawn.dataset['titleLogo'] = 'text';
    drawn.style.cssText = 'max-width:100%;max-height:100%;display:flex;';
    drawn.innerHTML = pixelTextSvg(TITLE_FALLBACK_WORDMARK, {
      scale: 8,
      fill: '#f4c95d',
      outline: '#2a1c10',
    });
    wordmark.replaceWith(drawn);
  });
  logoSlot.append(wordmark);
  root.append(logoSlot);

  const tagline = document.createElement('div');
  tagline.dataset['titleTagline'] = '';
  tagline.style.cssText = 'margin-top:-8px;';
  tagline.innerHTML = pixelTextSvg(TITLE_TAGLINE, {
    scale: 2,
    fill: '#e8d9b0',
    outline: '#221a12',
  });
  root.append(tagline);

  /**
   * The slot the progress line and then the menu stand in.
   *
   * Reserved for the logotype's reason one block up: the menu is taller than
   * the progress line it replaces, so a column centred on its own content is
   * re-laid-out at the moment the world becomes ready -- which moves the
   * logotype somebody is looking at. Fixed here, the swap changes what is in
   * the box and nothing about where the box is.
   */
  const actionSlot = document.createElement('div');
  actionSlot.dataset['titleActions'] = '';
  actionSlot.style.cssText =
    'height:120px;display:flex;align-items:center;justify-content:center;';
  root.append(actionSlot);

  // What stands where the menu will be until the world has arrived.
  const progress = document.createElement('div');
  progress.dataset['titleProgress'] = '';
  progress.style.cssText =
    'display:flex;flex-direction:column;align-items:center;gap:10px;';
  const progressWord = document.createElement('div');
  progressWord.innerHTML = pixelTextSvg('LOADING', {
    scale: 3,
    fill: '#e8d9b0',
    outline: '#221a12',
  });
  const track = document.createElement('div');
  track.style.cssText =
    'width:min(320px,50vw);height:6px;background:#221a12;box-shadow:0 0 0 2px #221a12;';
  const fill = document.createElement('div');
  fill.dataset['titleProgressFill'] = '';
  // Eased for `loading-overlay.ts`'s reason: chunk counts arrive in steps of
  // eight or more, so an unanimated bar is a row of jumps that reads as
  // stalling between them.
  fill.style.cssText = 'width:0%;height:100%;background:#f4c95d;transition:width 180ms linear;';
  track.append(fill);
  progress.append(progressWord, track);
  actionSlot.append(progress);

  const menu = document.createElement('div');
  menu.dataset['titleMenu'] = '';
  menu.style.cssText = 'display:none;flex-direction:column;align-items:center;gap:12px;';
  actionSlot.append(menu);

  let dismissed = false;
  let fadeTimer = 0;

  /**
   * Take the screen down.
   *
   * `fade` is what Start does and what a teardown does not: leaving the title
   * screen is a moment the player made and is worth a beat, where a tab switch
   * is somebody already looking at something else.
   *
   * Either way the element is **removed** at the end rather than left at zero
   * opacity -- `loading-overlay.ts`'s rule, and the reason it gives: an element
   * with `inset:0` still eats every pointer event that lands on it, and a title
   * screen that silently swallows the first click of the game is worse than one
   * that never went away. Here it would swallow only the presses its own menu
   * re-armed, which is worse still: a hole in the world where START used to be.
   *
   * The keyboard goes on the first frame of the fade rather than at the end of
   * it, because the menu is on its way out from the moment it is asked to be:
   * an Enter during the fade would press an entry the player can barely see.
   */
  const dismiss = (fade = true): void => {
    if (dismissed) return;
    dismissed = true;
    window.removeEventListener('keydown', onKeyDown, true);
    if (!fade) {
      root.remove();
      return;
    }
    root.style.transition = `opacity ${TITLE_FADE_MS}ms ease-out`;
    root.style.opacity = '0';
    // Nothing under a fading title screen should be reachable *through* it
    // either: the menu's buttons re-armed the pointer, and a half-transparent
    // START is still a button until it is gone.
    root.style.pointerEvents = 'none';
    fadeTimer = window.setTimeout(() => root.remove(), TITLE_FADE_MS);
  };

  const entries: readonly Entry[] = [
    {
      label: 'START',
      act: () => {
        dismiss();
        options.onStart?.();
      },
    },
    // Opens on the canvas *above* this overlay, so the title stays behind it.
    { label: 'OPTIONS', act: () => options.onOptions() },
  ];

  let selected = 0;
  const buttons: HTMLButtonElement[] = [];

  const paint = (): void => {
    buttons.forEach((button, index) => {
      const on = index === selected;
      const marker = button.firstElementChild as HTMLElement | null;
      if (marker) marker.style.opacity = on ? '1' : '0';
      const text = button.lastElementChild as HTMLElement | null;
      if (!text) return;
      // The selected entry is the accent the rest of the interface uses for a
      // title bar; the others are the parchment the tagline is set in. Two
      // tones rather than a highlight box, because a box around a word on top
      // of a painting is chrome the painting did not ask for.
      text.innerHTML = pixelTextSvg(entries[index]?.label ?? '', {
        scale: 4,
        fill: on ? '#f4c95d' : '#e8d9b0',
        outline: '#221a12',
      });
    });
  };

  entries.forEach((entry, index) => {
    const button = document.createElement('button');
    button.dataset['titleEntry'] = entry.label.toLowerCase();
    button.setAttribute('aria-label', entry.label);
    button.style.cssText =
      'display:flex;align-items:center;gap:12px;background:none;border:none;padding:2px 6px;' +
      'cursor:pointer;pointer-events:auto;';

    // The selection mark. A square rather than a glyph, because the 5x7 face
    // has no diamond in it and inventing one for a 6px mark is a glyph nobody
    // else will ever use.
    const marker = document.createElement('span');
    marker.style.cssText =
      'width:10px;height:10px;background:#f4c95d;box-shadow:0 0 0 2px #221a12;opacity:0;';
    const text = document.createElement('span');
    // The whole box takes the click, not the letters.
    //
    // A word set in `pixelTextSvg` is an `<svg>` whose only content is a glyph
    // `<path>`, and an SVG path is hit-tested against its *filled geometry* --
    // so with the letters live, the gaps between them are holes, and the
    // button's own centre (between the A and the R of START) is one of them.
    // The respawn button gets away with the same construction only because it
    // has a background colour behind its word. Nothing here does, so the
    // children are taken out of the hit test and the button keeps its own box.
    marker.style.pointerEvents = 'none';
    text.style.pointerEvents = 'none';
    button.append(marker, text);

    button.addEventListener('pointerenter', () => {
      selected = index;
      paint();
    });
    button.addEventListener('click', () => {
      selected = index;
      paint();
      entry.act();
    });
    menu.append(button);
    buttons.push(button);
  });
  paint();

  /**
   * The keyboard half.
   *
   * Captured on the window, because the world's own `keydown` listeners are on
   * the window too and a `W` pressed at the title screen must not also walk a
   * body nobody can see. Everything this screen recognises is consumed; a key
   * it does not recognise is left alone.
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (dismissed) return;
    const step = event.code === 'ArrowDown' ? 1 : event.code === 'ArrowUp' ? -1 : 0;
    if (step !== 0) {
      selected = (selected + step + entries.length) % entries.length;
      paint();
    } else if (event.code === 'Enter' || event.code === 'NumpadEnter' || event.code === 'Space') {
      entries[selected]?.act();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
  window.addEventListener('keydown', onKeyDown, true);

  parent.append(root);

  let ready = false;

  return {
    element: root,
    setProgress(next: LoadProgress): void {
      if (dismissed) return;
      fill.style.width = `${Math.round(next.fraction * 100)}%`;
      if (ready || next.phase !== 'ready') return;
      ready = true;
      // Published for the harnesses, which cannot tell "the menu is not there
      // yet" from "the menu never came" by looking at pixels.
      root.dataset['titleReady'] = 'true';
      progress.remove();
      menu.style.display = 'flex';
    },
    dismiss: () => dismiss(),
    dispose(): void {
      window.clearTimeout(fadeTimer);
      dismiss(false);
      root.remove();
    },
  };
}
