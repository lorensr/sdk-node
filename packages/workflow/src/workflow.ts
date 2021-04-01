import { ActivityOptions, ActivityFunction, CancellationFunctionFactory } from './interfaces';
import { state, currentScope, childScope, propagateCancellation } from './internals';
import { defaultDataConverter } from './converter/data-converter';
import { CancellationError } from './errors';
import { msToTs, msOptionalStrToTs } from './time';

export function sleep(ms: number): Promise<void> {
  const seq = state.nextSeq++;
  const cancellation: CancellationFunctionFactory = (reject) => (err) => {
    if (!state.completions.delete(seq)) {
      return; // Already resolved
    }
    state.commands.push({
      cancelTimer: {
        timerId: `${seq}`,
      },
    });
    reject(err);
  };

  return childScope(
    cancellation,
    cancellation,
    () =>
      new Promise((resolve, reject) => {
        state.completions.set(seq, {
          resolve,
          reject,
          scope: currentScope(),
        });
        state.commands.push({
          startTimer: {
            timerId: `${seq}`,
            startToFireTimeout: msToTs(ms),
          },
        });
      })
  );
}

export interface InternalActivityFunction<P extends any[], R> extends ActivityFunction<P, R> {
  module: string;
  options: ActivityOptions;
}

export function scheduleActivity<R>(module: string, name: string, args: any[], options: ActivityOptions): Promise<R> {
  if (options.type === 'local') {
    throw new TypeError('local activity is not yet implemented');
  }
  const seq = state.nextSeq++;
  return childScope(
    () => (_err) => {
      state.commands.push({
        requestCancelActivity: {
          activityId: `${seq}`,
          // TODO: reason: err instanceof Error ? err.message : undefined,
        },
      });
    },
    (reject) => reject,
    () =>
      new Promise((resolve, reject) => {
        state.completions.set(seq, {
          resolve,
          reject,
          scope: currentScope(),
        });
        state.commands.push({
          scheduleActivity: {
            activityId: `${seq}`,
            activityType: JSON.stringify([module, name]),
            arguments: defaultDataConverter.toPayloads(...args),
            retryPolicy: options.retry
              ? {
                  maximumAttempts: options.retry.maximumAttempts,
                  initialInterval: msOptionalStrToTs(options.retry.initialInterval),
                  maximumInterval: msOptionalStrToTs(options.retry.maximumInterval),
                  backoffCoefficient: options.retry.backoffCoefficient,
                  // TODO: nonRetryableErrorTypes
                }
              : undefined,
            taskQueue: options.taskQueue || state.taskQueue,
            heartbeatTimeout: msOptionalStrToTs(options.heartbeatTimeout),
            scheduleToCloseTimeout: msOptionalStrToTs(options.scheduleToCloseTimeout),
            startToCloseTimeout: msOptionalStrToTs(options.startToCloseTimeout),
            scheduleToStartTimeout: msOptionalStrToTs(options.scheduleToStartTimeout),
            namespace: options.namespace,
            // TODO: add header with interceptors
          },
        });
      })
  );
}

class ContextImpl {
  public configure<P extends any[], R>(
    activity: ActivityFunction<P, R>,
    options: ActivityOptions
  ): ActivityFunction<P, R> {
    const internalActivity = activity as InternalActivityFunction<P, R>;
    const mergedOptions = { ...internalActivity.options, ...options };
    // Wrap the function in an object so it gets the original function name
    const { [internalActivity.name]: fn } = {
      [internalActivity.name](...args: P) {
        return scheduleActivity<R>(internalActivity.module, internalActivity.name, args, mergedOptions);
      },
    };
    const configured = fn as InternalActivityFunction<P, R>;
    configured.module = internalActivity.module;
    configured.options = mergedOptions;
    return configured;
  }

  public get cancelled(): boolean {
    return state.cancelled;
  }
}

export const Context = new ContextImpl();

/**
 * Wraps Promise returned from `fn` with a cancellation scope.
 * The returned Promise may be be cancelled with `cancel()` and will be cancelled
 * if a parent scope is cancelled, e.g. when the entire workflow is cancelled.
 */
export function cancellationScope<T>(fn: () => Promise<T>): Promise<T> {
  return childScope(propagateCancellation('requestCancel'), propagateCancellation('completeCancel'), fn);
}

const ignoreCancellation = () => () => undefined;
/**
 * Wraps the Promise returned from `fn` with a shielded scope.
 * Any child scopes of this scope will *not* be cancelled if `shield` is cancelled.
 * By default `shield` throws the original `CancellationError` in order for any awaiter
 * to immediately be notified of the cancellation.
 * @param throwOnCancellation - Pass false in case the result of the shielded `Promise` is needed
 * despite cancellation. To see if the workflow was cancelled while waiting, check `Context.cancelled`.
 */
export function shield<T>(fn: () => Promise<T>, throwOnCancellation = true): Promise<T> {
  const cancellationFunction: CancellationFunctionFactory = throwOnCancellation
    ? (cancel) => cancel
    : ignoreCancellation;
  return childScope(cancellationFunction, cancellationFunction, fn);
}

/**
 * Cancel a scope created by an activity, timer or cancellationScope.
 */
export function cancel(promise: Promise<any>, reason = 'Cancelled'): void {
  if (state.runtime === undefined) {
    // This shouldn't happen
    throw new Error('Uninitialized workflow');
  }
  const data = state.runtime.getPromiseData(promise);
  if (data === undefined) {
    throw new Error('Expected to find promise scope, got undefined');
  }
  if (!data.cancellable) {
    throw new Error('Promise is not cancellable');
  }

  try {
    data.scope.requestCancel(new CancellationError(reason));
  } catch (e) {
    if (!(e instanceof CancellationError)) throw e;
  }
}

/**
 * Generate an RFC compliant V4 uuid.
 * Uses the workflow's deterministic PRNG making it safe for use within a workflow.
 * This function is cryptograpically insecure.
 * See the {@link https://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid | stackoverflow discussion}.
 */
export function uuid4(): string {
  // Return the hexadecimal text representation of number `n`, padded with zeroes to be of length `p`
  const ho = (n: number, p: number) => n.toString(16).padStart(p, '0');
  // Create a view backed by a 16-byte buffer
  const view = new DataView(new ArrayBuffer(16));
  // Fill buffer with random values
  view.setUint32(0, (Math.random() * 0x100000000) >>> 0);
  view.setUint32(4, (Math.random() * 0x100000000) >>> 0);
  view.setUint32(8, (Math.random() * 0x100000000) >>> 0);
  view.setUint32(12, (Math.random() * 0x100000000) >>> 0);
  // Patch the 6th byte to reflect a version 4 UUID
  view.setUint8(6, (view.getUint8(6) & 0xf) | 0x40);
  // Patch the 8th byte to reflect a variant 1 UUID (version 4 UUIDs are)
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  // Compile the canonical textual form from the array data
  return `${ho(view.getUint32(0), 8)}-${ho(view.getUint16(4), 4)}-${ho(view.getUint16(6), 4)}-${ho(
    view.getUint16(8),
    4
  )}-${ho(view.getUint32(10), 8)}${ho(view.getUint16(14), 4)}`;
}
