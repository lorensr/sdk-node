import { DefaultDataConverter } from '@temporalio/common';
import protobufClasses from '../../protos/protobufs';

export const messageInstance = protobufClasses.ProtoActivityInput.create({ name: 'Proto', age: 2 });
export const resultMessageInstance = protobufClasses.ProtoActivityResult.create({ sentence: 'Proto is 2 years old.' });

export const dataConverter = new DefaultDataConverter({ protobufClasses });
