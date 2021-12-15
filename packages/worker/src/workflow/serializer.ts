import { coresdk, temporal } from '@temporalio/proto';
import {
  DataConverter,
  deserializeFailure,
  Payload,
  Deserialized,
  errorToFailure,
  mapToPayloads,
} from '@temporalio/common';

/**
 * Deserializes Payloads in activations sent to the Workflow and serializes Payloads in completions coming from the
 * Workflow.
 */
export class WorkflowIOSerializer {
  constructor(protected readonly dataConverter: DataConverter) {}

  /**
   * Deserialize the Payloads in the Activation message
   */
  public async deserializeActivation(
    activation: coresdk.workflow_activation.WFActivation
  ): Promise<Deserialized<coresdk.workflow_activation.WFActivation>> {
    await Promise.all(
      activation.jobs.flatMap((job) => [
        this.deserializeArray(job.startWorkflow, 'arguments'),
        ...this.deserializeMap(job.startWorkflow, 'headers'),
        this.deserializeArray(job.queryWorkflow, 'arguments'),
        this.deserializeArray(job.cancelWorkflow, 'details'),
        this.deserializeArray(job.signalWorkflow, 'input'),
        this.deserializeField(job.resolveActivity?.result?.completed, 'result'),
        this.deserializeField(job.resolveChildWorkflowExecution?.result?.completed, 'result'),
        this.deserializeFailure(job.resolveActivity?.result?.failed),
        this.deserializeFailure(job.resolveActivity?.result?.cancelled),
        this.deserializeFailure(job.resolveChildWorkflowExecutionStart?.cancelled),
        this.deserializeFailure(job.resolveSignalExternalWorkflow),
        this.deserializeFailure(job.resolveChildWorkflowExecution?.result?.failed),
        this.deserializeFailure(job.resolveChildWorkflowExecution?.result?.cancelled),
        this.deserializeFailure(job.resolveRequestCancelExternalWorkflow),
      ])
    );

    return activation as Deserialized<coresdk.workflow_activation.WFActivation>;
  }

  protected async deserializeField(obj: unknown, field: string): Promise<void> {
    if (!obj) return;
    const accessibleObj = obj as Record<string, unknown>;
    if (!accessibleObj[field]) return;

    accessibleObj[field] = await this.dataConverter.fromPayload(accessibleObj[field] as Payload);
  }

  protected async deserializeArray(obj: unknown, field: string): Promise<void> {
    if (!obj) return;
    const accessibleObj = obj as Record<string, unknown>;
    if (!accessibleObj[field]) return;

    accessibleObj[field] = await Promise.all(
      (accessibleObj[field] as Payload[]).map((payload) => this.dataConverter.fromPayload(payload))
    );
  }

  protected deserializeMap(obj: unknown, field: string): Promise<void>[] {
    if (!obj) return [];
    const accessibleObj = obj as Record<string, unknown>;
    if (!accessibleObj[field]) return [];

    return Object.entries(accessibleObj[field] as Record<string, Payload>).map(async ([k, v]) => {
      (accessibleObj[field] as Record<string, unknown>)[k] = await this.dataConverter.fromPayload(v);
    });
  }

  protected async deserializeFailure(failureParent: unknown): Promise<void> {
    if (!failureParent) return;
    const accessibleFailureParent = failureParent as Record<
      string,
      temporal.api.failure.v1.IFailure | undefined | null
    >;
    if (!accessibleFailureParent.failure) return;

    accessibleFailureParent['failure'] = await deserializeFailure(
      accessibleFailureParent['failure'],
      this.dataConverter
    );
  }

  /**
   * Serialize the Payloads inside the Completion message
   */
  public async serializeCompletion(
    completion: Deserialized<coresdk.workflow_completion.IWFActivationCompletion>
  ): Promise<coresdk.workflow_completion.IWFActivationCompletion> {
    await Promise.all([
      ...(completion.successful?.commands?.flatMap((command) =>
        command
          ? [
              this.serializeMap(command.scheduleActivity, 'headerFields'),
              this.serializeArray(command.scheduleActivity, 'arguments'),
              this.serializeField(command.respondToQuery?.succeeded, 'response'),
              this.serializeFailure(command.respondToQuery, 'failed'),
              this.serializeField(command.completeWorkflowExecution, 'result'),
              this.serializeFailure(command.failWorkflowExecution, 'failure'),
              this.serializeArray(command.continueAsNewWorkflowExecution, 'arguments'),
              this.serializeMap(command.continueAsNewWorkflowExecution, 'memo'),
              this.serializeMap(command.continueAsNewWorkflowExecution, 'header'),
              this.serializeMap(command.continueAsNewWorkflowExecution, 'searchAttributes'),
              this.serializeArray(command.startChildWorkflowExecution, 'input'),
              this.serializeMap(command.startChildWorkflowExecution, 'memo'),
              this.serializeMap(command.startChildWorkflowExecution, 'header'),
              this.serializeMap(command.startChildWorkflowExecution, 'searchAttributes'),
              this.serializeArray(command.signalExternalWorkflowExecution, 'args'),
            ]
          : []
      ) ?? []),
      this.serializeFailure(completion, 'failed'),
    ]);

    return completion as coresdk.workflow_completion.IWFActivationCompletion;
  }

  protected async serializeField(obj: Record<string, unknown> | null | undefined, field: string): Promise<void> {
    if (!obj) return;
    const accessibleObj = obj as Record<string, unknown>;
    if (!(field in accessibleObj)) return;

    accessibleObj[field] = await this.dataConverter.toPayload(accessibleObj[field]);
  }

  protected async serializeArray(obj: Record<string, unknown> | null | undefined, field: string): Promise<void> {
    if (!obj) return;
    const accessibleObj = obj as Record<string, unknown>;
    if (!accessibleObj[field]) return;

    accessibleObj[field] = await Promise.all(
      (accessibleObj[field] as unknown[]).map((elem) => this.dataConverter.toPayload(elem))
    );
  }

  protected async serializeMap(obj: Record<string, unknown> | null | undefined, field: string): Promise<void> {
    if (!obj) return;
    const accessibleObj = obj as Record<string, unknown>;
    if (!accessibleObj[field]) return;

    accessibleObj[field] = await mapToPayloads(this.dataConverter, accessibleObj[field] as Record<string, Payload>);
  }

  protected async serializeFailure(obj: Record<string, unknown> | null | undefined, field: string): Promise<void> {
    if (!obj) return;
    const accessibleObj = obj as Record<string, unknown>;
    if (!accessibleObj[field]) return;

    accessibleObj[field] = await errorToFailure(accessibleObj[field], this.dataConverter);
  }
}
