/**
 * The fullscreen button (spec 093).
 *
 * It lives in the tab bar rather than in the play view, because going fullscreen
 * is a fact about the window rather than about the game, and the tab bar is the
 * only furniture every tab shares. Nothing here decides a game outcome; it asks
 * the browser for the whole screen and reports whether it got it.
 *
 * Deliberately not tested: it is three API calls, all of them permission-gated
 * and none of them available in Node. What *is* decidable -- whether the button
 * should exist at all -- is one feature check, kept here beside its use.
 */

/** Safari's spelling, which iPadOS shipped for years before the standard one. */
interface WebkitFullscreen {
  webkitRequestFullscreen?: () => Promise<void> | void;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
}

/**
 * `lock` is absent on desktop Safari and rejects nearly everywhere else, which
 * is why every call to it below is fire-and-forget.
 */
interface LockableOrientation {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
}

/**
 * Swallow a rejection on purpose.
 *
 * Every call below is permission-gated and routinely refused -- fullscreen by a
 * gesture the browser did not trust, orientation by every desktop and by iOS.
 * There is nothing to do about any of them, and an unhandled rejection in the
 * console is a worse outcome than a phone the player turns themselves. Named,
 * rather than three bare `() => {}`s, so it reads as a decision.
 */
function ignore(): void {
  return;
}

function fullscreenElement(): Element | null {
  const doc = document as Document & WebkitFullscreen;
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/**
 * Whether this browser can put an element fullscreen at all.
 *
 * iPhone Safari still cannot -- iPad has had it since 16.4 -- so on that one
 * device the button does not appear, and the fallback is the home-screen install
 * that `mobile-web-app-capable` in the head asks for. A button that silently did
 * nothing would be worse than no button.
 */
export function canGoFullscreen(): boolean {
  const element = document.documentElement as HTMLElement & WebkitFullscreen;
  return typeof element.requestFullscreen === 'function' || typeof element.webkitRequestFullscreen === 'function';
}

/**
 * Whether the pointer driving this page is a finger.
 *
 * The button is only worth its place in the bar on a device whose browser chrome
 * is eating a third of the screen. A desktop can press F11.
 */
export function isCoarsePointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

export interface FullscreenButtonOptions {
  /** Style hook, so the button matches whatever bar it is mounted in. */
  readonly style: (button: HTMLButtonElement) => void;
}

/**
 * The button, or null when this browser or this device has no use for one.
 *
 * `target` is what goes fullscreen -- `#app`, so the tab bar and the HUD come
 * along rather than being left behind with the browser chrome.
 */
export function createFullscreenButton(
  target: HTMLElement,
  options: FullscreenButtonOptions,
): HTMLButtonElement | null {
  if (!canGoFullscreen() || !isCoarsePointer()) return null;

  const button = document.createElement('button');
  options.style(button);

  const label = (): void => {
    const on = fullscreenElement() !== null;
    button.textContent = on ? '⤡' : '⛶';
    button.title = on ? 'Leave fullscreen' : 'Fullscreen (landscape)';
    button.setAttribute('aria-label', button.title);
  };

  const enter = (): void => {
    const element = target as HTMLElement & WebkitFullscreen;
    const request = element.requestFullscreen?.bind(element) ?? element.webkitRequestFullscreen?.bind(element);
    if (!request) return;
    // Orientation may only be locked from inside fullscreen, so it is asked for
    // after the request settles -- and the rejection is swallowed, because
    // locking is unsupported on desktop and on iOS and an unhandled rejection in
    // the console is a worse outcome than a phone the player turns themselves.
    void Promise.resolve(request()).then(() => {
      const orientation = screen.orientation as (ScreenOrientation & LockableOrientation) | undefined;
      void orientation?.lock?.('landscape').catch(ignore);
    }, ignore);
  };

  const leave = (): void => {
    const doc = document as Document & WebkitFullscreen;
    const orientation = screen.orientation as (ScreenOrientation & LockableOrientation) | undefined;
    orientation?.unlock?.();
    const exit = doc.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document);
    if (exit) void Promise.resolve(exit()).catch(ignore);
  };

  button.addEventListener('click', () => {
    if (fullscreenElement() === null) enter();
    else leave();
  });

  // The player can also leave with the system back gesture or Escape, so the
  // label follows the document rather than the button's own clicks.
  document.addEventListener('fullscreenchange', label);
  document.addEventListener('webkitfullscreenchange', label);
  label();

  return button;
}
