/**
 * "Site language" in the page (docs/ARCHITECTURE.md §11): while the tab has a language override, the page sees it as
 * the browser's language —
 *  - `navigator.language` / `navigator.languages` (getters on Navigator.prototype),
 *  - the Intl default locale: `Intl.DateTimeFormat` / `NumberFormat` / `Collator` / `PluralRules` /
 *    `RelativeTimeFormat` / `ListFormat` / `DisplayNames` / `Segmenter` / `DurationFormat` constructors (with or
 *    without `new`) and their `supportedLocalesOf`, `Date.prototype.toLocale(Date|Time)String`,
 *    `Number.prototype.toLocaleString`, `BigInt.prototype.toLocaleString`, `String.prototype.localeCompare` — only
 *    when no locale argument (undefined) is passed,
 *  - a `languagechange` event on window whenever the reported languages change.
 *
 * The languages come from the content script (`{t:'lang'}` on the private port) as soon as it knows them: the tab's
 * override is kept by the service worker, so it arrives asynchronously (usually a few ms after document_start). Page
 * scripts that read the language before that see the browser's; the overlay offers a reload for that reason.
 *
 * Off = zero behaviour change: nothing is installed until a first override arrives. Once installed, the wrappers are
 * pass-through (the native call with the page's own receiver and arguments) while no override is active. Wrappers
 * keep names / lengths / property attributes and report native `toString()`; constructors become Proxies of the
 * functions they replace (same prototype, statics, `instanceof`; `prototype.constructor` points at the Proxy).
 */
import { disguiseFunction, disguiseProxy, replaceMethod } from './disguise';
import { call, defineProperty, getOwnPropertyDescriptor, isArray, setTimer, W } from './natives';

const reflectConstruct = Reflect.construct;
const NativeProxy = Proxy;
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const NativeEvent = Event;
const dispatchEventFn = EventTarget.prototype.dispatchEvent;
const NativeIntl: typeof Intl | undefined = typeof Intl === 'object' && Intl !== null ? Intl : undefined;
const getCanonicalLocales: ((locales: string) => string[]) | undefined =
  NativeIntl && typeof NativeIntl.getCanonicalLocales === 'function' ? NativeIntl.getCanonicalLocales : undefined;
const NAVIGATOR: Navigator | undefined = W.navigator;
const navigatorProto: object | undefined = typeof W.Navigator === 'function' ? W.Navigator.prototype : undefined;
const nativeLanguagesGetter = navigatorProto ? getOwnPropertyDescriptor(navigatorProto, 'languages')?.get : undefined;

const MAX_LANGUAGES = 10;
const MAX_TAG = 35;
const INTL_CONSTRUCTORS = [
  'DateTimeFormat',
  'NumberFormat',
  'Collator',
  'PluralRules',
  'RelativeTimeFormat',
  'ListFormat',
  'DisplayNames',
  'Segmenter',
  'DurationFormat',
] as const;

/** The override (frozen, preferred first), or null: the browser's own languages. */
let languages: readonly string[] | null = null;
let installed = false;

function data(value: unknown): PropertyDescriptor {
  return { value, writable: true, enumerable: true, configurable: true };
}

/** A fresh array of the override (Intl reads it; the page never gets a shared one to mutate). */
function localeList(list: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) defineProperty(out, i, data(list[i]));
  return out;
}

/**
 * The arguments with the override filled in at `index` when it is undefined (or missing). Built with
 * defineProperty, so index setters a page may have put on Array.prototype are never invoked.
 */
function withLocales(args: ArrayLike<unknown>, index: number, list: readonly string[]): unknown[] {
  const n = args.length;
  const out: unknown[] = [];
  const len = n > index ? n : index + 1;
  for (let i = 0; i < len; i++) defineProperty(out, i, data(i < n ? args[i] : undefined));
  if (out[index] === undefined) defineProperty(out, index, data(localeList(list)));
  return out;
}

// ------------------------------------------------------------------------------------------- install

