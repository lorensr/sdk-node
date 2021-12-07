import { ValueError, DataConverterError } from '../errors';
import {
  u8,
  str,
  Payload,
  encodingTypes,
  encodingKeys,
  METADATA_ENCODING_KEY,
  METADATA_MESSAGE_TYPE_KEY,
  ProtobufEncodable,
  ProtobufDecodable,
} from './types';

/**
 * Used by the framework to serialize/deserialize method parameters that need to be sent over the
 * wire.
 *
 * @author fateev
 */
export interface PayloadConverter {
  encodingType: string;

  /**
   * TODO: Fix comment in https://github.com/temporalio/sdk-java/blob/85593dbfa99bddcdf54c7196d2b73eeb23e94e9e/temporal-sdk/src/main/java/io/temporal/common/converter/DataConverter.java#L46
   * Implements conversion of value to payload
   *
   * @param value JS value to convert.
   * @return converted value or `undefined` if unable to convert.
   * @throws DataConverterException if conversion of the value passed as parameter failed for any
   *     reason.
   */
  toData(value: unknown): Promise<Payload | undefined>;

  /**
   * Implements conversion of payload to value.
   *
   * @param content Serialized value to convert to a JS value.
   * @return converted JS value
   * @throws DataConverterException if conversion of the data passed as parameter failed for any
   *     reason.
   */
  fromData<T>(content: Payload): Promise<T>;

  /**
   * Synchronous version of {@link toData}, used in the Workflow runtime because
   * the async version limits the functionality of the runtime.
   *
   * Implements conversion of value to payload
   *
   * @param value JS value to convert.
   * @return converted value or `undefined` if unable to convert.
   * @throws DataConverterException if conversion of the value passed as parameter failed for any
   *     reason.
   */
  toDataSync(value: unknown): Payload | undefined;

  /**
   * Synchronous version of {@link fromData}, used in the Workflow runtime because
   * the async version limits the functionality of the runtime.
   *
   * Implements conversion of payload to value.
   *
   * @param content Serialized value to convert to a JS value.
   * @return converted JS value
   * @throws DataConverterException if conversion of the data passed as parameter failed for any
   *     reason.
   */
  fromDataSync<T>(content: Payload): T;
}

export abstract class AsyncFacadePayloadConverter implements PayloadConverter {
  abstract encodingType: string;
  abstract toDataSync(value: unknown): Payload | undefined;
  abstract fromDataSync<T>(content: Payload): T;

  public async toData(value: unknown): Promise<Payload | undefined> {
    return this.toDataSync(value);
  }

  public async fromData<T>(content: Payload): Promise<T> {
    return this.fromDataSync(content);
  }
}

/**
 * Converts between JS undefined and NULL Payload
 */
export class UndefinedPayloadConverter extends AsyncFacadePayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_NULL;

  public toDataSync(value: unknown): Payload | undefined {
    if (value !== undefined) return undefined; // Can't encode
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_NULL,
      },
    };
  }

  public fromDataSync<T>(_content: Payload): T {
    return undefined as any; // Just return undefined
  }
}

/**
 * Converts between non-undefined values and serialized JSON Payload
 */
export class JsonPayloadConverter extends AsyncFacadePayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_JSON;

  public toDataSync(value: unknown): Payload | undefined {
    if (value === undefined) return undefined; // Should be encoded with the UndefinedPayloadConverter
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_JSON,
      },
      data: u8(JSON.stringify(value)),
    };
  }

  public fromDataSync<T>(content: Payload): T {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    return JSON.parse(str(content.data));
  }
}

/**
 * Converts between binary data types and RAW Payload
 */
export class BinaryPayloadConverter extends AsyncFacadePayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_RAW;

  public toDataSync(value: unknown): Payload | undefined {
    // TODO: support any DataView or ArrayBuffer?
    if (!(value instanceof Uint8Array)) {
      return undefined;
    }
    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW,
      },
      data: value,
    };
  }

  public fromDataSync<T>(content: Payload): T {
    // TODO: support any DataView or ArrayBuffer?
    return content.data as any;
  }
}

/**
 * Converts between protobufjs Message instances and serialized Protobuf Payload
 */
export class ProtobufPayloadConverter extends AsyncFacadePayloadConverter {
  public encodingType = encodingTypes.METADATA_ENCODING_PROTOBUF;

  constructor(private readonly protobufClasses?: Record<string, Function>) {
    super();
    if (protobufClasses && typeof protobufClasses !== 'object') {
      throw new TypeError('protobufClasses must be an object');
    }
  }

  public toDataSync(value: unknown): Payload | undefined {
    const isProtobufMessageInstance =
      this.protobufClasses &&
      typeof this.protobufClasses === 'object' &&
      value &&
      typeof value === 'object' &&
      value.constructor.name in this.protobufClasses;

    if (!isProtobufMessageInstance) {
      return undefined;
    }

    return {
      metadata: {
        [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_PROTOBUF,
        [METADATA_MESSAGE_TYPE_KEY]: u8(value.constructor.name),
      },
      data: (value.constructor as unknown as ProtobufEncodable).encode(value).finish(),
    };
  }

  public fromDataSync<T>(content: Payload): T {
    if (content.data === undefined || content.data === null) {
      throw new ValueError('Got payload with no data');
    }
    if (!content.metadata || !(METADATA_MESSAGE_TYPE_KEY in content.metadata)) {
      throw new ValueError(`Got protobuf payload without metadata.${METADATA_MESSAGE_TYPE_KEY}`);
    }
    if (!this.protobufClasses) {
      throw new DataConverterError(
        'Unable to deserialize protobuf message without protobufClasses provided to DefaultDataConverter'
      );
    }

    const messageClassName = str(content.metadata[METADATA_MESSAGE_TYPE_KEY]);
    const messageClass = this.protobufClasses[messageClassName];
    if (!messageClass) {
      throw new DataConverterError(
        `Got a \`${messageClassName}\` protobuf message but cannot find corresponding message class in protobufClasses`
      );
    }

    return (messageClass as unknown as ProtobufDecodable).decode<T>(content.data);
  }
}
