/**
 * Whether the world is worth showing yet, and how far off it is (spec 165).
 *
 * Before this the world was simply drawn from the first frame: an empty void, a
 * body standing in it, and terrain popping in around them over the next several
 * seconds. That reads as a broken game rather than as a loading one, and the
 * only signal that existed -- `worldReady` -- was set on the *first* prop settle,
 * which is the end of the first pump of the stream and not the end of the load.
 *
 * Two questions, deliberately kept apart:
 *
 * **Where is the player?** Until the server has said, there is nothing to centre
 * a load on and nothing correct to draw -- so `locating` is its own phase rather
 * than zero progress, and the gate stays down through it however many chunks
 * happen to have arrived. This is the "show the map only when you know where the
 * player is" rule, stated where it can be tested.
 *
 * **Has the ground around them arrived?** Counted against what the map
 * *declares* near that point, so the edge of the world does not leave the bar
 * stuck below full.
 *
 * The gate **latches**. Once the world has been shown it is never taken away
 * again: walking into unstreamed ground is an ordinary streaming problem and
 * covering the screen for it would be far worse than the hole it hides. This is
 * a loading screen, not a fog.
 *
 * Pure, and time is an argument. Presentation only -- nothing here reaches the
 * sim, and the same seed and inputs must produce the same authoritative state
 * whether the gate is up or down.
 */

/** What the load is waiting on, in the order it waits on them. */
export type LoadPhase = 'connecting' | 'locating' | 'streaming' | 'meshing' | 'ready';

export interface LoadInput {
  /** Whether the server has said what map this is. */
  readonly haveMap: boolean;
  /** Whether the server has placed us. Null until it has. */
  readonly located: boolean;
  /** Declared chunks within the ready radius of the player. */
  readonly needed: number;
  /** How many of those are held. */
  readonly held: number;
  /** Chunks arrived but not yet meshed. */
  readonly meshPending: number;
}

export interface LoadProgress {
  readonly phase: LoadPhase;
  /** 0..1, and never smaller than it was. A bar that goes backwards reads as a bug. */
  readonly fraction: number;
  readonly held: number;
  readonly needed: number;
  /** One short line saying what is being waited for. */
  readonly label: string;
}

const LABELS: Record<LoadPhase, string> = {
  connecting: 'Connecting',
  locating: 'Finding you',
  streaming: 'Loading the world',
  meshing: 'Building the world',
  ready: 'Ready',
};

/**
 * The share of the bar the chunk stream owns.
 *
 * The rest is the meshing tail, which is real time on the grown map and would
 * otherwise be a bar that sits at 100% while the page is still visibly working
 * -- the exact moment a player decides something has hung.
 */
const STREAM_SHARE = 0.9;

export class LoadGate {
  private best = 0;
  private latched = false;

  /**
   * Read the load as it stands.
   *
   * `fraction` is clamped upward against everything seen before: chunk counts
   * come from a live map whose `needed` moves as the player does, and a
   * denominator that grows would otherwise walk the bar backwards.
   */
  progress(input: LoadInput): LoadProgress {
    const phase = this.phaseOf(input);
    const share =
      input.needed > 0 ? Math.min(1, input.held / input.needed) * STREAM_SHARE : STREAM_SHARE;
    const meshed = input.meshPending > 0 || input.held < input.needed ? 0 : 1 - STREAM_SHARE;
    const raw =
      phase === 'ready'
        ? 1
        : phase === 'connecting' || phase === 'locating'
          ? 0
          : share + meshed;
    this.best = Math.max(this.best, raw);
    return {
      phase,
      fraction: this.best,
      held: input.held,
      needed: input.needed,
      label: LABELS[phase],
    };
  }

  /** Whether the world may be shown. Latches true and stays there. */
  get open(): boolean {
    return this.latched;
  }

  private phaseOf(input: LoadInput): LoadPhase {
    if (this.latched) return 'ready';
    if (!input.haveMap) return 'connecting';
    // The rule this module exists for: no position, no world, whatever else has
    // arrived. Checked before the chunk counts and not after.
    if (!input.located) return 'locating';
    if (input.needed > 0 && input.held < input.needed) return 'streaming';
    if (input.meshPending > 0) return 'meshing';
    this.latched = true;
    this.best = 1;
    return 'ready';
  }
}
