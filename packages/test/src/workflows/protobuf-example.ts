import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';
import type { ProtoActivityInput, ProtoActivityResult } from '../../protos/protobufs';

const { protoActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5s',
});

export async function protobufExample(args: ProtoActivityInput): Promise<ProtoActivityResult> {
  return await protoActivity(args);
}
