/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { coresdk, temporal } from '@temporalio/proto/lib/coresdk';
import { DataConverter, arrayFromPayloads } from './converter/data-converter';
import { checkExtends, Deserialized } from './type-helpers';

export const FAILURE_SOURCE = 'TypeScriptSDK';
export type ProtoFailure = temporal.api.failure.v1.IFailure;
export type DeserializedFailure = Deserialized<ProtoFailure>;

// Avoid importing the proto implementation to reduce workflow bundle size
// Copied from temporal.api.enums.v1.TimeoutType
export enum TimeoutType {
  TIMEOUT_TYPE_UNSPECIFIED = 0,
  TIMEOUT_TYPE_START_TO_CLOSE = 1,
  TIMEOUT_TYPE_SCHEDULE_TO_START = 2,
  TIMEOUT_TYPE_SCHEDULE_TO_CLOSE = 3,
  TIMEOUT_TYPE_HEARTBEAT = 4,
}

checkExtends<temporal.api.enums.v1.TimeoutType, TimeoutType>();

// Avoid importing the proto implementation to reduce workflow bundle size
// Copied from temporal.api.enums.v1.RetryState
export enum RetryState {
  RETRY_STATE_UNSPECIFIED = 0,
  RETRY_STATE_IN_PROGRESS = 1,
  RETRY_STATE_NON_RETRYABLE_FAILURE = 2,
  RETRY_STATE_TIMEOUT = 3,
  RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED = 4,
  RETRY_STATE_RETRY_POLICY_NOT_SET = 5,
  RETRY_STATE_INTERNAL_SERVER_ERROR = 6,
  RETRY_STATE_CANCEL_REQUESTED = 7,
}

checkExtends<temporal.api.enums.v1.RetryState, RetryState>();

export type WorkflowExecution = temporal.api.common.v1.IWorkflowExecution;

/**
 * Represents failures that can cross Workflow and Activity boundaries.
 *
 * Only exceptions that extend this class will be propagated to the caller.
 *
 * **Never extend this class or any of its derivatives.** They are to be used by the SDK code
 * only. Throw an instance of {@link ApplicationFailure} to pass application-specific errors between
 * Workflows and Activities.
 *
 * Any unhandled exception thrown by an Activity or Workflow will be converted to an instance of
 * {@link ApplicationFailure}.
 */
export class TemporalFailure extends Error {
  public readonly name: string = 'TemporalFailure';
  /**
   * The original failure that constructed this error.
   *
   * Only present if this error was generated from an external operation.
   */
  public failure?: DeserializedFailure;

  constructor(message: string | undefined, public readonly cause?: Error) {
    super(message ?? undefined);
  }
}

/** Exceptions originated at the Temporal service. */
export class ServerFailure extends TemporalFailure {
  public readonly name: string = 'ServerFailure';

  constructor(message: string | undefined, public readonly nonRetryable: boolean, cause?: Error) {
    super(message, cause);
  }
}

/**
 * Application failure is used to communicate application specific failures between Workflows and
 * Activities.
 *
 * Throw this exception to have full control over type and details if the exception delivered to
 * the caller workflow or client.
 *
 * Any unhandled exception which doesn't extend {@link TemporalFailure} is converted to an
 * instance of this class before being returned to a caller.
 *
 * The {@link type} property is used by {@link io.temporal.common.RetryOptions} to determine if
 * an instance of this exception is non retryable. Another way to avoid retrying an exception of
 * this type is by setting {@link nonRetryable} flag to `true`.
 *
 * The conversion of an exception that doesn't extend {@link TemporalFailure} to an
 * ApplicationFailure is done as following:
 *
 * - type is set to the exception full type name.
 * - message is set to the exception message
 * - nonRetryable is set to false
 * - details are set to null
 * - stack trace is copied from the original exception
 */
export class ApplicationFailure extends TemporalFailure {
  public readonly name: string = 'ApplicationFailure';

  constructor(
    message: string | undefined,
    public readonly type: string | undefined | null,
    public readonly nonRetryable: boolean,
    public readonly details?: unknown[] | null,
    cause?: Error
  ) {
    super(message, cause);
  }

  /**
   * New ApplicationFailure with {@link nonRetryable} flag set to false. Note that this
   * exception still can be not retried by the service if its type is included into doNotRetry
   * property of the correspondent retry policy.
   *
   * @param message optional error message
   * @param type optional error type that is used by {@link RetryOptions.nonRetryableErrorTypes}.
   * @param details optional details about the failure. They are serialized using the same approach
   *     as arguments and results.
   */
  public static retryable(message: string | undefined, type?: string, ...details: unknown[]): ApplicationFailure {
    return new this(message, type ?? 'Error', false, details);
  }

