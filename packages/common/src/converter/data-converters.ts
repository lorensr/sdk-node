import { ValueError, DataConverterError, UnsupportedTypeError } from '../errors';
import {
  u8,
  str,
  Payload,
  encodingTypes,
  EncodingType,
  encodingKeys,
  METADATA_ENCODING_KEY,
  METADATA_MESSAGE_TYPE_KEY,
} from './types';
import { isRecord, hasOwnProperty, hasOwnProperties } from '../type-helpers';
import { errorMessage } from '../errors';
import * as protoJsonSerializer from 'proto3-json-serializer';
import type { Root, Type, Namespace, Message } from 'protobufjs';
import { DataConverter } from './data-converter';

export abstract class DataConverterWithEncoding extends DataConverter {
  abstract readonly encodingType: EncodingType;
}

/**
 * Converts between JS undefined and NULL Payload
 */
export class UndefinedDataConverter extends DataConverterWithEncoding {
  public encodingType = encodingTypes.METADATA_ENCODING_NULL;

  public toPayload(value: unknown): Payload {
    if (value !== undefined) throw new UnsupportedTypeError(); // Can't encode
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_NULL,
      },
    };
  }

  public fromPayload<T>(_content: Payload): T {
    return undefined as any; // Just return undefined
  }
}

/**
 * Converts between non-undefined values and serialized JSON Payload
 */
export class JsonDataConverter extends DataConverterWithEncoding {
  public encodingType = encodingTypes.METADATA_ENCODING_JSON;

  public toPayload(value: unknown): Payload {
    if (value === undefined) throw new UnsupportedTypeError(); // Should be encoded with the UndefinedDataConverter
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON,
      },
      data: u8(JSON.stringify(value)),
    };
  }

  public fromPayload<T>(content: Payload): T {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    return JSON.parse(str(content.data));
  }
}

/**
 * Converts between binary data types and RAW Payload
 */
export class BinaryDataConverter extends DataConverterWithEncoding {
  public encodingType = encodingTypes.METADATA_ENCODING_RAW;

  public toPayload(value: unknown): Payload {
    // TODO: support any DataView or ArrayBuffer?
    if (!(value instanceof Uint8Array)) {
      throw new UnsupportedTypeError();
    }
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW,
      },
      data: value,
    };
  }

  public fromPayload<T>(content: Payload): T {
    // TODO: support any DataView or ArrayBuffer?
    return content.data as any;
  }
}

abstract class ProtobufDataConverter extends DataConverterWithEncoding {
  protected readonly root: Root | undefined;
  public abstract encodingType: EncodingType;

  // Don't use type Root here because root.d.ts doesn't export Root, so users would have to type assert
  constructor(root?: unknown) {
    super();

    if (root) {
      if (!isRoot(root)) {
        throw new TypeError('root must be an instance of a protobufjs Root');
      }

      this.root = root;
    }
  }

  protected validatePayload(content: Payload): { messageType: Type; data: Uint8Array } {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    if (!content.metadata || !(METADATA_MESSAGE_TYPE_KEY in content.metadata)) {
      throw new ValueError(`Got protobuf payload without metadata.${METADATA_MESSAGE_TYPE_KEY}`);
    }
    if (!this.root) {
      throw new DataConverterError('Unable to deserialize protobuf message without `root` being provided');
    }

    const messageTypeName = str(content.metadata[METADATA_MESSAGE_TYPE_KEY]);
    let messageType;
    try {
      messageType = this.root.lookupType(messageTypeName);
    } catch (e) {
      if (errorMessage(e)?.includes('no such type')) {
        throw new DataConverterError(
          `Got a \`${messageTypeName}\` protobuf message but cannot find corresponding message class in \`root\``
        );
      }

      throw e;
    }

    return { messageType, data: content.data };
  }

  protected constructPayload({ messageTypeName, message }: { messageTypeName: string; message: Uint8Array }): Payload {
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: u8(this.encodingType),
        [METADATA_MESSAGE_TYPE_KEY]: u8(messageTypeName),
      },
      data: message,
    };
  }
}

/**
 * Converts between protobufjs Message instances and serialized Protobuf Payload
 */
export class ProtobufBinaryDataConverter extends ProtobufDataConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_PROTOBUF;

  constructor(root?: unknown) {
    super(root);
  }

  public toPayload(value: unknown): Payload {
    if (!isProtobufMessage(value)) {
      throw new UnsupportedTypeError();
    }

    return this.constructPayload({
      messageTypeName: getNamespacedTypeName(value.$type),
      message: value.$type.encode(value).finish(),
    });
  }

  public fromPayload<T>(content: Payload): T {
    const { messageType, data } = this.validatePayload(content);
    return messageType.decode(data) as unknown as T;
  }
}

/**
 * Converts between protobufjs Message instances and serialized JSON Payload
 */
export class ProtobufJsonDataConverter extends ProtobufDataConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_PROTOBUF_JSON;

  constructor(root?: unknown) {
    super(root);
  }

  public toPayload(value: unknown): Payload {
    if (!isProtobufMessage(value)) {
      throw new UnsupportedTypeError();
    }

    const jsonValue = protoJsonSerializer.toProto3JSON(value);

    return this.constructPayload({
      messageTypeName: getNamespacedTypeName(value.$type),
      message: u8(JSON.stringify(jsonValue)),
    });
  }

  public fromPayload<T>(content: Payload): T {
    const { messageType, data } = this.validatePayload(content);
    return protoJsonSerializer.fromProto3JSON(messageType, JSON.parse(str(data))) as unknown as T;
  }
}

function isProtobufType(type: unknown): type is Type {
  return (
    isRecord(type) &&
    type.constructor.name === 'Type' &&
    hasOwnProperties(type, ['parent', 'name', 'create', 'encode', 'decode']) &&
    typeof type.name === 'string' &&
    typeof type.create === 'function' &&
    typeof type.encode === 'function' &&
    typeof type.decode === 'function'
  );
}

function isProtobufMessage(value: unknown): value is Message {
  return isRecord(value) && hasOwnProperty(value, '$type') && isProtobufType(value.$type);
}

function getNamespacedTypeName(node: Type | Namespace): string {
  if (node.parent && !isRoot(node.parent)) {
    return getNamespacedTypeName(node.parent) + '.' + node.name;
  } else {
    return node.name;
  }
}

function isRoot(root: unknown): root is Root {
  return isRecord(root) && root.constructor.name === 'Root';
}
