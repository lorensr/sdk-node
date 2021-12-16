import vm from 'vm';
import { coresdk } from '@temporalio/proto';
import * as internals from '@temporalio/workflow/lib/worker-interface';
import { WorkflowInfo } from '@temporalio/workflow';
import { IllegalStateError, DataConverter, defaultDataConverter, errorToFailure } from '@temporalio/common';
import { partition } from '../utils';
import { Workflow, WorkflowCreator, WorkflowCreateOptions } from './interface';
import { WorkflowIOSerializer } from './serializer';
import { SinkCall } from '@temporalio/workflow/lib/sinks';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * A WorkflowCreator that creates VMWorkflows in the current isolate
 */
export class VMWorkflowCreator implements WorkflowCreator {
  script?: vm.Script;

  constructor(
    script: vm.Script,
    public readonly isolateExecutionTimeoutMs: number,
    protected readonly dataConverter: DataConverter
  ) {
    this.script = script;
  }

  /**
   * Create a workflow with given options
   */
  async createWorkflow(options: WorkflowCreateOptions): Promise<Workflow> {
    const context = await this.getContext();
    this.injectConsole(context, options.info);
    const { isolateExecutionTimeoutMs } = this;
    const workflowModule: WorkflowModule = new Proxy(
      {},
      {
        get(_: any, fn: string) {
          return (...args: any[]) => {
            context.args = args;
            return vm.runInContext(`__TEMPORAL__.api.${fn}(...globalThis.args)`, context, {
              timeout: isolateExecutionTimeoutMs,
              displayErrors: true,
            });
          };
        },
      }
    ) as any;

    await workflowModule.initRuntime(options);

    return new VMWorkflow(options.info, context, workflowModule, isolateExecutionTimeoutMs, this.dataConverter);
  }

  protected async getContext(): Promise<vm.Context> {
    if (this.script === undefined) {
      throw new IllegalStateError('Isolate context provider was destroyed');
    }
    const context = vm.createContext({ AsyncLocalStorage });
    this.script.runInContext(context);
    return context;
  }

  /**
   * Inject console.log into the Workflow isolate context.
   *
   * Overridable for test purposes.
   */
  protected injectConsole(context: vm.Context, info: WorkflowInfo): void {
    context.console = {
      log: (...args: any[]) => {
        // info.isReplaying is mutated by the Workflow class on activation
        if (info.isReplaying) return;
        console.log(`[${info.workflowType}(${info.workflowId})]`, ...args);
      },
    };
  }

  /**
   * Create a new instance, pre-compile scripts from given code.
   *
   * This method is generic to support subclassing.
   */
  public static async create<T extends typeof VMWorkflowCreator>(
    this: T,
    code: string,
    isolateExecutionTimeoutMs: number,
    dataConverterPath?: string
  ): Promise<InstanceType<T>> {
    const script = new vm.Script(code, { filename: 'workflow-isolate' });
    let dataConverter = defaultDataConverter;
    if (dataConverterPath) {
      dataConverter = (await import(dataConverterPath)).dataConverter;
    }
    return new this(script, isolateExecutionTimeoutMs, dataConverter) as InstanceType<T>;
  }

  /**
   * Cleanup the pre-compiled script
   */
  public async destroy(): Promise<void> {
    delete this.script;
  }
}

type WorkflowModule = typeof internals;

/**
 * A Workflow implementation using Node.js' built-in `vm` module
 */
export class VMWorkflow implements Workflow {
  unhandledRejection: unknown;
  serializer: WorkflowIOSerializer;

  constructor(
    public readonly info: WorkflowInfo,
    protected context: vm.Context | undefined,
    readonly workflowModule: WorkflowModule,
    public readonly isolateExecutionTimeoutMs: number,
    protected readonly dataConverter: DataConverter
  ) {
    this.serializer = new WorkflowIOSerializer(dataConverter);
  }

  /**
   * Send request to the Workflow runtime's worker-interface
   */
  async getAndResetSinkCalls(): Promise<SinkCall[]> {
    return this.workflowModule.getAndResetSinkCalls();
  }

