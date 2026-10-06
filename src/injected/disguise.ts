/**
 * Installs wrappers so they look like the natives they replace: same `name` / `length`, not constructible
 * (callers pass method-shorthand functions), and `Function.prototype.toString` reports
 * `function name() { [native code] }` — libraries such as lodash/core-js `isNative` checks keep working.
 */
import {
  call,
  defineProperty,
  fnToString,
  getOwnPropertyDescriptor,
  mapGet,
  mapSet,
  NativeMap,
  NativeSet,
  NativeWeakMap,
  setAdd,
  setHas,
  weakMapGet,
  weakMapSet,
} from './natives';

const disguised = new NativeWeakMap<object, string>();
/**
 * Real source text of every wrapper → its disguised text. Every frame runs the same hook bundle, so another
 * realm's wrappers have the same source: the toString of an iframe recognises the top window's fetch (and
 * the other way round), which a per-realm WeakMap cannot. Lengths are checked first to keep misses cheap.
 */
const disguisedBySource = new NativeMap<string, string>();
const sourceLengths = new NativeSet<number>();
let toStringPatched = false;

/** Register `fn` so Function.prototype.toString reports it as the native `name` (in every realm). */
function disguise(fn: object, name: string): void {
  const text = `function ${name}() { [native code] }`;
  call(weakMapSet, disguised, [fn, text]);
  try {
    const source = call<string>(fnToString, fn, []);
    call(mapSet, disguisedBySource, [source, text]);
    call(setAdd, sourceLengths, [source.length]);
  } catch {
    /* not a function */
  }
}

function patchFunctionToString(): void {
  if (toStringPatched) return;
  toStringPatched = true;
  const descriptor = getOwnPropertyDescriptor(Function.prototype, 'toString');
  if (descriptor && !descriptor.configurable && !descriptor.writable) return;
  const replacement = {
    toString(this: unknown): string {
      if (typeof this === 'function') {
        const text = call<string | undefined>(weakMapGet, disguised, [this]);
        if (text !== undefined) return text;
        const source = call<string>(fnToString, this, []);
        if (call<boolean>(setHas, sourceLengths, [source.length])) {
          const other = call<string | undefined>(mapGet, disguisedBySource, [source]);
          if (other !== undefined) return other;
        }
        return source;
      }
      // Same receiver checks / TypeError as the native for non-functions.
      return call<string>(fnToString, this, []);
    },
  }.toString;
  disguise(replacement, 'toString');
  defineProperty(Function.prototype, 'toString', {
    value: replacement,
    writable: descriptor?.writable ?? true,
    enumerable: descriptor?.enumerable ?? false,
    configurable: descriptor?.configurable ?? true,
  });
}

/** Make `fn` report `function name() { [native code] }` (for wrappers installed without replaceMethod). */
export function disguiseFunction(fn: object, name: string): void {
  patchFunctionToString();
  disguise(fn, name);
}

/**
 * Make a Proxy of a native function report `function name() { [native code] }` (a bare Proxy reports
 * `function () { [native code] }`). Only this realm's lookup is registered: the source text of a proxy is the
 * generic native one, which other functions (bound functions, other proxies) share, so it must not be mapped.
 */
export function disguiseProxy(proxy: object, name: string): void {
  patchFunctionToString();
  call(weakMapSet, disguised, [proxy, `function ${name}() { [native code] }`]);
}

/**
 * Replace `target[key]` (a native method `original`) with `wrapper`, keeping the property attributes.
 * Throws when the property cannot be redefined; callers install each hook inside its own try/catch.
 */
export function replaceMethod(target: object, key: string, original: Function, wrapper: Function): void {
  patchFunctionToString();
  const descriptor = getOwnPropertyDescriptor(target, key);
  defineProperty(wrapper, 'name', { value: original.name || key, configurable: true });
  defineProperty(wrapper, 'length', { value: original.length, configurable: true });
  disguise(wrapper, original.name || key);
  defineProperty(target, key, {
    value: wrapper,
    writable: descriptor?.writable ?? true,
    enumerable: descriptor?.enumerable ?? true,
    configurable: descriptor?.configurable ?? true,
  });
}
