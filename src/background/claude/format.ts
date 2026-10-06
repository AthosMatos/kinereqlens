// Pure formatting of captured data for Claude Code (docs/specs/v0.2.md §B.3/§B.4): request summaries and
// filtering, RequestDetailForClaude, RunForClaude, TabSummary. Applies redaction (src/lib/redact.ts) unless
// the user chose to share secrets, and clips bodies to `maxBodyChars`. No chrome APIs: unit-tested.
import type { LinkState } from '../../shared/claude-link';
import type {
  BodyForClaude,
  BridgeCalls,
  RequestDetailForClaude,
  RequestSummary,
  RunForClaude,
  TabSummary,
} from '../../shared/claude-protocol';
import type { BridgeListRow } from '../../shared/messages';
import type { BodyModel, Draft, HeaderPair, KVRow, MultipartPart, RequestEntry, SerializedBody, TestRun, WireBody } from '../../shared/types';
import { detectBody } from '../../lib/body';
import { buildReplayRequest } from '../../lib/draft';
import { base64ByteLength, utf8ByteLength } from '../../lib/encoding';
import { clip, formatBytes } from '../../lib/format';
import { getHeader } from '../../lib/headers';
import { serializeJsonTree } from '../../lib/json-tree';
import { REDACTED, isSensitiveKey, redactHeaders, redactJsonTree, redactText as redactFreeText, redactUrl } from '../../lib/redact';
import { buildQueryString } from '../../lib/url';
import { entryToResponseDataWith } from '../../ui/response/adapters';
import { bridgeListRow } from '../../content/claude';
import { DEFAULT_LIST_LIMIT } from './validate';

/** URLs longer than this are clipped in answers (data: URLs). */
export const MAX_URL_CHARS = 8192;
/** Runs listed by getRequest; older runs get shorter bodies. */
export const MAX_RUNS_SHOWN = 5;
export const OLDER_RUN_BODY_CHARS = 2000;

/** Redaction state of one answer: `redact` is the policy, `redacted` records whether anything was replaced. */
export interface FormatContext {
  readonly redact: boolean;
  redacted: boolean;
}

export function formatContext(redact: boolean): FormatContext {
  return { redact, redacted: false };
}

// --------------------------------------------------------------------------------------------- primitives

function clipUrl(url: string): string {
  return url.length > MAX_URL_CHARS ? `${url.slice(0, MAX_URL_CHARS)}…` : url;
}

/** URL for Claude: sensitive query values redacted (when redacting), clipped. */
export function urlOut(url: string, ctx: FormatContext): string {
  if (!ctx.redact) return clipUrl(url);
  try {
    const result = redactUrl(url);
    if (result.redacted) ctx.redacted = true;
    return clipUrl(result.url);
  } catch {
    // Unparsable URL: never risk leaking its query.
    const q = url.indexOf('?');
    if (q < 0) return clipUrl(url);
    ctx.redacted = true;
    return clipUrl(`${url.slice(0, q)}?${REDACTED}`);
  }
}

/** Decoded query pairs of an (already redacted) URL. */
export function queryPairs(url: string): Array<[string, string]> {
  try {
    return [...new URL(url).searchParams.entries()];
  } catch {
    return [];
  }
}

/** Header pairs for Claude (secret values redacted when redacting). */
export function headersOut(headers: readonly HeaderPair[], ctx: FormatContext): Array<[string, string]> {
  let list: readonly HeaderPair[] = headers;
  if (ctx.redact) {
    const result = redactHeaders([...headers]);
    if (result.redacted) ctx.redacted = true;
    list = result.headers;
  }
  return list.map((h) => [h.name, h.value]);
}