function installNavigator(): void {
  if (!navigatorProto) return;
  const langDesc = getOwnPropertyDescriptor(navigatorProto, 'language');
  const nativeLanguage = langDesc?.get;
  if (langDesc && nativeLanguage && langDesc.configurable) {
    const getter = getOwnPropertyDescriptor(
      {
        get language(): unknown {
          // The native receiver check first (TypeError "Illegal invocation" for foreign receivers).
          const value: unknown = call(nativeLanguage, this);
          return languages ? languages[0] : value;
        },
      },
      'language',
    )!.get!;
    disguiseFunction(getter, 'get language');
    defineProperty(navigatorProto, 'language', { get: getter, set: undefined, enumerable: langDesc.enumerable, configurable: true });
  }
  const langsDesc = getOwnPropertyDescriptor(navigatorProto, 'languages');
  const nativeLanguages = langsDesc?.get;
  if (langsDesc && nativeLanguages && langsDesc.configurable) {
    const getter = getOwnPropertyDescriptor(
      {
        get languages(): unknown {
          const value: unknown = call(nativeLanguages, this);
          return languages ?? value;
        },
      },
      'languages',
    )!.get!;
    disguiseFunction(getter, 'get languages');
    defineProperty(navigatorProto, 'languages', { get: getter, set: undefined, enumerable: langsDesc.enumerable, configurable: true });
  }
}

function wrapIntlConstructor(name: (typeof INTL_CONSTRUCTORS)[number]): void {
  const intl = NativeIntl as unknown as Record<string, unknown> | undefined;
  if (!intl) return;
  const desc = getOwnPropertyDescriptor(intl, name);
  const target: unknown = desc?.value;
  if (!desc || typeof target !== 'function' || (!desc.configurable && !desc.writable)) return;
  const fn = target as (...args: unknown[]) => unknown;

  const statics = getOwnPropertyDescriptor(fn, 'supportedLocalesOf');
  const supported: unknown = statics?.value;
  if (typeof supported === 'function') {
    const original = supported as (...args: unknown[]) => unknown;
    const wrapper = {
      supportedLocalesOf(this: unknown): unknown {
        return languages ? call(original, this, withLocales(arguments, 0, languages)) : call(original, this, arguments);
      },
    }.supportedLocalesOf;
    try {
      replaceMethod(fn, 'supportedLocalesOf', original, wrapper);
    } catch {
      /* keep the native static */
    }
  }

  // A prototype-less handler: traps are looked up on it, so Object.prototype pollution cannot add any.
  const handler = objectCreate(null) as ProxyHandler<(...args: unknown[]) => unknown>;
  handler.construct = (t, args, newTarget) => reflectConstruct(t, languages ? withLocales(args, 0, languages) : args, newTarget);
  handler.apply = (t, thisArg, args) => call(t, thisArg, languages ? withLocales(args, 0, languages) : args);
  const proxy = new NativeProxy(fn, handler);
  disguiseProxy(proxy, name);
  const proto: unknown = (fn as unknown as { prototype?: unknown }).prototype;
  if (typeof proto === 'object' && proto !== null) {
    const ctor = getOwnPropertyDescriptor(proto, 'constructor');
    if (ctor && ctor.value === fn && (ctor.configurable || ctor.writable)) {
      defineProperty(proto, 'constructor', { value: proxy, writable: ctor.writable, enumerable: ctor.enumerable, configurable: ctor.configurable });
    }
  }
  defineProperty(intl, name, { value: proxy, writable: desc.writable, enumerable: desc.enumerable, configurable: desc.configurable });
}

/** `target[key]` as a function, or null. */
function method(target: object | undefined, key: string): ((...args: unknown[]) => unknown) | null {
  if (!target) return null;
  const value: unknown = getOwnPropertyDescriptor(target, key)?.value;
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : null;
}

