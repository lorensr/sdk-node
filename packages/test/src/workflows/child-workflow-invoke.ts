import { startChildWorkflowExecutionNextHandler } from '@temporalio/workflow/lib/workflow';
import { state } from '@temporalio/workflow/lib/internals';
import { sleep } from '@temporalio/workflow';

export async function main(): Promise<void> {
  await startChildWorkflowExecutionNextHandler({
    args: [],
    workflowType: 'sync',
    seq: state.nextSeq++,
    headers: new Map(),
    options: {
      taskQueue: 'test',
    },
  });
  await sleep(3000);
}