const JSON_PAIR = /"((?:[^"\\\n]|\\.){1,100})"(\s*:\s*)("(?:[^"\\\n]|\\.)*"|-?\d[\d.eE+-]*)/g;
const FORM_PAIR = /(^|[?&;\s])([A-Za-z0-9_.[\]-]{1,100})=([^&\s"';,]+)/g;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Best-effort redaction of free text (bodies that are not parseable JSON/form data, e.g. a JSON response cut
 * by the capture cap): JSON-looking and `key=value` pairs with sensitive keys, JWTs and auth schemes.
 */
export function redactText(text: string, ctx: FormatContext): string {
  let changed = false;
  let out = text.replace(JSON_PAIR, (match, key: string, sep: string) => {
    if (!isSensitiveKey(key)) return match;
    changed = true;
    return `"${key}"${sep}"${REDACTED}"`;
  });
  out = out.replace(FORM_PAIR, (match, lead: string, key: string) => {
    if (!isSensitiveKey(key)) return match;
    changed = true;
    return `${lead}${key}=${REDACTED}`;
  });
  out = out.replace(JWT, () => {
    changed = true;
    return REDACTED;
  });
  out = out.replace(AUTH_SCHEME, (_match, scheme: string) => {
    changed = true;
    return `${scheme} ${REDACTED}`;
  });
  // Well-known API key formats, Basic credentials, `password: …` / XML elements (src/lib/redact.ts).
  const free = redactFreeText(out);
  if (free.redacted) {
    out = free.text;
    changed = true;
  }
  if (changed) ctx.redacted = true;
  return out;
}

function formText(rows: KVRow[], ctx: FormatContext): string {
  if (!ctx.redact) return buildQueryString(rows);
  const clean = rows.map((row): KVRow => {
    if (!isSensitiveKey(row.key)) return row;
    ctx.redacted = true;
    return { ...row, value: REDACTED, raw: { key: row.raw?.key ?? row.key, value: REDACTED, hasEquals: true } };
  });
  return buildQueryString(clean);
}

function multipartText(parts: MultipartPart[], ctx: FormatContext): string {
  return parts
    .filter((part) => part.enabled)
    .map((part) => {
      if (part.kind === 'file') {
        const size = part.size ?? (part.base64 ? base64ByteLength(part.base64) : undefined);
        const facts = [part.mime || 'application/octet-stream', size !== undefined ? formatBytes(size) : null].filter(Boolean);
        return `--- part "${part.name}" (file "${part.fileName ?? ''}", ${facts.join(', ')})`;
      }
      let value = part.value;
      if (ctx.redact) {
        if (isSensitiveKey(part.name)) {
          value = REDACTED;
          ctx.redacted = true;
        } else value = redactText(value, ctx);
      }
      return `--- part "${part.name}"\n${value}`;
    })
    .join('\n');
}

function capturedTruncation(body: SerializedBody): boolean {
  switch (body.kind) {
    case 'text':
    case 'base64':
      return body.truncated === true;
    case 'formData':
      return body.entries.some((e) => e.truncated === true || (e.type === 'file' && e.base64 === undefined && e.size > 0));
    default:
      return false;
  }
}

function modelText(model: BodyModel, ctx: FormatContext): { kind: string; text: string } | null {
  switch (model.type) {
    case 'none':
      return null;
    case 'unavailable':
      return { kind: 'unavailable', text: model.reason };
    case 'json': {
      let tree = model.tree;
      if (ctx.redact) {
        const result = redactJsonTree(tree);
        if (result.redacted) ctx.redacted = true;
        tree = result.tree;
      }
      return { kind: model.flavor ? 'graphql' : 'json', text: serializeJsonTree(tree, 2) };
    }
    case 'form':
      return { kind: 'form', text: formText(model.rows, ctx) };
    case 'multipart':
      return { kind: 'multipart', text: multipartText(model.parts, ctx) };
    case 'text':
      return { kind: 'text', text: ctx.redact ? redactText(model.text, ctx) : model.text };
    case 'binary':
      return { kind: 'binary', text: `<binary body: ${formatBytes(model.size)}${model.mime ? `, ${model.mime}` : ''}>` };
  }
}

/** A captured body as text for Claude (JSON pretty-printed losslessly), redacted and clipped. */
export function bodyOut(body: SerializedBody | null | undefined, contentType: string | null, ctx: FormatContext, maxChars: number): BodyForClaude | null {
  if (!body) return null;
  let model: BodyModel;
  try {
    model = detectBody(body, contentType);
  } catch (err) {
    model = { type: 'unavailable', reason: `Body could not be decoded (${err instanceof Error ? err.message : String(err)})` };
  }
  const rendered = modelText(model, ctx);
  if (!rendered) return null;
  const clipped = clip(rendered.text, maxChars);
  const out: BodyForClaude = {
    contentType,
    kind: rendered.kind,
    text: clipped.text,
    truncated: clipped.clipped || capturedTruncation(body),
  };
  if (body.kind === 'text' || body.kind === 'base64') out.size = body.size;
  return out;
}

/** A wire body (what a draft / run sends) as a SerializedBody, for bodyOut. */
export function wireToSerialized(body: WireBody): SerializedBody | null {
  switch (body.kind) {
    case 'text':
      return { kind: 'text', text: body.text, size: utf8ByteLength(body.text) };
    case 'base64':
      return { kind: 'base64', base64: body.base64, size: base64ByteLength(body.base64) };
    default:
      return null;
  }
}

// --------------------------------------------------------------------------------------------- summaries

/** RequestSummary of a list row, with the panel's flags when a panel is connected. */
export function summarize(row: BridgeListRow, panel: LinkState | null, ctx: FormatContext): RequestSummary {
  const work = panel?.work.find((w) => w.id === row.id);
  const summary: RequestSummary = {
    id: row.id,
    method: row.method,
    url: urlOut(row.url, ctx),
    kind: row.kind,
    state: row.state,
    startTime: row.startTime,
    modified: work?.modified === true,
    runs: work?.runs ?? 0,
    selected: panel?.selectedId === row.id,
  };
  if (row.status !== undefined) summary.status = row.status;
  if (row.durationMs !== undefined) summary.durationMs = row.durationMs;
  if (row.size !== undefined) summary.size = row.size;
  return summary;
}

type ListParams = BridgeCalls['listRequests']['params'];

/** The overlay's type-chip names (and common shorthands) as entry kinds. */
const KIND_ALIASES: Record<string, string[]> = {
  'fetch/xhr': ['fetch', 'xhr'],
  api: ['fetch', 'xhr'],
  doc: ['document'],
  js: ['script'],
  css: ['stylesheet'],
  img: ['image'],
  frame: ['subdocument'],
  iframe: ['subdocument'],
  ws: ['websocket'],
};

function kindSet(kinds: readonly string[] | undefined): Set<string> | null {
  if (!kinds?.length) return null;
  const set = new Set<string>();
  for (const kind of kinds) for (const k of KIND_ALIASES[kind.toLowerCase()] ?? [kind.toLowerCase()]) set.add(k);
  return set;
}

function statusMatches(summary: RequestSummary, filter: string): boolean {
  const status = summary.status;
  switch (filter) {
    case 'pending':
      return summary.state === 'pending';
    case 'error':
      return summary.state === 'error';
    case 'aborted':
      return summary.state === 'aborted';
    case 'failed':
      return summary.state === 'error' || summary.state === 'aborted' || (status !== undefined && status >= 400);
    default:
      if (status === undefined) return false;
      return /^\dxx$/.test(filter) ? Math.floor(status / 100) === Number(filter[0]) : String(status) === filter;
  }
}

function textMatches(summary: RequestSummary, terms: string[]): boolean {
  const haystack = `${summary.method} ${summary.url} ${summary.status ?? ''} ${summary.kind}`.toLowerCase();
  return terms.every((term) => (term.startsWith('-') && term.length > 1 ? !haystack.includes(term.slice(1)) : haystack.includes(term)));
}

/**
 * Filter (query terms: all must match method/url/status/kind, `-term` excludes; kinds, chip names such as
 * "fetch/xhr" / "js" / "img" accepted; methods; statuses), sort newest first, paginate.
 */
export function filterRequests(summaries: readonly RequestSummary[], params: ListParams): { total: number; requests: RequestSummary[] } {
  const terms = (params.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const kinds = kindSet(params.kinds);
  const methods = params.methods?.length ? new Set(params.methods.map((m) => m.toUpperCase())) : null;
  const statuses = params.statuses?.length ? params.statuses.map((s) => s.toLowerCase()) : null;
  const matched = summaries
    .map((summary, index) => ({ summary, index }))
    .filter(({ summary }) => {
      if (kinds && !kinds.has(summary.kind)) return false;
      if (methods && !methods.has(summary.method.toUpperCase())) return false;
      if (statuses && !statuses.some((s) => statusMatches(summary, s))) return false;
      return terms.length === 0 || textMatches(summary, terms);
    })
    .sort((a, b) => b.summary.startTime - a.summary.startTime || b.index - a.index)
    .map(({ summary }) => summary);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? DEFAULT_LIST_LIMIT;
  return { total: matched.length, requests: matched.slice(offset, offset + limit) };
}

// --------------------------------------------------------------------------------------------- detail

/** Headers the page set plus the ones only the network layer saw (cookies, UA, …), by name. */
export function requestHeadersOf(entry: RequestEntry): HeaderPair[] {
  const page = entry.requestHeaders;
  const wire = entry.wire?.requestHeaders ?? [];
  if (wire.length === 0) return page;
  const names = new Set(page.map((h) => h.name.toLowerCase()));
  return [...page, ...wire.filter((h) => !names.has(h.name.toLowerCase()))];
}

export interface DetailInput {
  entry: RequestEntry;
  /** Panel data: null when no overlay panel is connected for the tab. */
  panel: LinkState | null;
  /** The user's edited draft (only when modified). */
  draft: Draft | null;
  runs: readonly TestRun[];
  includeRuns: boolean;
  captureResponseBodies: boolean;
}

/** The request a draft sends now, for Claude (redacted, bodies clipped). */
export function editedRequest(draft: Draft, ctx: FormatContext, maxChars: number): RequestDetailForClaude['request'] {
  const { request } = buildReplayRequest(draft, {
    runId: '',
    mode: 'page',
    frameId: 0,
    credentials: 'include',
    redirect: 'follow',
    timeoutMs: 30_000,
    responseBodyCap: 0,
  });
  const url = urlOut(request.url, ctx);
  return {
    method: request.method,
    url,
    query: queryPairs(url),
    headers: headersOut(request.headers, ctx),
    body: bodyOut(wireToSerialized(request.body), getHeader(request.headers, 'content-type') ?? null, ctx, maxChars),
  };
}

/** RequestDetailForClaude of one entry. */
export function requestDetail(input: DetailInput, ctx: FormatContext, maxChars: number): RequestDetailForClaude {
  const { entry } = input;
  const url = urlOut(entry.url, ctx);
  const response = entryToResponseDataWith(entry, { captureResponseBodies: input.captureResponseBodies });
  const responseContentType = getHeader(response.headers, 'content-type') ?? null;
  const detail: RequestDetailForClaude = {
    summary: summarize(bridgeListRow(entry), input.panel, ctx),
    pageUrl: urlOut(entry.pageUrl, ctx),
    request: {
      method: entry.method,
      url,
      query: queryPairs(url),
      headers: headersOut(requestHeadersOf(entry), ctx),
      body: bodyOut(entry.requestBody, entry.requestContentType, ctx, maxChars),
    },
    response: null,
    redacted: false,
  };
  if (entry.source !== 'manual') {
    const body = bodyOut(response.body, responseContentType, ctx, maxChars);
    const out: NonNullable<RequestDetailForClaude['response']> = { headers: headersOut(response.headers, ctx), body };
    if (response.status !== undefined) out.status = response.status;
    if (response.statusText) out.statusText = response.statusText;
    const note = body ? undefined : (response.bodyNote ?? response.error);
    if (note) out.note = note;
    detail.response = out;
  }
  if (input.draft) detail.edited = editedRequest(input.draft, ctx, maxChars);
  if (input.includeRuns && input.runs.length > 0) {
    detail.runs = input.runs
      .slice(0, MAX_RUNS_SHOWN)
      .map((run, i) => runOut(run, ctx, i === 0 ? maxChars : Math.min(maxChars, OLDER_RUN_BODY_CHARS), false));
  }
  detail.redacted = ctx.redacted;
  return detail;
}

/** Extra facts send_request returns beyond RunForClaude. */
export interface RunDetails {
  statusText?: string;
  responseHeaders?: Array<[string, string]>;
  /** Final URL after redirects. */
  finalUrl?: string;
  /** Header names that could not be sent. */
  droppedHeaders?: string[];
  /** Forbidden headers applied through a declarativeNetRequest rule (extension mode). */
  appliedViaDnr?: string[];
  redacted?: boolean;
}

/** RunForClaude of a test run; `detailed` adds response headers and transport notes (send_request). */
export function runOut(run: TestRun, ctx: FormatContext, maxChars: number, detailed: boolean): RunForClaude & RunDetails {
  const out: RunForClaude & RunDetails = {
    runId: run.runId,
    origin: run.origin === 'claude' ? 'claude' : 'user',
    state: run.state,
    mode: run.request.mode,
    startedAt: run.startedAt,
    request: { method: run.request.method, url: urlOut(run.request.url, ctx) },
  };
  const result = run.result;
  if (!result) return out;
  out.durationMs = Math.max(0, result.timing.end - result.timing.start);
  if (result.ok || result.status > 0) out.status = result.status;
  if (result.error) out.error = result.errorHint ? `${result.error} — ${result.errorHint}` : result.error;
  out.responseBody = bodyOut(result.body, getHeader(result.headers, 'content-type') ?? null, ctx, maxChars);
  if (!detailed) return out;
  if (result.statusText) out.statusText = result.statusText;
  out.responseHeaders = headersOut(result.headers, ctx);
  if (result.redirected && result.url) out.finalUrl = urlOut(result.url, ctx);
  if (result.droppedHeaders?.length) out.droppedHeaders = result.droppedHeaders;
  if (result.appliedViaDnr?.length) out.appliedViaDnr = result.appliedViaDnr;
  out.redacted = ctx.redacted;
  return out;
}

// --------------------------------------------------------------------------------------------- tabs, browser

export interface TabFacts {
  tabId: number;
  title: string;
  url: string;
  open: boolean;
  recording: boolean;
  entryCount: number;
  /** Open in the background for Claude Code. */
  hidden?: boolean;
}

/** TabSummary (URL redacted when redacting). */
export function tabOut(facts: TabFacts, defaultTabId: number | null, ctx: FormatContext): TabSummary {
  return {
    tabId: facts.tabId,
    title: facts.title.length > 300 ? `${facts.title.slice(0, 300)}…` : facts.title,
    url: urlOut(facts.url, ctx),
    open: facts.open,
    recording: facts.open && facts.recording,
    entryCount: facts.entryCount,
    active: facts.tabId === defaultTabId,
    ...(facts.open && facts.hidden ? { hidden: true } : {}),
  };
}

interface Brand {
  brand: string;
  version: string;
}

const KNOWN_BRANDS: Array<[RegExp, string]> = [
  [/edge/i, 'Microsoft Edge'],
  [/brave/i, 'Brave'],
  [/opera/i, 'Opera'],
  [/vivaldi/i, 'Vivaldi'],
  [/google chrome/i, 'Google Chrome'],
  [/chromium/i, 'Chromium'],
];

/** "Microsoft Edge 131", from navigator.userAgentData brands, else the UA string. */
export function browserLabel(brands: readonly Brand[] | undefined, userAgent: string): string {
  for (const [pattern, name] of KNOWN_BRANDS) {
    const brand = brands?.find((b) => pattern.test(b.brand));
    if (brand) return `${name} ${brand.version}`;
  }
  const edge = /\bEdg\/(\d+)/.exec(userAgent);
  if (edge) return `Microsoft Edge ${edge[1]}`;
  const chrome = /\bChrome\/(\d+)/.exec(userAgent);
  if (chrome) return `Chromium ${chrome[1]}`;
  return 'Chromium-based browser';
}
