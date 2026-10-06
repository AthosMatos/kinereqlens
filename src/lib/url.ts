// OWNER: lib-core agent. Lossless query-string handling.
//
// Decoding follows application/x-www-form-urlencoded rules ('+' -> space, %XX via decodeURIComponent,
// malformed escapes kept literally). Every parsed row stores its original encoded text in `raw`, and
// buildQueryString re-emits that raw text for rows whose decoded key/value are unchanged, so untouched
// rows keep their exact encoding (duplicates, ordering and bare `flag` keys without '=' included).
// Empty segments ("a=1&&b=2") are dropped by parseQueryString; that is fine because the draft layer
// re-sends the original URL verbatim when the query section is unmodified.
// Changed rows are encoded with encodeURIComponent semantics (space -> %20).
import type { KVRow } from '../shared/types';
import { uid } from './ids';

/** Captured at module evaluation so a MAIN-world page patching `URL` later cannot interfere. */
const NativeURL = URL;

/**
 * Split an absolute URL into base (scheme://host[:port]/path, no '?' / '#'), query (without '?')
 * and hash (without '#'). Works on the raw string (no normalization) so the original encoding survives.
 * A '?' that appears after the first '#' belongs to the hash.
 */
export function splitUrl(url: string): { base: string; query: string; hash: string } {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : url.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf('?');
  if (queryAt < 0) return { base: beforeHash, query: '', hash };
  return { base: beforeHash.slice(0, queryAt), query: beforeHash.slice(queryAt + 1), hash };
}

/** Inverse of splitUrl; omits '?' when query is '' and '#' when hash is ''. */
export function joinUrl(base: string, query: string, hash?: string): string {
  return `${base}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;
}

/** Parse "a=1&b=two%20words&flag&a=2" into rows (ids assigned, enabled, raw kept). */
export function parseQueryString(query: string): KVRow[] {
  const rows: KVRow[] = [];
  if (query === '') return rows;
  for (const segment of query.split('&')) {
    if (segment === '') continue;
    const eq = segment.indexOf('=');
    const hasEquals = eq >= 0;
    const rawKey = hasEquals ? segment.slice(0, eq) : segment;
    const rawValue = hasEquals ? segment.slice(eq + 1) : '';
    rows.push({
      id: uid('q'),
      enabled: true,
      key: decodeQueryComponent(rawKey),
      value: decodeQueryComponent(rawValue),
      raw: { key: rawKey, value: rawValue, hasEquals },
    });
  }
  return rows;
}

/** Encoded "key[=value]" for one row, re-using the original encoding of every unchanged component. */
function encodeRow(row: KVRow): string {
  const raw = row.raw;
  const keyText = raw && decodeQueryComponent(raw.key) === row.key ? raw.key : encodeQueryComponent(row.key);
  // A bare flag ("?debug") stays bare as long as it still has no value, even if its key was renamed.
  if (raw && !raw.hasEquals && row.value === '') return keyText;
  const valueText =
    raw && raw.hasEquals && decodeQueryComponent(raw.value) === row.value ? raw.value : encodeQueryComponent(row.value);
  return `${keyText}=${valueText}`;
}

/** Build from enabled rows (disabled rows and rows with empty key AND empty value are skipped). */
export function buildQueryString(rows: KVRow[]): string {
  const parts: string[] = [];
  for (const row of rows) {
    if (!row.enabled || (row.key === '' && row.value === '')) continue;
    parts.push(encodeRow(row));
  }
  return parts.join('&');
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replace lone surrogates with U+FFFD (encodeURIComponent throws on them). */
function toWellFormed(text: string): string {
  const native = (text as { toWellFormed?: () => string }).toWellFormed;
  return typeof native === 'function' ? native.call(text) : text.replace(LONE_SURROGATE, '�');
}

/** Encode a single key or value for a query string (encodeURIComponent semantics; lone surrogates -> U+FFFD). */
export function encodeQueryComponent(text: string): string {
  try {
    return encodeURIComponent(text);
  } catch {
    return encodeURIComponent(toWellFormed(text));
  }
}

const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/** Expected UTF-8 sequence length for a lead byte, 0 when it can never start a sequence. */
function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/**
 * Decode a run of consecutive %XX escapes that is not valid UTF-8 as a whole: valid sequences are decoded,
 * every byte that cannot be part of one is kept as its literal "%XX" text.
 */
function decodeEscapeRunLeniently(run: string): string {
  const count = run.length / 3;
  let out = '';
  let i = 0;
  while (i < count) {
    const length = utf8SequenceLength(parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16));
    if (length > 0 && i + length <= count) {
      try {
        out += decodeURIComponent(run.slice(i * 3, (i + length) * 3));
        i += length;
        continue;
      } catch {
        // Invalid continuation bytes, overlong form or surrogate: fall through and keep this byte literal.
      }
    }
    out += run.slice(i * 3, i * 3 + 3);
    i++;
  }
  return out;
}

/** Decode a single key or value ('+' -> space; malformed % sequences are kept as-is). */
export function decodeQueryComponent(text: string): string {
  const spaced = text.includes('+') ? text.replace(/\+/g, ' ') : text;
  if (!spaced.includes('%')) return spaced;
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced.replace(ESCAPE_RUN, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return decodeEscapeRunLeniently(run);
      }
    });
  }
}

const ABSOLUTE_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:', 'file:']);

/** True when `url` parses as an absolute http(s)/ws(s)/file URL. */
export function isAbsoluteUrl(url: string): boolean {
  try {
    return ABSOLUTE_PROTOCOLS.has(new NativeURL(url).protocol);
  } catch {
    return false;
  }
}

/** Resolve a possibly relative URL against a base; returns the input unchanged if resolution fails. */
export function resolveUrl(url: string, base: string): string {
  try {
    return new NativeURL(url, base).href;
  } catch {
    // An unparsable base makes the two-argument form throw even for absolute inputs.
    try {
      return new NativeURL(url).href;
    } catch {
      return url;
    }
  }
}