  /**
   * Inject a function into the isolate context global scope
   *
   * @param path name of global variable to inject the function as (e.g. `console.log`)
   * @param fn function to inject into the isolate
   */
  public async injectGlobal(key: string, val: unknown): Promise<void> {
    if (this.context === undefined) {
      throw new IllegalStateError('Workflow isolate context uninitialized');
    }
    this.context[key] = val;
  }

  /**
   * Send request to the Workflow runtime's worker-interface
   *
   * The Workflow is activated in batches to ensure correct order of activation
   * job application.
   */
  public async activate(activation: coresdk.workflow_activation.IWFActivation): Promise<Uint8Array> {
    if (this.context === undefined) {
      throw new IllegalStateError('Workflow isolate context uninitialized');
    }
    this.info.isReplaying = activation.isReplaying ?? false;
    if (!activation.jobs) {
      throw new Error('Expected workflow activation jobs to be defined');
    }

    // Job processing order
    // 1. patch notifications
    // 2. signals
    // 3. anything left except for queries
    // 4. queries
    const [patches, nonPatches] = partition(activation.jobs, ({ notifyHasPatch }) => notifyHasPatch != null);
    const [signals, nonSignals] = partition(nonPatches, ({ signalWorkflow }) => signalWorkflow != null);
    const [queries, rest] = partition(nonSignals, ({ queryWorkflow }) => queryWorkflow != null);
    let batchIndex = 0;

    // Loop and invoke each batch and wait for microtasks to complete.
    // This is done outside of the isolate because when we used isolated-vm we couldn't wait for microtasks from inside the isolate, not relevant anymore.
    for (const jobs of [patches, signals, rest, queries]) {
      if (jobs.length === 0) {
        continue;
      }
      const activationMessage = coresdk.workflow_activation.WFActivation.fromObject({ ...activation, jobs });
      // console.log('activationMessage:', activationMessage.jobs[0].startWorkflow?.arguments?.[0]);
      const { numBlockedConditions } = await this.workflowModule.activate(
        await this.serializer.deserializeActivation(activationMessage),
        batchIndex++
      );
      if (numBlockedConditions > 0) {
        await this.tryUnblockConditions();
      }
      // Wait for microtasks to be processed
      await new Promise((resolve) => process.nextTick(resolve));
    }
    const completion = this.workflowModule.concludeActivation();
    // Give unhandledRejection handler a chance to process.
    // Apparently nextTick does not get it triggered so we use setTimeout here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.unhandledRejection) {
      return coresdk.workflow_completion.WFActivationCompletion.encodeDelimited({
        runId: activation.runId,
        failed: { failure: await errorToFailure(this.unhandledRejection, this.dataConverter) },
      }).finish();
    }
    console.log('completion:', completion.successful?.commands?.[0]);
    const serializedCompletion = await this.serializer.serializeCompletion(completion);
    console.log('serializedCompletion:', serializedCompletion.successful?.commands?.[0]);
    return coresdk.workflow_completion.WFActivationCompletion.encodeDelimited(serializedCompletion).finish();
  }

  /**
   * If called (by an external unhandledRejection handler), activations will fail with provided error.
   */
  public setUnhandledRejection(err: unknown): void {
    this.unhandledRejection = err;
  }

  /**
   * Call into the Workflow context to attempt to unblock any blocked conditions.
   *
   * This is performed in a loop allowing microtasks to be processed between
   * each iteration until there are no more conditions to unblock.
   */
  protected async tryUnblockConditions(): Promise<void> {
    for (;;) {
      const numUnblocked = this.workflowModule.tryUnblockConditions();
      if (numUnblocked === 0) break;
      // Wait for microtasks to be processed
      await new Promise((resolve) => process.nextTick(resolve));
    }
  }

  /**
   * Dispose of the isolate's context.
   * Do not use this Workflow instance after this method has been called.
   */
  public async dispose(): Promise<void> {
    await this.workflowModule.dispose();
    delete this.context;
  }
}
