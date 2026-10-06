import type { HeaderPair } from './protocol';

/** Parse an XMLHttpRequest.getAllResponseHeaders() block. */
export function parseHeaderBlock(text: unknown): HeaderPair[] {
  const headers: HeaderPair[] = [];
  if (typeof text !== 'string') return headers;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() === '') continue;
    const previous = headers[headers.length - 1];
    if ((line.startsWith(' ') || line.startsWith('\t')) && previous) {
      previous.value = previous.value ? `${previous.value} ${line.trim()}` : line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (name === '' || /\s/.test(name)) continue;
    headers.push({ name, value: line.slice(colon + 1).trim() });
  }
  return headers;
}

/** First header value by case-insensitive name. */
export function findHeader(headers: HeaderPair[], name: string): string | null {
  const lower = name.toLowerCase();
  for (const header of headers) if (header.name.toLowerCase() === lower) return header.value;
  return null;
}

/** Headers / plain object / [name, value][] / anything with forEach -> pairs. Never throws. */
export function headersInitToPairs(init: unknown): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  try {
    if (!init || typeof init !== 'object') return pairs;
    if (Array.isArray(init)) {
      for (const item of init) {
        if (Array.isArray(item) && item.length >= 2) pairs.push({ name: String(item[0]), value: String(item[1]) });
      }
      return pairs;
    }
    const withForEach = init as { forEach?: unknown; entries?: unknown };
    if (typeof withForEach.forEach === 'function' && typeof withForEach.entries === 'function') {
      (init as { forEach(fn: (value: string, name: string) => void): void }).forEach((value, name) =>
        pairs.push({ name: String(name), value: String(value) }),
      );
      return pairs;
    }
    for (const key of Object.keys(init)) {
      const value = (init as Record<string, unknown>)[key];
      if (value !== undefined) pairs.push({ name: key, value: String(value) });
    }
  } catch {
    /* best effort */
  }
  return pairs;
}

const TEXTUAL_SUBTYPES = new Set([
  'json',
  'xml',
  'javascript',
  'x-javascript',
  'ecmascript',
  'x-ecmascript',
  'x-www-form-urlencoded',
  'graphql',
  'csv',
  'yaml',
  'x-yaml',
  'x-ndjson',
  'ndjson',
  'html',
  'xhtml+xml',
  'svg+xml',
  'problem+json',
]);

/** Lower-cased "type/subtype" and charset of a Content-Type value. */
export function mimeOf(contentType: string | null | undefined): { mime: string; charset: string | undefined } {
  if (!contentType) return { mime: '', charset: undefined };
  const semicolon = contentType.indexOf(';');
  const mime = (semicolon < 0 ? contentType : contentType.slice(0, semicolon)).trim().toLowerCase();
  const match = semicolon < 0 ? null : /;\s*charset\s*=\s*"?([^";\s]*)/i.exec(contentType.slice(semicolon));
  return { mime, charset: match && match[1] ? match[1] : undefined };
}

export function isTextualMime(mime: string): boolean {
  const slash = mime.indexOf('/');
  if (slash <= 0) return false;
  const type = mime.slice(0, slash);
  const subtype = mime.slice(slash + 1);
  if (type === 'text') return true;
  return TEXTUAL_SUBTYPES.has(subtype) || subtype.endsWith('+json') || subtype.endsWith('+xml') || subtype.endsWith('+yaml');
}
