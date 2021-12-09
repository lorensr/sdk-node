import { coresdk } from '@temporalio/proto';
import test from 'ava';
import { WorkflowIOSerializer } from '@temporalio/worker/lib/workflow/serializer';
import { defaultDataConverter, errorToFailure, ApplicationFailure } from '@temporalio/common';

const serializer = new WorkflowIOSerializer(defaultDataConverter);
const cause = new Error('cause');
cause.stack = 'test-stacktrace';
const error = new ApplicationFailure('test', 'type', true, [1, 'two'], cause);
error.stack = 'test-stacktrace';

test('WorkflowSerializer.serializeCompletion', async (t) => {
  const completion = await serializer.serializeCompletion({
    successful: {
      // include field, failure, map, and array
      commands: [
        { completeWorkflowExecution: { result: 'success' } },
        { respondToQuery: { failed: error } },
        { scheduleActivity: { headerFields: { headerA: 'headerAString' }, arguments: [1, 'two'] } },
      ],
    },
  });
  t.snapshot(completion);
});

test('WorkflowSerializer.deserializeActivation', async (t) => {
  const failed = coresdk.activity_result.Failure.fromObject({
    failure: await errorToFailure(error, defaultDataConverter),
  });
  const activation = await serializer.deserializeActivation(
    coresdk.workflow_activation.WFActivation.fromObject({
      // include field, failure, map, and array
      jobs: [
        {
          resolveActivity: {
            result: {
              completed: { result: await defaultDataConverter.toPayload('result') },
              failed,
            },
          },
        },
        {
          startWorkflow: {
            headers: {
              headerA: await defaultDataConverter.toPayload('headerAString'),
            },
            arguments: await defaultDataConverter.toPayloads([1, 'two']),
          },
        },
      ],
    })
  );
  t.snapshot(activation);
});
