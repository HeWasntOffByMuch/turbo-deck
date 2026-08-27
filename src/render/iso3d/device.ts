/**
 * Whether the thing holding this page is a phone (spec 141).
 *
 * Spec 093 asked `(pointer: coarse)` when the only thing riding on the answer
 * was whether to offer a fullscreen button, and spec 140 put six decisions on
 * the same query without revisiting it. A real Android phone then loaded the
 * deployed build and got the desktop frame: six tab buttons across the world,
 * seven tuning popovers in the corner, the developer readout over the grass.
 *
 * `(pointer: coarse)` describes the *primary* pointing device, and a browser is
 * free to say "fine" about a touchscreen. Chrome's "Desktop site" does exactly
 * that on purpose, along with faking a ~980px layout viewport; a stylus, a
 * paired mouse and a few OEM builds do the same. One query that can be wrong
 * became six things that are.
 *
 * So the question is asked of several facts rather than one, and the rule over
 * them is pure -- every device is a row in a test rather than a thing somebody
 * has to be holding.
 *
 * There is one machine those facts cannot separate, and `frameOverride` below is
 * the answer to it (spec 230).
 */

/** What the page can find out about the device, gathered in one place. */
export interface DeviceFacts {
  /** `(pointer: coarse)` -- the *primary* pointer is a finger. */
  readonly coarsePointer: boolean;
  /** `(any-pointer: coarse)` -- *some* available pointer is a finger. */
  readonly anyCoarsePointer: boolean;
  /** `navigator.maxTouchPoints`. Zero on a machine with no touchscreen. */
  readonly maxTouchPoints: number;
  /** The window, CSS px. Only its shorter side is read. */
  readonly viewport: { readonly width: number; readonly height: number };
}

/**
 * The largest short side, CSS px, that a touch device is still handheld at.
 *
 * A phone held sideways is ~390 tall, and ~450 even in desktop-site mode where
 * the viewport is inflated to ~980 wide. 620 clears both, and clears an iPad's
 * 768 short side by enough to be a decision rather than a coincidence -- a
 * tablet reaches the compact frame through the coarse-pointer rule instead,
 * which is true on every tablet that has not been told to lie.
 */
export const HANDHELD_MAX_SHORT_SIDE = 620;

/**
 * Whether to draw the phone frame.
 *
 * Three rules, in order:
 *
 *  1. **No touch anywhere is never handheld.** A machine with no touchscreen is
 *     a desktop whatever its window is doing, which is what keeps a narrowed
 *     browser out of the phone layout -- spec 094's "a phone does not become a
 *     desktop", holding from the other end.
 *  2. **A coarse primary pointer is handheld.** The old rule, kept: when it is
 *     true it is right, and it is what a tablet and an honest phone answer.
 *  3. **Touch plus a small frame is handheld.** The rule that catches the
 *     photograph this spec came from. Desktop-site mode lies about the pointer
 *     and inflates the viewport, but `maxTouchPoints` is a hardware count and
 *     nothing fakes it -- and the *short* side of a phone stays phone-sized
 *     however wide the layout claims to be.
 *
 * The short side rather than the width, so turning the phone over cannot change
 * the layout. That is what lets this be decided once, at mount, with no resize
 * listener (spec 094).
 */
export function isHandheld(facts: DeviceFacts): boolean {
  const touchable = facts.maxTouchPoints > 0 || facts.anyCoarsePointer;
  if (!touchable) return false;
  if (facts.coarsePointer) return true;
  const shortSide = Math.min(facts.viewport.width, facts.viewport.height);
  // A frame measured before layout is zero or negative in more places than one,
  // and "no size yet" is not evidence of a phone.
  if (!(shortSide > 0)) return false;
  return shortSide <= HANDHELD_MAX_SHORT_SIDE;
}

/**
 * The facts, read off the browser. The one impure line in this file.
 *
 * Every field is defended, because this runs before anything else and a missing
 * `matchMedia` must cost the phone layout rather than the page.
 */
export function readDeviceFacts(): DeviceFacts {
  const ask = (query: string): boolean =>
    typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  return {
    coarsePointer: ask('(pointer: coarse)'),
    anyCoarsePointer: ask('(any-pointer: coarse)'),
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

/**
 * The frame a URL asked for, or null when it asked for nothing (spec 230).
 *
 * `isHandheld` is a *measurement*, and there is a machine it cannot measure: a
 * small touchscreen desktop reports a hardware touch count, a fine primary
 * pointer and a frame under `HANDHELD_MAX_SHORT_SIDE`, which is every fact a
 * phone in desktop-site mode reports. A Steam Deck in SteamOS desktop mode is
 * that machine -- a 1280x800 panel is under the threshold once the browser's
 * chrome and any display scale are off it -- and it arrives at the compact
 * frame with a keyboard and a trackpad attached.
 *
 * Moving the threshold is the wrong repair. 620 was chosen against a real
 * photograph of a real phone, and every number above it restores the bug spec
 * 141 closed; on the four facts the two machines are the same machine. So the
 * answer becomes sayable rather than better guessed at.
 *
 * Both directions, because the useful one is not only the one that prompted it:
 * `?frame=phone` is how the compact layout gets looked at without a phone in
 * your hand.
 *
 * An unrecognised value defers to the measurement rather than throwing or
 * picking a side -- a misspelled flag should cost the flag, not the frame.
 */
export function frameOverride(search: string): boolean | null {
  const raw = new URLSearchParams(search).get('frame');
  if (raw === null) return null;
  const name = raw.trim().toLowerCase();
  if (name === 'desktop') return false;
  if (name === 'phone') return true;
  return null;
}

/**
 * Whether this device gets the phone frame. What every caller actually wants.
 *
 * Asked once and remembered: it is a question about the hardware, and the
 * answer has to be the same for the tab bar, the HUD and the fullscreen button
 * or the frame is half of each. Deciding it once is also what spec 094 asked
 * for -- a phone does not become a desktop while somebody is playing.
 *
 * The override is applied here rather than inside `isHandheld` (spec 230): it is
 * a person's answer rather than a fact about the hardware, and putting it in
 * `DeviceFacts` would make the device table a table of two different kinds of
 * thing. Here it is also the only place it needs to be -- every caller comes
 * through this function, so none of them learns that an override exists and the
 * rule above about all of them agreeing holds for free.
 */
let cached: boolean | null = null;
export function isHandheldDevice(): boolean {
  cached ??= frameOverride(window.location?.search ?? '') ?? isHandheld(readDeviceFacts());
  return cached;
}