function installLocaleMethods(): void {
  // Separate wrapper sources per name: Function.prototype.toString of another realm recognizes wrappers by source.
  const dateProto = Date.prototype;
  const dateToLocaleString = method(dateProto, 'toLocaleString');
  if (dateToLocaleString) {
    replaceMethod(dateProto, 'toLocaleString', dateToLocaleString, {
      toLocaleString(this: unknown): unknown {
        return languages ? call(dateToLocaleString, this, withLocales(arguments, 0, languages)) : call(dateToLocaleString, this, arguments);
      },
    }.toLocaleString);
  }
  const dateToLocaleDateString = method(dateProto, 'toLocaleDateString');
  if (dateToLocaleDateString) {
    replaceMethod(dateProto, 'toLocaleDateString', dateToLocaleDateString, {
      toLocaleDateString(this: unknown): unknown {
        return languages
          ? call(dateToLocaleDateString, this, withLocales(arguments, 0, languages))
          : call(dateToLocaleDateString, this, arguments);
      },
    }.toLocaleDateString);
  }
  const dateToLocaleTimeString = method(dateProto, 'toLocaleTimeString');
  if (dateToLocaleTimeString) {
    replaceMethod(dateProto, 'toLocaleTimeString', dateToLocaleTimeString, {
      toLocaleTimeString(this: unknown): unknown {
        return languages
          ? call(dateToLocaleTimeString, this, withLocales(arguments, 0, languages))
          : call(dateToLocaleTimeString, this, arguments);
      },
    }.toLocaleTimeString);
  }
  const numberToLocaleString = method(Number.prototype, 'toLocaleString');
  if (numberToLocaleString) {
    replaceMethod(Number.prototype, 'toLocaleString', numberToLocaleString, {
      toLocaleString(this: unknown): unknown {
        return languages
          ? call(numberToLocaleString, this, withLocales(arguments, 0, languages))
          : call(numberToLocaleString, this, arguments);
      },
    }.toLocaleString);
  }
  const bigIntProto: object | undefined = typeof BigInt === 'function' ? BigInt.prototype : undefined;
  const bigIntToLocaleString = method(bigIntProto, 'toLocaleString');
  if (bigIntProto && bigIntToLocaleString) {
    replaceMethod(bigIntProto, 'toLocaleString', bigIntToLocaleString, {
      toLocaleString(this: unknown): unknown {
        return languages
          ? call(bigIntToLocaleString, this, withLocales(arguments, 0, languages))
          : call(bigIntToLocaleString, this, arguments);
      },
    }.toLocaleString);
  }
  const localeCompare = method(String.prototype, 'localeCompare');
  if (localeCompare) {
    replaceMethod(String.prototype, 'localeCompare', localeCompare, {
      localeCompare(this: unknown): unknown {
        return languages ? call(localeCompare, this, withLocales(arguments, 1, languages)) : call(localeCompare, this, arguments);
      },
    }.localeCompare);
  }
}

function install(): void {
  for (const step of [installNavigator, installLocaleMethods]) {
    try {
      step();
    } catch {
      /* that part stays native */
    }
  }
  for (const name of INTL_CONSTRUCTORS) {
    try {
      wrapIntlConstructor(name);
    } catch {
      /* stays native */
    }
  }
}

// ------------------------------------------------------------------------------------------- updates

/** A valid override list from the (untrusted) port message, frozen; null for none / garbage. */
function sanitize(value: unknown): readonly string[] | null {
  if (!isArray(value)) return null;
  const n = value.length;
  if (n < 1 || n > MAX_LANGUAGES || !getCanonicalLocales || !NativeIntl) return null;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const tag: unknown = value[i];
    if (typeof tag !== 'string' || tag.length === 0 || tag.length > MAX_TAG) return null;
    let canonical: unknown;
    try {
      canonical = call<string[]>(getCanonicalLocales, NativeIntl, [tag])[0];
    } catch {
      return null;
    }
    // The content script sends canonical tags; anything else is refused rather than guessed.
    if (canonical !== tag) return null;
    defineProperty(out, i, { value: tag, writable: false, enumerable: true, configurable: false });
  }
  return objectFreeze(out);
}

function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** What navigator.languages reports right now (the override, else the browser's). */
function reported(): readonly string[] | null {
  if (languages) return languages;
  if (!nativeLanguagesGetter || !NAVIGATOR) return null;
  try {
    const value: unknown = call(nativeLanguagesGetter, NAVIGATOR);
    return isArray(value) ? (value as readonly string[]) : null;
  } catch {
    return null;
  }
}

/**
 * `{t:'lang'}` from the content script: switch the override (null = the browser's languages). Installs the
 * wrappers on the first override; fires `languagechange` when what the page sees changes.
 */
export function setLanguages(value: unknown): void {
  const next = sanitize(value);
  if (sameList(next, languages)) return;
  if (next && !installed) {
    installed = true;
    install();
  }
  const before = reported();
  languages = next;
  if (sameList(before, reported())) return;
  setTimer(() => {
    try {
      call(dispatchEventFn, W, [new NativeEvent('languagechange')]);
    } catch {
      /* never throw into the page */
    }
  }, 0);
}
