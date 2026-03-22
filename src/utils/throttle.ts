export interface ThrottleOptions {
  /** Minimum milliseconds between executions. */
  intervalMs: number;
}

/**
 * A callable throttle handle with `flush` and `cancel` control methods.
 *
 * Calling it schedules `fn` for execution according to the throttle rules.
 * `flush()` runs any pending call immediately and returns its promise.
 * `cancel()` silently drops the pending call.
 */
export interface Throttle {
  (fn: () => Promise<void>): Promise<void>;
  flush(): Promise<void>;
  cancel(): void;
}

/**
 * Create a trailing-edge throttle:
 *
 * - The **first** call in an idle period executes immediately.
 * - **Subsequent** calls within `intervalMs` replace the pending call;
 *   only the **latest** one runs (trailing edge).
 * - The replaced call's promise is resolved as a silent no-op.
 * - `flush()` executes any pending call immediately.
 * - `cancel()` drops the pending call (resolved silently).
 */
export function createThrottle(opts: ThrottleOptions): Throttle {
  let lastExecutionTime = 0;
  let pending: (() => Promise<void>) | null = null;
  let pendingResolve: (() => void) | null = null;
  let pendingReject: ((err: unknown) => void) | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let isRunning = false;

  function clearTimer(): void {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  /** Silently resolve and drop the pending call without executing it. */
  function dropPending(): void {
    pendingResolve?.();
    pending = null;
    pendingResolve = null;
    pendingReject = null;
  }

  /**
   * Execute the pending function immediately (if any), resolving or rejecting
   * the promise that was returned to the original caller.
   */
  async function runPending(): Promise<void> {
    // If a previous execution is still in progress, defer until it finishes.
    if (isRunning) {
      timerId = setTimeout(() => void runPending(), opts.intervalMs);
      return;
    }

    const fn = pending;
    const resolve = pendingResolve;
    const reject = pendingReject;

    pending = null;
    pendingResolve = null;
    pendingReject = null;
    timerId = null;

    if (fn === null) return;

    isRunning = true;
    try {
      await fn();
      resolve?.();
    } catch (err: unknown) {
      reject?.(err);
    } finally {
      isRunning = false;
      lastExecutionTime = Date.now();
    }
  }

  const throttleFn = (fn: () => Promise<void>): Promise<void> => {
    const now = Date.now();
    const elapsed = now - lastExecutionTime;

    // First call ever, or the interval has already elapsed → run immediately.
    if (!isRunning && (lastExecutionTime === 0 || elapsed >= opts.intervalMs)) {
      lastExecutionTime = now;
      isRunning = true;
      return fn().finally(() => {
        isRunning = false;
        lastExecutionTime = Date.now();
      });
    }

    // Drop any existing pending call (resolve it as a silent no-op) and
    // schedule the new one to fire at the trailing edge of the interval.
    clearTimer();
    dropPending();

    return new Promise<void>((resolve, reject) => {
      pending = fn;
      pendingResolve = resolve;
      pendingReject = reject;

      const delay = opts.intervalMs - elapsed;
      timerId = setTimeout(() => {
        void runPending();
      }, delay);
    });
  };

  throttleFn.flush = (): Promise<void> => {
    clearTimer();
    return runPending();
  };

  throttleFn.cancel = (): void => {
    clearTimer();
    dropPending();
  };

  return throttleFn as Throttle;
}
