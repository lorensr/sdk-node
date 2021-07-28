/**
 * Same as common/failure but adapted for upstream protos
 * @module
 */

import { coresdk, temporal } from '@temporalio/proto';
import {
  arrayFromPayloads,
  DataConverter,
  TemporalFailure,
  ServerFailure,
  ApplicationFailure,
  ActivityFailure,
  CancelledFailure,
  TimeoutFailure,
  TerminatedFailure,
} from '@temporalio/common';
export {
  TemporalFailure,
  ServerFailure,
  ApplicationFailure,
  ActivityFailure,
  CancelledFailure,
  TimeoutFailure,
  TerminatedFailure,
};

/**
 * Converts a Failure proto message to a JS Error object if defined or returns undefined.
 */
export async function optionalFailureToOptionalError(
  failure: temporal.api.failure.v1.IFailure | undefined | null,
  dataConverter: DataConverter
): Promise<TemporalFailure | undefined> {
  return failure ? await failureToError(failure, dataConverter) : undefined;
}

export function serviceToCoreFailure(
  failure: temporal.api.failure.v1.IFailure | undefined | null
): coresdk.failures.IFailure | undefined | null {
  if (failure === undefined || failure === null) return failure;
  const base: coresdk.failures.IFailure = {
    message: failure.message,
    stackTrace: failure.stackTrace,
    source: failure.source,
    cause: serviceToCoreFailure(failure.cause),
  };
  // if (failure.childWorkflowExecutionFailureInfo) {
  // }
  if (failure.serverFailureInfo) {
    return { ...base, serverFailureInfo: failure.serverFailureInfo };
  }
  if (failure.timeoutFailureInfo) {
    const { timeoutType, lastHeartbeatDetails } = failure.timeoutFailureInfo;
    return {
      ...base,
      timeoutFailureInfo: {
        timeoutType,
        lastHeartbeatDetails: lastHeartbeatDetails?.payloads,
      },
    };
  }
  if (failure.canceledFailureInfo) {
    const { details } = failure.canceledFailureInfo;
    return { ...base, cancelledFailureInfo: { details: details?.payloads } };
  }
  if (failure.activityFailureInfo) {
    const { activityType, ...rest } = failure.activityFailureInfo;
    return {
      ...base,
      activityFailureInfo: {
        activityType: activityType?.name,
        ...rest,
      },
    };
  }
  if (failure.terminatedFailureInfo) {
    return { ...base, terminatedFailureInfo: failure.terminatedFailureInfo };
  }
  if (failure.applicationFailureInfo) {
    const { details, ...rest } = failure.applicationFailureInfo;
    return { ...base, applicationFailureInfo: { details: details?.payloads, ...rest } };
  }
  if (failure.resetWorkflowFailureInfo) {
    const { lastHeartbeatDetails } = failure.resetWorkflowFailureInfo;
    return { ...base, resetWorkflowFailureInfo: { lastHeartbeatDetails: lastHeartbeatDetails?.payloads } };
  }
  if (failure.childWorkflowExecutionFailureInfo) {
    const { workflowType, ...rest } = failure.childWorkflowExecutionFailureInfo;
    return { ...base, childWorkflowExecutionFailureInfo: { workflowType: workflowType?.name, ...rest } };
  }
  return base;
}

/**
 * Converts a Failure proto message to a JS Error object.
 */
export async function failureToError(
  failure: temporal.api.failure.v1.IFailure,
  dataConverter: DataConverter
): Promise<TemporalFailure> {
  const err = await failureToErrorInner(failure, dataConverter);
  err.stack = failure.stackTrace ?? '';
  err.failure = serviceToCoreFailure(failure) ?? undefined;
  return err;
}

/**
 * Converts a Failure proto message to a JS Error object.
 *
 * Does not set common properties, that is done in {@link failureToError}.
 */
export async function failureToErrorInner(
  failure: temporal.api.failure.v1.IFailure,
  dataConverter: DataConverter
): Promise<TemporalFailure> {
  if (failure.applicationFailureInfo) {
    return new ApplicationFailure(
      failure.message ?? undefined,
      failure.applicationFailureInfo.type,
      Boolean(failure.applicationFailureInfo.nonRetryable),
      await arrayFromPayloads(dataConverter, failure.applicationFailureInfo.details?.payloads),
      await optionalFailureToOptionalError(failure.cause, dataConverter)
    );
  }
  if (failure.serverFailureInfo) {
    return new ServerFailure(
      failure.message ?? undefined,
      Boolean(failure.serverFailureInfo.nonRetryable),
      await optionalFailureToOptionalError(failure.cause, dataConverter)
    );
  }
  if (failure.timeoutFailureInfo) {
    return new TimeoutFailure(
      failure.message ?? undefined,
      await dataConverter.fromPayloads(0, failure.timeoutFailureInfo.lastHeartbeatDetails?.payloads),
      failure.timeoutFailureInfo.timeoutType ?? temporal.api.enums.v1.TimeoutType.TIMEOUT_TYPE_UNSPECIFIED
    );
  }
  if (failure.terminatedFailureInfo) {
    return new TerminatedFailure(
      failure.message ?? undefined,
      await optionalFailureToOptionalError(failure.cause, dataConverter)
    );
  }
  if (failure.canceledFailureInfo) {
    return new CancelledFailure(
      failure.message ?? undefined,
      await arrayFromPayloads(dataConverter, failure.canceledFailureInfo.details?.payloads),
      await optionalFailureToOptionalError(failure.cause, dataConverter)
    );
  }
  if (failure.resetWorkflowFailureInfo) {
    return new ApplicationFailure(
      failure.message ?? undefined,
      'ResetWorkflow',
      false,
      await arrayFromPayloads(dataConverter, failure.resetWorkflowFailureInfo.lastHeartbeatDetails?.payloads),
      await optionalFailureToOptionalError(failure.cause, dataConverter)
    );
  }
  if (failure.activityFailureInfo) {
    if (!failure.activityFailureInfo.activityType?.name) {
      throw new TypeError('Missing activityType on activityFailureInfo');
    }
    return new ActivityFailure(
      failure.activityFailureInfo.activityType.name ?? undefined,
      failure.activityFailureInfo.activityId ?? undefined,
      failure.activityFailureInfo.retryState ?? temporal.api.enums.v1.RetryState.RETRY_STATE_UNSPECIFIED,
      failure.activityFailureInfo.identity ?? undefined,
      await optionalFailureToOptionalError(failure.cause, dataConverter)
    );
  }
  return new TemporalFailure(
    failure.message ?? undefined,
    undefined,
    await optionalFailureToOptionalError(failure.cause, dataConverter)
  );
}
