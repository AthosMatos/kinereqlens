// OWNER: lib-core agent. Export a request as a shell / JS snippet.
import type { HeaderPair, WireBody } from '../shared/types';
import { bytesToBase64, utf8Encode } from './encoding';

export interface SnippetRequest {
  method: string;
  url: string;
  headers: HeaderPair[];
  body: WireBody;
}

/** POSIX single-quoted word: everything is literal inside '...', and a quote is written as '\''. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Plain words need no quoting; anything else (custom methods with shell metacharacters) is quoted. */
function shellWord(text: string): string {
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : shellQuote(text);
}

const FETCH_NORMALIZED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);

/** Method as fetch would send it: only DELETE/GET/HEAD/OPTIONS/POST/PUT are upper-cased. */
function normalizeMethod(method: string): string {
  const trimmed = method.trim() || 'GET';
  const upper = trimmed.toUpperCase();
  return FETCH_NORMALIZED_METHODS.has(upper) ? upper : trimmed;
}

/** A text body that cannot be passed as a shell argument (NUL bytes) is shipped as binary instead. */
function effectiveBody(body: WireBody): WireBody {
  if (body.kind === 'text' && body.text.includes('\0')) {
    return { kind: 'base64', base64: bytesToBase64(utf8Encode(body.text)) };
  }
  return body;
}

/**
 * POSIX-shell-safe cURL command (single-quote escaping, one option per line joined with " \\\n  ").
 * Text bodies -> --data-raw (with `-H 'Content-Type:'` when the request has no Content-Type). Base64 (binary) bodies -> `--data-binary @-` preceded by a
 * `printf '%s' '<base64>' | base64 -d |` pipe so the command still reproduces the exact bytes.
 * Omits -X for GET without body and for POST with body.
 *
 * Details: the method is normalized like fetch does (so `get` behaves as GET);
 * HEAD without a body uses `--head` (with -X HEAD curl would wait for a body that never comes);
 * `--globoff` is added when the URL contains [ ] { } so curl does not treat them as glob patterns;
 * a header with an empty value is written `-H 'Name;'` (curl syntax for "send empty", `Name:` would remove it).
 */
export function toCurl(req: SnippetRequest): string {
  const body = effectiveBody(req.body);
  const hasBody = body.kind !== 'none';
  const method = normalizeMethod(req.method);

  const lines: string[] = [`curl ${shellQuote(req.url)}`];
  if (/[[\]{}]/.test(req.url)) lines.push('--globoff');
  if (method === 'HEAD' && !hasBody) {
    lines.push('--head');
  } else if (!(method === 'GET' && !hasBody) && !(method === 'POST' && hasBody)) {
    lines.push(`-X ${shellWord(method)}`);
  }
  for (const header of req.headers) {
    lines.push(`-H ${shellQuote(header.value === '' ? `${header.name};` : `${header.name}: ${header.value}`)}`);
  }
  // curl labels --data bodies application/x-www-form-urlencoded; `Content-Type:` (no value) suppresses that,
  // so a request without a Content-Type is reproduced without one.
  if (hasBody && !req.headers.some((h) => h.name.trim().toLowerCase() === 'content-type')) {
    lines.push(`-H ${shellQuote('Content-Type:')}`);
  }
  if (body.kind === 'text') {
    lines.push(`--data-raw ${shellQuote(body.text)}`);
  } else if (body.kind === 'base64') {
    lines.push('--data-binary @-');
  }

  const command = lines.join(' \\\n  ');
  return body.kind === 'base64' ? `printf '%s' ${shellQuote(body.base64)} | base64 -d | ${command}` : command;
}

/** Header names (case-insensitive) occur more than once. */
function hasDuplicateNames(headers: HeaderPair[]): boolean {
  const seen = new Set<string>();
  for (const header of headers) {
    const lower = header.name.toLowerCase();
    if (seen.has(lower)) return true;
    seen.add(lower);
  }
  return false;
}

/** `headers` property value: an object literal, or an array of [name, value] tuples when names repeat. */
function headersLiteral(headers: HeaderPair[]): string {
  const json = JSON.stringify;
  if (hasDuplicateNames(headers)) {
    return `[\n${headers.map((h) => `    [${json(h.name)}, ${json(h.value)}]`).join(',\n')}\n  ]`;
  }
  return `{\n${headers.map((h) => `    ${json(h.name)}: ${json(h.value)}`).join(',\n')}\n  }`;
}

/** `await fetch(url, { method, headers, body })` snippet; binary bodies use Uint8Array.from(atob(...)). */
export function toFetchSnippet(req: SnippetRequest): string {
  const json = JSON.stringify;
  const props: string[] = [`  method: ${json(normalizeMethod(req.method))}`];
  if (req.headers.length > 0) props.push(`  headers: ${headersLiteral(req.headers)}`);
  const hasContentType = req.headers.some((h) => h.name.trim().toLowerCase() === 'content-type');
  if (req.body.kind === 'text') {
    // A string body would gain "Content-Type: text/plain;charset=UTF-8"; bytes keep the request untyped.
    props.push(hasContentType ? `  body: ${json(req.body.text)}` : `  body: new TextEncoder().encode(${json(req.body.text)})`);
  } else if (req.body.kind === 'base64') {
    props.push(`  body: Uint8Array.from(atob(${json(req.body.base64)}), (c) => c.charCodeAt(0))`);
  }
  return `await fetch(${json(req.url)}, {\n${props.join(',\n')},\n});`;
}
