import type { Payload } from './types';

/** Shorthand alias */
export type AnyFunc = (...args: any[]) => any;
/** A tuple without its last element */
export type OmitLast<T> = T extends [...infer REST, any] ? REST : never;
/** F with all arguments but the last */
export type OmitLastParam<F extends AnyFunc> = (...args: OmitLast<Parameters<F>>) => ReturnType<F>;

/** An object T with any nested values of type ToReplace replaced with ReplaceWith */
export type Replace<T, ToReplace, ReplaceWith> = T extends (...args: any[]) => any
  ? T
  : T extends ToReplace
  ? ReplaceWith | Exclude<T, ToReplace>
  : {
      [P in keyof T]: Replace<T[P], ToReplace, ReplaceWith>;
    };

/** Replace Payloads with unknown */
export type Deserialized<T> = Replace<T, Payload, unknown>;

/** Verify that an type _Copy extends _Orig */
export function checkExtends<_Orig, _Copy extends _Orig>(): void {
  // noop, just type check
}
