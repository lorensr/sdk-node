import { ValueError, UnsupportedTypeError } from '../errors';
import { str, METADATA_ENCODING_KEY, Payload } from './types';
import {
  DataConverterWithEncoding,
  UndefinedDataConverter,
  BinaryDataConverter,
  JsonDataConverter,
  ProtobufJsonDataConverter,
  ProtobufBinaryDataConverter,
} from './data-converters';

/**
 * Used by the framework to serialize/deserialize method parameters that need to be sent over the
 * wire.
 *
 * Extend this in order to customize worker data serialization or use the default data converter which supports `Uint8Array`, Protobuf, and JSON serializables.
 */
export abstract class DataConverter {
  abstract toPayload<T>(value: T): Payload;

  abstract fromPayload<T>(payload: Payload): T;

  /**
   * Implements conversion of a list of values.
   *
   * @param values JS values to convert to Payloads.
   * @return converted value
   * @throws DataConverterError if conversion of the value passed as parameter failed for any
   *     reason.
   */
  toPayloads(...values: unknown[]): Payload[] | undefined {
    if (values.length === 0) {
      return undefined;
    }
    return values.map((value) => this.toPayload(value));
  }

  /**
   * Implements conversion of an array of values of different types. Useful for deserializing
   * arguments of function invocations.
   *
   * @param index index of the value in the payloads
   * @param payloads serialized value to convert to JS values.
   * @return converted JS value
   * @throws DataConverterError if conversion of the data passed as parameter failed for any
   *     reason.
   */
  fromPayloads<T>(index: number, payloads?: Payload[] | null): T {
    // To make adding arguments a backwards compatible change
    if (payloads === undefined || payloads === null || index >= payloads.length) {
      return undefined as any;
    }
    return this.fromPayload(payloads[index]);
  }
}

export const isValidDataConverter = (dataConverter: unknown): dataConverter is DataConverter =>
  typeof dataConverter === 'object' &&
  dataConverter !== null &&
  ['toPayload', 'toPayloads', 'fromPayload', 'fromPayloads'].every(
    (method) => typeof (dataConverter as Record<string, unknown>)[method] === 'function'
  );

export class CompositeDataConverter extends DataConverter {
  readonly converters: DataConverterWithEncoding[];
  readonly converterByEncoding: Map<string, DataConverterWithEncoding> = new Map();

  constructor(...converters: DataConverterWithEncoding[]) {
    super();
    this.converters = converters;
    for (const converter of converters) {
      this.converterByEncoding.set(converter.encodingType, converter);
    }
  }

  public toPayload<T>(value: T): Payload {
    for (const converter of this.converters) {
      try {
        const result = converter.toPayload(value);
        return result;
      } catch (e: unknown) {
        if (e instanceof UnsupportedTypeError) {
          continue;
        } else {
          throw e;
        }
      }
    }
    throw new ValueError(`Cannot serialize ${value}`);
  }

  public fromPayload<T>(payload: Payload): T {
    if (payload.metadata === undefined || payload.metadata === null) {
      throw new ValueError('Missing payload metadata');
    }
    const encoding = str(payload.metadata[METADATA_ENCODING_KEY]);
    const converter = this.converterByEncoding.get(encoding);
    if (converter === undefined) {
      throw new ValueError(`Unknown encoding: ${encoding}`);
    }
    return converter.fromPayload(payload);
  }
}

export function arrayFromPayloads(converter: DataConverter, content?: Payload[] | null): unknown[] {
  if (!content) {
    return [];
  }
  return content.map((payload: Payload) => converter.fromPayload(payload));
}

export function mapToPayloads<K extends string>(converter: DataConverter, source: Record<K, any>): Record<K, Payload> {
  return Object.fromEntries(
    Object.entries(source).map(([k, v]): [K, Payload] => [k as K, converter.toPayload(v)])
  ) as Record<K, Payload>;
}

export function arrayFromPayloadsSync(converter: DataConverter, content?: Payload[] | null): unknown[] {
  if (!content) {
    return [];
  }
  return content.map((payload: Payload) => converter.fromPayload(payload));
}

export function mapToPayloadsSync<K extends string>(
  converter: DataConverter,
  source: Record<K, any>
): Record<K, Payload> {
  return Object.fromEntries(
    Object.entries(source).map(([k, v]): [K, Payload] => [k as K, converter.toPayload(v)])
  ) as Record<K, Payload>;
}

export interface DefaultDataConverterOptions {
  root?: Record<string, unknown>;
}

export class DefaultDataConverter extends CompositeDataConverter {
  constructor({ root }: DefaultDataConverterOptions = {}) {
    // Match the order used in other SDKs
    // Go SDK: https://github.com/temporalio/sdk-go/blob/5e5645f0c550dcf717c095ae32c76a7087d2e985/converter/default_data_converter.go#L28
    super(
      new UndefinedDataConverter(),
      new BinaryDataConverter(),
      new ProtobufJsonDataConverter(root),
      new ProtobufBinaryDataConverter(root),
      new JsonDataConverter()
    );
  }
}

export const defaultDataConverter = new DefaultDataConverter();
