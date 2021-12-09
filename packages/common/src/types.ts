import type { coresdk, temporal } from '@temporalio/proto/lib/coresdk';

export type Payload = coresdk.common.IPayload | temporal.api.common.v1.IPayload;