  /**
   * New ApplicationFailure with {@link nonRetryable} flag set to true.
   *
   * It means that this exception is not going to be retried even if it is not included into
   * retry policy doNotRetry list.
   *
   * @param message optional error message
   * @param type optional error type
   * @param details optional details about the failure. They are serialized using the same approach
   *     as arguments and results.
   */
  public static nonRetryable(message: string | undefined, type?: string, ...details: unknown[]): ApplicationFailure {
    return new this(message, type ?? 'Error', true, details);
  }
}

/**
 * Used as the cause for when a Workflow or Activity has been cancelled
 */
export class CancelledFailure extends TemporalFailure {
  public readonly name: string = 'CancelledFailure';

  constructor(message: string | undefined, public readonly details: unknown[] | null = [], cause?: Error) {
    super(message, cause);
  }
}

/**
 * Used as the cause for when a Workflow has been terminated
 */
export class TerminatedFailure extends TemporalFailure {
  public readonly name: string = 'TerminatedFailure';

  constructor(message: string | undefined, cause?: Error) {
    super(message, cause);
  }
}

/**
 * Used to represent timeouts of Activities and Workflows
 */
export class TimeoutFailure extends TemporalFailure {
  public readonly name: string = 'TimeoutFailure';

  constructor(
    message: string | undefined,
    public readonly lastHeartbeatDetails: unknown,
    public readonly timeoutType: TimeoutType
  ) {
    super(message);
  }
}

/**
 * Contains information about an activity failure. Always contains the original reason for the
 * failure as its cause. For example if an activity timed out the cause is {@link TimeoutFailure}.
 *
 * This exception is expected to be thrown only by the framework code.
 */
export class ActivityFailure extends TemporalFailure {
  public constructor(
    public readonly activityType: string,
    public readonly activityId: string | undefined,
    public readonly retryState: RetryState,
    public readonly identity: string | undefined,
    cause?: Error
  ) {
    super('Activity execution failed', cause);
  }
}

/**
 * Contains information about an child workflow failure. Always contains the original reason for the
 * failure as its cause. For example if a child workflow was terminated the cause is {@link TerminatedFailure}.
 *
 * This exception is expected to be thrown only by the framework code.
 */
export class ChildWorkflowFailure extends TemporalFailure {
  public constructor(
    public readonly namespace: string | undefined,
    public readonly execution: WorkflowExecution,
    public readonly workflowType: string,
    public readonly retryState: RetryState,
    cause?: Error
  ) {
    super('Child Workflow execution failed', cause);
  }
}

/**
 * Converts an error to a Failure proto message if defined or returns undefined
 */
export async function optionalErrorToOptionalFailure(
  err: unknown,
  dataConverter: DataConverter
): Promise<ProtoFailure | undefined> {
  return err ? await errorToFailure(err, dataConverter) : undefined;
}

/**
 * Stack traces will be cutoff when on of these patterns is matched
 */
const CUTTOFF_STACK_PATTERNS = [
  /** Activity execution */
  /\s+at Activity\.execute \(.*[\\/]worker[\\/](?:src|lib)[\\/]activity\.[jt]s:\d+:\d+\)/,
  /** Workflow activation */
  /\s+at Activator\.\S+NextHandler \(webpack-internal:\/\/\/.*\/internals\.[jt]s:\d+:\d+\)/,
];

/**
 * Cuts out the framework part of a stack trace, leaving only user code entries
 */
export function cutoffStackTrace(stack?: string): string {
  const lines = (stack ?? '').split(/\r?\n/);
  const acc = Array<string>();
  lineLoop: for (const line of lines) {
    for (const pattern of CUTTOFF_STACK_PATTERNS) {
      if (pattern.test(line)) break lineLoop;
    }
    acc.push(line);
  }
  return acc.join('\n');
}

/**
 * Error classes like Error and TemporalFailure in the Worker are not the same Function objects as those in the
 * Workflow, so `instanceof` doesn't work across the vm. When serializing error objects that were created in the
 * Workflow, we check their types with this function.
 */ // eslint-disable-next-line @typescript-eslint/ban-types
