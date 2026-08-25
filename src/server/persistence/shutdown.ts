/**
 * The graceful shutdown sequence (spec 224).
 *
 * Out of `index.ts` and into a module so it can be *tested*. Requirement 11
 * asks for a handler that cannot run twice and cannot hang, and both are
 * properties of a state machine that has nothing to do with sockets, signals or
 * a real database -- so they belong somewhere a test can call twice and drive
 * with a fake clock rather than by killing the test runner.
 *
 * Three guarantees, in the order they were each needed:
 *
 *  - **It runs once.** A second Ctrl-C is a message, not a second teardown.
 *    Two `stop()` calls racing is two flushes over one database and two closes
 *    of one connection.
 *  - **It is bounded.** A database that has wedged -- a lock nobody releases, a
 *    disk that stopped answering -- must not make the process unkillable by the
 *    signal a person actually sends. After the timeout it exits non-zero.
 *  - **It reports what it lost.** On a timeout, `strandedPlayers` is asked and
 *    named, because "up to one autosave interval of progress for these
 *    players" is the documented cost of a forced termination and the operator
 *    should not have to infer it.
 */

export interface ShutdownOptions {
  /** Stop the world: the loop, the connections, the flush, the store. */
  readonly stop: () => Promise<void>;
  /** How long the whole sequence gets before the process is killed anyway. */
  readonly timeoutMs: number;
  /** Ends the process. Injected so a test can observe it instead of dying. */
  readonly exit: (code: number) => void;
  readonly log?: (message: string) => void;
  readonly logError?: (message: string) => void;
  /** Synchronous cleanup that must happen before the async teardown starts. */
  readonly before?: () => void;
  /** How many players still have unsaved state, asked only on a timeout. */
  readonly strandedPlayers?: () => number;
  /** Injected so the bound is testable without waiting for it. */
  readonly setTimer?: (fn: () => void, ms: number) => { readonly cancel: () => void };
}

export type ShutdownHandler = (signal: string) => void;

function defaultTimer(fn: () => void, ms: number): { readonly cancel: () => void } {
  const handle = setTimeout(fn, ms);
  // Never itself a reason the process stays alive.
  handle.unref?.();
  return { cancel: (): void => clearTimeout(handle) };
}

export function createShutdown(options: ShutdownOptions): ShutdownHandler {
  const log = options.log ?? ((line: string): void => console.log(line));
  const logError = options.logError ?? ((line: string): void => console.error(line));
  const setTimer = options.setTimer ?? defaultTimer;
  let started = false;

  return function shutdown(signal: string): void {
    if (started) {
      // Deliberately not a second teardown, and it says how to force the issue
      // -- somebody pressing Ctrl-C twice wants to know that it is working on
      // it and what the harder option is.
      log('[server] already shutting down; send SIGKILL to force');
      return;
    }
    started = true;
    log(`[server] graceful shutdown started (${signal})`);

    // Armed before the work begins, so a hang anywhere inside it is covered --
    // including in `before`, which is synchronous but is somebody else's code.
    const bail = setTimer(() => {
      const stranded = options.strandedPlayers?.() ?? 0;
      logError(
        `[server] shutdown exceeded ${options.timeoutMs}ms; exiting anyway. ` +
          (stranded > 0
            ? `${stranded} player(s) were not flushed and will load from their last autosave.`
            : 'All player state had already been flushed.'),
      );
      options.exit(1);
    }, options.timeoutMs);

    try {
      options.before?.();
    } catch (error) {
      // A failure tidying up must not skip the flush, which is the part that
      // matters. Reported and carried on.
      logError(`[server] shutdown cleanup failed: ${describe(error)}`);
    }

    void options
      .stop()
      .then(() => {
        log('[server] graceful shutdown complete');
        bail.cancel();
        options.exit(0);
      })
      .catch((error: unknown) => {
        logError(`[server] shutdown failed: ${describe(error)}`);
        bail.cancel();
        options.exit(1);
      });
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
