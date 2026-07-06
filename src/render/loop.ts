import { CARD_CATALOG, SYNERGY_DEFS } from '../cards/catalog.js';
import { stepGame, type GameEvent, type GameInput, type GameState } from '../game/session.js';
import { TICK_RATE } from '../sim/constants.js';

const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP_TICKS = 10; // avoid a spiral of death after a long tab-backgrounding pause

/**
 * Fixed-timestep accumulator: decouples real elapsed time (however the
 * browser paints) from the sim's 60hz tick rate. Every tick, it samples
 * input and steps the sim exactly once; it makes no gameplay decisions.
 */
export class GameLoop {
  private state: GameState;
  private accumulatorMs = 0;
  private lastFrameTime: number | undefined;
  private handle: number | undefined;

  constructor(
    initialState: GameState,
    private readonly sampleInput: () => GameInput,
    private readonly onTick: (state: GameState, events: readonly GameEvent[]) => void,
  ) {
    this.state = initialState;
  }

  start(): void {
    const frame = (time: number): void => {
      if (this.lastFrameTime !== undefined) {
        this.accumulatorMs = Math.min(this.accumulatorMs + (time - this.lastFrameTime), TICK_MS * MAX_CATCH_UP_TICKS);
      }
      this.lastFrameTime = time;

      const events: GameEvent[] = [];
      while (this.accumulatorMs >= TICK_MS) {
        const result = stepGame(this.state, this.sampleInput(), CARD_CATALOG, SYNERGY_DEFS);
        this.state = result.state;
        events.push(...result.events);
        this.accumulatorMs -= TICK_MS;
      }
      this.onTick(this.state, events);

      this.handle = requestAnimationFrame(frame);
    };
    this.handle = requestAnimationFrame(frame);
  }

  stop(): void {
    if (this.handle !== undefined) {
      cancelAnimationFrame(this.handle);
    }
  }
}