function workflowInclusiveInstanceOf(instance: unknown, type: Function): boolean {
  let proto = Object.getPrototypeOf(instance);
  while (proto) {
    // type.toString() returns the entire class definition
    if (proto.constructor?.toString() === type.toString()) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Converts a caught error to a Failure proto message
 */
export async function errorToFailure(err: unknown, dataConverter: DataConverter): Promise<ProtoFailure> {
  if (workflowInclusiveInstanceOf(err, TemporalFailure)) {
    const error = err as TemporalFailure;
    if (error.failure) return serializeFailure(error.failure, dataConverter);

    const base = {
      message: error.message,
      stackTrace: cutoffStackTrace(error.stack),
      cause: await optionalErrorToOptionalFailure(error.cause, dataConverter),
      source: FAILURE_SOURCE,
    };
    if (workflowInclusiveInstanceOf(error, ActivityFailure)) {
      const activityFailure = error as ActivityFailure;
      return {
        ...base,
        activityFailureInfo: {
          ...activityFailure,
          activityType: { name: activityFailure.activityType },
        },
      };
    }
    if (workflowInclusiveInstanceOf(error, ChildWorkflowFailure)) {
      const childWorkflowFailure = error as ChildWorkflowFailure;
      return {
        ...base,
        childWorkflowExecutionFailureInfo: {
          ...childWorkflowFailure,
          workflowExecution: childWorkflowFailure.execution,
          workflowType: { name: childWorkflowFailure.workflowType },
        },
      };
    }
    if (workflowInclusiveInstanceOf(error, ApplicationFailure)) {
      const applicationFailure = error as ApplicationFailure;
      return {
        ...base,
        applicationFailureInfo: {
          type: applicationFailure.type,
          nonRetryable: applicationFailure.nonRetryable,
          details: applicationFailure.details?.length
            ? { payloads: await dataConverter.toPayloads(...applicationFailure.details) }
            : undefined,
        },
      };
    }
    if (workflowInclusiveInstanceOf(error, CancelledFailure)) {
      const cancelledFailure = error as CancelledFailure;
      return {
        ...base,
        canceledFailureInfo: {
          details: cancelledFailure.details?.length
            ? { payloads: await dataConverter.toPayloads(...cancelledFailure.details) }
            : undefined,
        },
      };
    }
    if (workflowInclusiveInstanceOf(error, TimeoutFailure)) {
      const timeoutFailure = error as TimeoutFailure;
      return {
        ...base,
        timeoutFailureInfo: {
          timeoutType: timeoutFailure.timeoutType,
          lastHeartbeatDetails: timeoutFailure.lastHeartbeatDetails
            ? { payloads: await dataConverter.toPayloads(timeoutFailure.lastHeartbeatDetails) }
            : undefined,
        },
      };
    }
    if (workflowInclusiveInstanceOf(error, TerminatedFailure)) {
      return {
        ...base,
        terminatedFailureInfo: {},
      };
    }
    if (workflowInclusiveInstanceOf(error, ServerFailure)) {
      const serverFailure = error as ServerFailure;
      return {
        ...base,
        serverFailureInfo: { nonRetryable: serverFailure.nonRetryable },
      };
    }
    // Just a TemporalFailure
    return base;
  }

  const base = {
    source: FAILURE_SOURCE,
  };

  if (workflowInclusiveInstanceOf(err, Error)) {
    const error = err as Error;
    return { ...base, message: error.message ?? '', stackTrace: cutoffStackTrace(error.stack) };
  }

  if (typeof err === 'string') {
    return { ...base, message: err };
  }

  return { ...base, message: String(err) };
}

/**
 * If `err` is an Error it is turned into an `ApplicationFailure`.
 *
 * If `err` was already a `TemporalFailure`, returns the original error.
 *
 * Otherwise returns an `ApplicationFailure` with `String(err)` as the message.
 */
export function ensureTemporalFailure(err: unknown): TemporalFailure {
  if (workflowInclusiveInstanceOf(err, TemporalFailure)) {
    return err as TemporalFailure;
  } else if (workflowInclusiveInstanceOf(err, Error)) {
    const error = err as Error;
    const failure = new ApplicationFailure(error.message, error.name, false);
    failure.stack = error.stack;
    return failure;
  } else {
    const failure = new ApplicationFailure(String(err), undefined, false);
    failure.stack = '';
    return failure;
  }
}

/**
 * Converts a Failure proto message to a JS Error object if defined or returns undefined.
 */
export async function optionalProtoFailureToOptionalError(
  failure: ProtoFailure | undefined | null,
  dataConverter: DataConverter
): Promise<TemporalFailure | undefined> {
  return failure ? failureToError(await deserializeFailure(failure, dataConverter)) : undefined;
}

export async function deserializeFailure(
  failure: ProtoFailure,
  dataConverter: DataConverter
): Promise<DeserializedFailure> {
  const deserializedFailure = failure as DeserializedFailure;
  if (failure.cause) {
    await deserializeFailure(failure.cause, dataConverter);
  }

  if (failure.applicationFailureInfo?.details) {
    deserializedFailure.applicationFailureInfo!.details!.payloads = await arrayFromPayloads(
      dataConverter,
      failure.applicationFailureInfo.details.payloads
    );
  }
  if (failure.timeoutFailureInfo?.lastHeartbeatDetails?.payloads) {
    deserializedFailure.timeoutFailureInfo!.lastHeartbeatDetails!.payloads = await dataConverter.fromPayloads(
      0,
      failure.timeoutFailureInfo.lastHeartbeatDetails?.payloads
    );
  }
  if (failure.canceledFailureInfo?.details?.payloads) {
    deserializedFailure.canceledFailureInfo!.details!.payloads = await arrayFromPayloads(
      dataConverter,
      failure.canceledFailureInfo.details.payloads
    );
  }
  if (failure.resetWorkflowFailureInfo?.lastHeartbeatDetails?.payloads) {
    deserializedFailure.resetWorkflowFailureInfo!.lastHeartbeatDetails!.payloads = await arrayFromPayloads(
      dataConverter,
      failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads
    );
  }
  return deserializedFailure;
}

export async function serializeFailure(
  failure: DeserializedFailure,
  dataConverter: DataConverter
): Promise<ProtoFailure> {
  const serializedFailure = failure as ProtoFailure;
  if (failure.cause) {
    await serializeFailure(failure.cause, dataConverter);
  }

  if (failure.applicationFailureInfo?.details?.payloads?.length) {
    serializedFailure.applicationFailureInfo!.details!.payloads = await dataConverter.toPayloads(
      ...failure.applicationFailureInfo.details.payloads
    );
  }
  if (failure.timeoutFailureInfo?.lastHeartbeatDetails?.payloads?.length) {
    serializedFailure.timeoutFailureInfo!.lastHeartbeatDetails!.payloads = await dataConverter.toPayloads(
      ...failure.timeoutFailureInfo.lastHeartbeatDetails.payloads
    );
  }
  if (failure.canceledFailureInfo?.details?.payloads?.length) {
    serializedFailure.canceledFailureInfo!.details!.payloads = await dataConverter.toPayloads(
      ...failure.canceledFailureInfo.details.payloads
    );
  }
  if (failure.resetWorkflowFailureInfo?.lastHeartbeatDetails?.payloads?.length) {
    serializedFailure.resetWorkflowFailureInfo!.lastHeartbeatDetails!.payloads = await dataConverter.toPayloads(
      ...failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads
    );
  }
  return serializedFailure;
}

export function convertFailuresToErrors(activation: Deserialized<coresdk.workflow_activation.WFActivation>): void {
  activation.jobs.forEach((job) => {
    if (job.resolveActivity?.result?.failed) {
      job.resolveActivity.result.failed.failure = optionalFailureToOptionalError(
        job.resolveActivity.result.failed.failure
      );
    }
    if (job.resolveActivity?.result?.cancelled) {
      job.resolveActivity.result.cancelled.failure = optionalFailureToOptionalError(
        job.resolveActivity.result.cancelled.failure
      );
    }
    if (job.resolveChildWorkflowExecutionStart?.cancelled) {
      job.resolveChildWorkflowExecutionStart.cancelled.failure = optionalFailureToOptionalError(
        job.resolveChildWorkflowExecutionStart.cancelled.failure
      );
    }
    if (job.resolveSignalExternalWorkflow) {
      job.resolveSignalExternalWorkflow = optionalFailureToOptionalError(job.resolveSignalExternalWorkflow.failure);
    }
    if (job.resolveChildWorkflowExecution?.result?.failed) {
      job.resolveChildWorkflowExecution.result.failed.failure = optionalFailureToOptionalError(
        job.resolveChildWorkflowExecution.result.failed.failure
      );
    }
    if (job.resolveChildWorkflowExecution?.result?.cancelled) {
      job.resolveChildWorkflowExecution.result.cancelled.failure = optionalFailureToOptionalError(
        job.resolveChildWorkflowExecution.result.cancelled.failure
      );
    }
    if (job.resolveRequestCancelExternalWorkflow) {
      job.resolveRequestCancelExternalWorkflow.failure = optionalFailureToOptionalError(
        job.resolveRequestCancelExternalWorkflow.failure
      );
    }
  });
}

/**
 * Converts a deserialized Failure proto message to a JS Error object if defined or returns undefined.
 */
export function optionalFailureToOptionalError(
  failure: DeserializedFailure | undefined | null
): TemporalFailure | undefined {
  return failure ? failureToError(failure) : undefined;
}

/**
 * Converts a Failure proto message to a JS Error object.
 *
 * Does not set common properties, that is done in {@link failureToError}.
 */
export function failureToErrorInner(failure: DeserializedFailure): TemporalFailure {
  if (failure.applicationFailureInfo) {
    return new ApplicationFailure(
      failure.message ?? undefined,
      failure.applicationFailureInfo.type,
      Boolean(failure.applicationFailureInfo.nonRetryable),
      failure.applicationFailureInfo.details?.payloads,
      optionalFailureToOptionalError(failure.cause)
    );
  }
  if (failure.serverFailureInfo) {
    return new ServerFailure(
      failure.message ?? undefined,
      Boolean(failure.serverFailureInfo.nonRetryable),
      optionalFailureToOptionalError(failure.cause)
    );
  }
  if (failure.timeoutFailureInfo) {
    return new TimeoutFailure(
      failure.message ?? undefined,
      failure.timeoutFailureInfo.lastHeartbeatDetails?.payloads,
      failure.timeoutFailureInfo.timeoutType ?? TimeoutType.TIMEOUT_TYPE_UNSPECIFIED
    );
  }
  if (failure.terminatedFailureInfo) {
    return new TerminatedFailure(failure.message ?? undefined, optionalFailureToOptionalError(failure.cause));
  }
  if (failure.canceledFailureInfo) {
    return new CancelledFailure(
      failure.message ?? undefined,
      failure.canceledFailureInfo.details?.payloads,
      optionalFailureToOptionalError(failure.cause)
    );
  }
  if (failure.resetWorkflowFailureInfo) {
    return new ApplicationFailure(
      failure.message ?? undefined,
      'ResetWorkflow',
      false,
      failure.resetWorkflowFailureInfo.lastHeartbeatDetails?.payloads,
      optionalFailureToOptionalError(failure.cause)
    );
  }
  if (failure.childWorkflowExecutionFailureInfo) {
    const { namespace, workflowType, workflowExecution, retryState } = failure.childWorkflowExecutionFailureInfo;
    if (!(workflowType?.name && workflowExecution)) {
      throw new TypeError('Missing attributes on childWorkflowExecutionFailureInfo');
    }
    return new ChildWorkflowFailure(
      namespace ?? undefined,
      workflowExecution,
      workflowType.name,
      retryState ?? RetryState.RETRY_STATE_UNSPECIFIED,
      optionalFailureToOptionalError(failure.cause)
    );
  }
  if (failure.activityFailureInfo) {
    if (!failure.activityFailureInfo.activityType?.name) {
      throw new TypeError('Missing activityType?.name on activityFailureInfo');
    }
    return new ActivityFailure(
      failure.activityFailureInfo.activityType.name,
      failure.activityFailureInfo.activityId ?? undefined,
      failure.activityFailureInfo.retryState ?? RetryState.RETRY_STATE_UNSPECIFIED,
      failure.activityFailureInfo.identity ?? undefined,
      optionalFailureToOptionalError(failure.cause)
    );
  }
  return new TemporalFailure(failure.message ?? undefined, optionalFailureToOptionalError(failure.cause));
}

/**
 * Converts a Failure proto message to a JS Error object.
 */
export function failureToError(failure: DeserializedFailure): TemporalFailure {
  const err = failureToErrorInner(failure);
  err.stack = failure.stackTrace ?? '';
  err.failure = failure;
  return err;
}

/**
 * Get the root cause (string) of given error `err`.
 *
 * In case `err` is a {@link TemporalFailure}, recurse the cause chain and return the root's message.
 * Otherwise, return `err.message`.
 */
export function rootCause(err: unknown): string | undefined {
  if (workflowInclusiveInstanceOf(err, TemporalFailure)) {
    const error = err as TemporalFailure;
    return error.cause ? rootCause(error.cause) : error.message;
  }
  if (workflowInclusiveInstanceOf(err, Error)) {
    return (err as Error).message;
  }
  if (typeof err === 'string') {
    return err;
  }
  return undefined;
}
