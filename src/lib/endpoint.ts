// OWNER: lib-prompt agent. Normalizes one captured request (+ its test runs and the user's edited draft) into
// an EndpointSpec: the single input of type generation (typegen.ts) and agent-prompt generation (agentPrompt.ts),
// used by both the overlay's Export tab and the Claude Code bridge.
import type {
  BodyModel,
  BodyType,
  Draft,
  HeaderPair,
  JNode,
  KVRow,
  MultipartPart,
  RequestEntry,
  SerializedBody,
  TestRun,
} from '../shared/types';
import { bodyModified, childByKey, detectBody, looksLikeGraphql } from './body';
import { draftUrl, isDraftModified } from './draft';
import { clip, formatBytes } from './format';
import { getHeader, parseContentType, rowsToHeaders } from './headers';
import {
  REDACTED,
  isSensitiveHeader,
  isSensitiveKey,
  looksLikeSecretValue,
  redactGraphqlDocument,
  redactHeaders,
  redactJsonTree,
  redactText,
  redactUrl,
} from './redact';
import { parseQueryString, splitUrl } from './url';

export type PathParamKind = 'integer' | 'uuid' | 'hex' | 'ulid' | 'date' | 'slug';

export interface PathParam {
  /** Name derived from the previous segment, e.g. /users/123 -> "userId"; fallback "id", "id2"… */
  name: string;
  example: string;
  kind: PathParamKind;
  /** 0-based index of the path segment. */
  index: number;
}

export interface QueryParamSpec {
  name: string;
  /** Distinct example values (already redacted when sensitive), in first-seen order. */
  examples: string[];
  /** Appears more than once in one request (array param). */
  repeated: boolean;
  /** Present in every sample request (false when only some samples carry it). */
  required: boolean;
  redacted: boolean;
}

export interface HeaderSpec {
  name: string;
  /** Example value ("<redacted>" when sensitive). */
  value: string;
  redacted: boolean;
}

export interface AuthSpec {
  scheme: 'bearer' | 'basic' | 'cookie' | 'api-key' | 'other';
  /** Header (or query param / cookie name) that carries it. */
  location: string;
  note: string;
}

export interface BodySpec {
  contentType: string | null;
  kind: BodyType | 'graphql';
  /** JSON samples (request/response bodies as lossless trees); empty for non-JSON kinds. */
  samples: JNode[];
  /** Form / multipart fields (union over samples). */
  fields?: Array<{ name: string; kind: 'text' | 'file'; example?: string; repeated: boolean; required: boolean }>;
  /** Text example for text bodies, or a short description for binary ones. */
  text?: string;
  truncated: boolean;
}

export interface ResponseSpec {
  status: number;
  statusText?: string;
  body: BodySpec | null;
  /** Where the samples came from. */
  sources: Array<'original' | 'run'>;
  /** Interesting response headers (content-type, cache-control, rate limits, location...). */
  headers: HeaderSpec[];
}

export interface GraphqlSpec {
  operationName: string | null;
  operationType: 'query' | 'mutation' | 'subscription' | null;
  /** The GraphQL document. */
  query: string;
}

export interface EndpointSpec {
  method: string;
  /** Example absolute URL (sensitive query values redacted when requested). */
  url: string;
  /** scheme://host[:port] */
  origin: string;
  /** Path with detected parameters replaced, e.g. "/api/users/{userId}/orders". */
  pathTemplate: string;
  pathParams: PathParam[];
  query: QueryParamSpec[];
  /** Headers that matter for an implementation (content-type, accept, auth, custom x-*, api versions);
   * browser-controlled and noise headers (user-agent, sec-*, accept-encoding, connection...) are dropped. */
  requestHeaders: HeaderSpec[];
  auth: AuthSpec[];
  requestBody: BodySpec | null;
  /** One entry per observed status code, sorted by status. */
  responses: ResponseSpec[];
  graphql: GraphqlSpec | null;
  /** fetch credentials mode the page used, when known. */
  credentials?: string;
  /** Origin of the page that made the request (for CORS/cookie context). */
  pageOrigin: string;
  capturedAt: number;
  /** Caveats, e.g. "Response body was truncated at 2 MB", "Edited draft used as the request sample". */
  notes: string[];
  /** Secrets were redacted. */
  redacted: boolean;
}

export interface EndpointInput {
  entry: RequestEntry;
  /** Test runs of the entry (any order); finished runs with responses add response samples. */
  runs?: TestRun[];
  /** The user's draft; when modified it becomes the primary request sample. */
  draft?: Draft | null;
  /** Replace secret values (default true). */
  redact?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

/** JSON samples kept per response status (the captured response first, then runs oldest first). */
const MAX_SAMPLES_PER_STATUS = 5;
/** Request samples kept (the primary sample first). */
const MAX_REQUEST_SAMPLES = 10;
/** Bodies longer than this are not parsed (kept as a text excerpt): keeps the Export tab responsive. */
const MAX_ANALYZED_CHARS = 5 * 1024 * 1024;
/** Longest text example / description kept in a BodySpec (the prompt clips further). */
const MAX_TEXT_CHARS = 8000;
const MAX_URL_CHARS = 2048;
const MAX_EXAMPLE_VALUE_CHARS = 2048;
const MAX_HEADER_VALUE_CHARS = 2048;
const MAX_QUERY_EXAMPLES = 3;
const MAX_SET_COOKIES = 3;

const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

// ---------------------------------------------------------------------------------------------
// Words (shared by path parameter names and type base names)
// ---------------------------------------------------------------------------------------------

const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g;

function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

function capitalize(word: string): string {
  return word === '' ? '' : word[0].toUpperCase() + word.slice(1).toLowerCase();
}

function pascal(parts: string[]): string {
  return parts.map(capitalize).join('');
}

function camel(parts: string[]): string {
  const name = pascal(parts);
  return name === '' ? '' : name[0].toLowerCase() + name.slice(1);
}

const IRREGULAR_SINGULARS: Record<string, string> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  statuses: 'status',
  aliases: 'alias',
  analyses: 'analysis',
  indices: 'index',
  matrices: 'matrix',
  criteria: 'criterion',
  movies: 'movie',
  cookies: 'cookie',
  series: 'series',
  species: 'species',
  news: 'news',
};

/** English singular of one lower-case word (common rules + irregulars; unknown words are kept). */
function singularWord(word: string): string {
  const lower = word.toLowerCase();
  const irregular = IRREGULAR_SINGULARS[lower];
  if (irregular) return irregular;
  if (lower.length > 4 && lower.endsWith('ies')) return `${lower.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/.test(lower) || lower.length <= 3) return lower;
  if (/(?:xes|ches|shes|sses|zzes)$/.test(lower)) return lower.slice(0, -2);
  if (lower.endsWith('s')) return lower.slice(0, -1);
  return lower;
}

/** Words of a path segment with the last one singularized ("custom-reports" -> ["custom", "report"]). */
function singularWords(segment: string): string[] {
  const parts = words(segment);
  if (parts.length === 0) return parts;
  return [...parts.slice(0, -1), singularWord(parts[parts.length - 1])];
}

// ---------------------------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
const ISO_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const SLUG = /^[A-Za-z0-9_-]{8,}$/;
const VERSION_SEGMENT = /^v\d+(?:\.\d+)*(?:[a-z]+\d*)?$/i;
/** Literal segments that never name a resource ("/api/123" is just "id"). */
const NOISE_SEGMENTS = new Set(['api', 'apis', 'rest', 'public', 'internal', 'private', 'graphql', 'gql']);

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function countDigits(text: string): number {
  let digits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x30 && code <= 0x39) digits++;
  }
  return digits;
}

function paramKind(segment: string): PathParamKind | null {
  if (segment === '' || VERSION_SEGMENT.test(segment)) return null;
  if (/^\d+$/.test(segment)) return 'integer';
  if (UUID.test(segment)) return 'uuid';
  if (ISO_DATE.test(segment)) return 'date';
  const digits = countDigits(segment);
  if (HEX.test(segment) && digits > 0) return 'hex';
  if (ULID.test(segment) && digits > 1) return 'ulid';
  // Slugs with ids mixed in ("a1b2-c3d4", "ORD-2024-000123"), not words that happen to hold a digit
  // ("oauth2callback", "covid19-stats").
  if (SLUG.test(segment) && /[A-Za-z]/.test(segment) && digits >= 2 && digits / segment.length >= 0.25) return 'slug';
  return null;
}

function isNoiseSegment(segment: string): boolean {
  return VERSION_SEGMENT.test(segment) || NOISE_SEGMENTS.has(segment.toLowerCase());
}

function baseParamName(previous: string | undefined, kind: PathParamKind): string {
  if (kind === 'date') return 'date';
  if (previous === undefined || isNoiseSegment(previous)) return 'id';
  const resource = camel(singularWords(decodeSegment(previous)));
  return resource === '' || /^\d/.test(resource) ? 'id' : `${resource}Id`;
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  taken.add(name);
  return name;
}

/**
 * Detect id-like path segments: integers, UUIDs, ULIDs, long hex (≥ 16), ISO dates, and slugs that
 * contain digits mixed with letters and dashes (≥ 8 chars, e.g. "a1b2-c3d4"). Never treats API version
 * segments ("v1", "v2") or plain words as params.
 *
 * Details: segments are the pathname without its leading "/" split on "/" (so "/a//b/" keeps its empty
 * segments and trailing slash in the template); detection runs on the percent-decoded segment, which is also
 * the example. Slugs need at least two digits making up a quarter of the segment. Date params are named "date".
 */
export function detectPathParams(pathname: string): { template: string; params: PathParam[] } {
  const path = typeof pathname === 'string' ? pathname : '';
  if (path === '' || path === '/') return { template: '/', params: [] };
  const segments = (path.startsWith('/') ? path.slice(1) : path).split('/');
  const params: PathParam[] = [];
  const taken = new Set<string>();
  let previousLiteral: string | undefined;
  let previousWasParam = false;
  const template = segments.map((segment, index) => {
    const decoded = decodeSegment(segment);
    const kind = paramKind(decoded);
    if (!kind) {
      if (segment !== '') {
        previousLiteral = segment;
        previousWasParam = false;
      }
      return segment;
    }
    const name = uniqueName(baseParamName(previousWasParam ? undefined : previousLiteral, kind), taken);
    params.push({ name, example: decoded, kind, index });
    previousWasParam = true;
    return `{${name}}`;
  });
  return { template: `/${template.join('/')}`, params };
}

// ---------------------------------------------------------------------------------------------
// Base names
// ---------------------------------------------------------------------------------------------

const METHOD_VERBS: Record<string, string> = {
  GET: 'Get',
  POST: 'Create',
  PUT: 'Update',
  PATCH: 'Update',
  DELETE: 'Delete',
  HEAD: 'Head',
  OPTIONS: 'Options',
};

/** A last path segment starting with one of these names the operation itself ("/orders/search"). */
const ACTION_VERBS = new Set([
  'list', 'search', 'find', 'get', 'fetch', 'create', 'update', 'delete', 'remove', 'add', 'upload', 'download',
  'export', 'import', 'login', 'logout', 'signin', 'signout', 'signup', 'register', 'verify', 'validate', 'send',
  'sync', 'refresh', 'check', 'count', 'query', 'submit', 'cancel', 'approve', 'reject', 'reset', 'generate',
  'calculate', 'preview', 'publish', 'archive', 'restore', 'duplicate', 'clone', 'move', 'copy', 'subscribe',
  'unsubscribe', 'confirm', 'resend', 'authenticate', 'authorize', 'invite', 'accept', 'decline', 'start', 'stop',
  'run', 'execute', 'process',
]);
/** Actions that are complete names on their own ("POST /auth/login" -> "Login"). */
const STANDALONE_ACTIONS = new Set(['login', 'logout', 'signin', 'signout', 'signup', 'register', 'authenticate', 'authorize']);
const FILE_EXTENSION = /\.(?:json|xml|php|aspx?|html?|jsp|do|action|cgi)$/i;
const MAX_BASE_NAME = 64;

interface NameSegment {
  text: string;
  followedByParam: boolean;
}

function meaningfulSegments(pathTemplate: string): { segments: NameSegment[]; endsWithParam: boolean } {
  const raw = pathTemplate.split('/').filter((segment) => segment !== '');
  const isParam = (segment: string | undefined) => segment !== undefined && /^\{[^}]*\}$/.test(segment);
  const segments: NameSegment[] = [];
  raw.forEach((segment, i) => {
    if (isParam(segment) || isNoiseSegment(segment) || segment.includes('<')) return;
    const text = decodeSegment(segment).replace(FILE_EXTENSION, '');
    if (words(text).length > 0) segments.push({ text, followedByParam: isParam(raw[i + 1]) });
  });
  return { segments, endsWithParam: isParam(raw[raw.length - 1]) };
}

function finishName(name: string): string {
  const safe = name === '' ? 'Endpoint' : /^\d/.test(name) ? `Api${name}` : name;
  return safe.slice(0, MAX_BASE_NAME);
}

function actionName(last: string[], previous: NameSegment | undefined): string {
  const verb = last[0].toLowerCase();
  const name = pascal(last);
  const bare = last.length === 1 || (last.length === 2 && last[1].toLowerCase() === 'all');
  if (!bare || !previous || STANDALONE_ACTIONS.has(verb)) return name;
  return name + pascal(words(previous.text));
}

/** PascalCase base name for generated types, e.g. "GET /api/users/{userId}/orders" -> "GetUserOrders",
 * POST /orders -> "CreateOrder", GraphQL operation "GetUser" -> "GetUser".
 *
 * Details: the last two meaningful segments are used (version, "api" and parameter segments skipped; a
 * segment followed by a parameter is singular, so is the last one for POST and when the path ends with a
 * parameter); a last segment starting with an action verb names the operation ("…/reports/list-all" ->
 * "ListAllReports", "POST /orders/search" -> "SearchOrders", "POST /auth/login" -> "Login"); an anonymous
 * GraphQL operation is "<Path><OperationType>" ("GraphqlQuery"); "/" is "<Verb>Root". */
export function suggestBaseName(spec: Pick<EndpointSpec, 'method' | 'pathTemplate' | 'graphql'>): string {
  const operationName = spec.graphql?.operationName;
  if (operationName && words(operationName).length > 0) {
    const identifier = /^[A-Za-z][A-Za-z0-9_]*$/.test(operationName);
    return finishName(identifier ? operationName[0].toUpperCase() + operationName.slice(1) : pascal(words(operationName)));
  }
  const method = (spec.method || 'GET').trim().toUpperCase();
  const template = typeof spec.pathTemplate === 'string' ? spec.pathTemplate : '';
  if (spec.graphql) {
    const path = pascal(template.split('/').filter((s) => s !== '' && !s.startsWith('{')).flatMap(words).slice(-2));
    return finishName(`${path || 'Graphql'}${capitalize(spec.graphql.operationType ?? 'query')}`);
  }
  const { segments, endsWithParam } = meaningfulSegments(template);
  const verb = METHOD_VERBS[method] ?? pascal(words(method));
  const last = segments[segments.length - 1];
  if (!last) return finishName(`${verb}Root`);
  const previous = segments[segments.length - 2];
  const lastWords = words(last.text);
  if (!endsWithParam && ACTION_VERBS.has(lastWords[0].toLowerCase())) return finishName(actionName(lastWords, previous));
  const singularLast = endsWithParam || method === 'POST';
  const lastPart = pascal(singularLast ? singularWords(last.text) : lastWords);
  const previousPart = previous ? pascal(previous.followedByParam ? singularWords(previous.text) : words(previous.text)) : '';
  return finishName(`${verb}${previousPart}${lastPart}`);
}

// ---------------------------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------------------------

interface RequestSample {
  method: string;
  url: string;
  headers: HeaderPair[];
  contentType: string | null;
  body: BodyModel;
  /** The captured body is incomplete (capture cap). */
  truncated: boolean;
  /** The body is over MAX_ANALYZED_CHARS: only an excerpt is kept. */
  tooLarge?: boolean;
}

interface ResponseSample {
  status: number;
  statusText?: string;
  headers: HeaderPair[];
  contentType: string | null;
  /** undefined: the body was not captured (webRequest entries). */
  body: SerializedBody | null | undefined;
  source: 'original' | 'run';
}

interface Location {
  origin: string;
  pathname: string;
  /** Lower-cased scheme without ':' ('' when the URL does not parse). */
  scheme: string;
}

function locate(url: string): Location {
  try {
    const parsed = new URL(url);
    return {
      origin: parsed.origin === 'null' ? '' : parsed.origin,
      pathname: parsed.pathname,
      scheme: parsed.protocol.replace(/:$/, '').toLowerCase(),
    };
  } catch {
    return { origin: '', pathname: '', scheme: '' };
  }
}

function isHttp(location: Location): boolean {
  return location.scheme === 'http' || location.scheme === 'https';
}

function originOf(url: string | undefined): string {
  return url ? locate(url).origin : '';
}

function normalizeMethod(method: string): string {
  return (typeof method === 'string' ? method.trim() : '').toUpperCase() || 'GET';
}

function serializedSize(body: SerializedBody): number {
  switch (body.kind) {
    case 'text':
      return body.text.length;
    case 'base64':
      return body.base64.length;
    default:
      return 0;
  }
}

function isTruncated(body: SerializedBody | null | undefined): boolean {
  if (!body) return false;
  if (body.kind === 'text' || body.kind === 'base64') return body.truncated === true;
  if (body.kind === 'formData') return body.entries.some((entry) => entry.truncated === true);
  return false;
}

function isTooLarge(body: SerializedBody | null | undefined): boolean {
  return !!body && serializedSize(body) > MAX_ANALYZED_CHARS;
}

/** detectBody, except that bodies too large to analyze stay a text excerpt. */
function modelOf(body: SerializedBody | null | undefined, contentType: string | null): BodyModel {
  if (body && isTooLarge(body)) {
    const text =
      body.kind === 'text'
        ? body.text.slice(0, MAX_TEXT_CHARS)
        : `<${formatBytes(body.kind === 'base64' ? body.size : serializedSize(body))} body, too large to analyze>`;
    return { type: 'text', text };
  }
  try {
    return detectBody(body ?? null, contentType);
  } catch {
    return { type: 'unavailable', reason: 'The body could not be decoded' };
  }
}

function wireToSerialized(body: TestRun['request']['body']): SerializedBody | null {
  if (body.kind === 'text') return { kind: 'text', text: body.text, size: body.text.length };
  if (body.kind === 'base64') return { kind: 'base64', base64: body.base64, size: Math.floor((body.base64.length * 3) / 4) };
  return null;
}

function entrySample(entry: RequestEntry): RequestSample {
  const headers = Array.isArray(entry.requestHeaders) ? entry.requestHeaders : [];
  const contentType = entry.requestContentType ?? getHeader(headers, 'content-type') ?? null;
  return {
    method: normalizeMethod(entry.method),
    url: typeof entry.url === 'string' ? entry.url : '',
    headers,
    contentType,
    body: modelOf(entry.requestBody, contentType),
    truncated: isTruncated(entry.requestBody),
    tooLarge: isTooLarge(entry.requestBody),
  };
}

function draftSample(draft: Draft): RequestSample {
  const headers = rowsToHeaders(draft.headers);
  const bodyChanged = bodyModified(draft.original.body, draft.body);
  return {
    method: normalizeMethod(draft.method),
    url: draftUrl(draft),
    headers,
    contentType: getHeader(headers, 'content-type') ?? null,
    body: draft.body,
    truncated: !bodyChanged && draft.originalWire.bodyIncomplete,
  };
}

function runSample(run: TestRun): RequestSample {
  const request = run.request;
  const contentType = getHeader(request.headers, 'content-type') ?? null;
  return {
    method: normalizeMethod(request.method),
    url: request.url,
    headers: request.headers,
    contentType,
    body: modelOf(wireToSerialized(request.body), contentType),
    truncated: false,
  };
}

function endpointKey(method: string, url: string): string {
  const location = locate(url);
  const path = isHttp(location) ? detectPathParams(location.pathname).template : splitUrl(url).base;
  return `${method} ${location.origin.toLowerCase()}${path}`;
}

function isSuccess(status: number | undefined): boolean {
  return typeof status === 'number' && status >= 200 && status < 300;
}

/** Finished runs with a response, oldest first (stable for any input order). */
function finishedRuns(runs: TestRun[] | undefined): TestRun[] {
  return (Array.isArray(runs) ? runs : [])
    .filter(
      (run) =>
        run?.state === 'done' &&
        run.result?.ok === true &&
        run.result.status > 0 &&
        typeof run.request?.url === 'string' &&
        Array.isArray(run.request.headers) &&
        Array.isArray(run.result.headers),
    )
    .sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Redaction bookkeeping
// ---------------------------------------------------------------------------------------------

/** Applies redaction when enabled and remembers whether anything sensitive was seen either way. */
class Redactor {
  redacted = false;
  sensitiveSeen = false;

  constructor(readonly enabled: boolean) {}

  private result<T>(original: T, redacted: { value: T; changed: boolean }): T {
    if (!redacted.changed) return original;
    this.sensitiveSeen = true;
    if (!this.enabled) return original;
    this.redacted = true;
    return redacted.value;
  }

  url(url: string): string {
    const out = redactUrl(url);
    return this.result(url, { value: out.url, changed: out.redacted });
  }

  headers(headers: HeaderPair[]): HeaderPair[] {
    const out = redactHeaders(headers);
    return this.result(headers, { value: out.headers, changed: out.redacted });
  }

  tree(tree: JNode): JNode {
    const out = redactJsonTree(tree);
    return this.result(tree, { value: out.tree, changed: out.redacted });
  }

  text(text: string): string {
    const out = redactText(text);
    return this.result(text, { value: out.text, changed: out.redacted });
  }

  graphql(text: string): string {
    const out = redactGraphqlDocument(text);
    return this.result(text, { value: out.text, changed: out.redacted });
  }

  /** One key/value pair (query param, form field, multipart text part). */
  value(name: string, value: string): string {
    const sensitive = value !== '' && value !== REDACTED && (isSensitiveKey(name) || looksLikeSecretValue(value));
    return this.result(value, { value: REDACTED, changed: sensitive });
  }
}

// ---------------------------------------------------------------------------------------------
// Request parts
// ---------------------------------------------------------------------------------------------

function exampleValue(value: string, max = MAX_EXAMPLE_VALUE_CHARS): string {
  const { text, clipped } = clip(value, max);
  return clipped ? `${text}…` : text;
}

interface FieldAccumulator {
  name: string;
  kind: 'text' | 'file';
  examples: string[];
  repeated: boolean;
  /** Samples that carry it. */
  count: number;
}

/** Union of name/value pairs over samples: first-seen order, repeated within one sample, required in all. */
function accumulate(
  samples: Array<Array<{ name: string; value: string; kind: 'text' | 'file' }>>,
  maxExamples: number,
): FieldAccumulator[] {
  const fields = new Map<string, FieldAccumulator>();
  for (const sample of samples) {
    const counts = new Map<string, number>();
    for (const pair of sample) {
      let field = fields.get(pair.name);
      if (!field) {
        field = { name: pair.name, kind: pair.kind, examples: [], repeated: false, count: 0 };
        fields.set(pair.name, field);
      }
      if (pair.kind === 'file') field.kind = 'file';
      counts.set(pair.name, (counts.get(pair.name) ?? 0) + 1);
      if (field.examples.length < maxExamples && !field.examples.includes(pair.value)) field.examples.push(pair.value);
    }
    for (const [name, count] of counts) {
      const field = fields.get(name) as FieldAccumulator;
      field.count++;
      if (count > 1) field.repeated = true;
    }
  }
  return [...fields.values()];
}

function queryPairs(url: string, redactor: Redactor): Array<{ name: string; value: string; kind: 'text' }> {
  return parseQueryString(splitUrl(url).query).map((row) => ({
    name: row.key,
    value: exampleValue(redactor.value(row.key, row.value)),
    kind: 'text' as const,
  }));
}

function querySpecs(samples: RequestSample[], redactor: Redactor): QueryParamSpec[] {
  const fields = accumulate(
    samples.map((sample) => queryPairs(sample.url, redactor)),
    MAX_QUERY_EXAMPLES,
  );
  return fields.map((field) => ({
    name: field.name,
    examples: field.examples,
    repeated: field.repeated,
    required: field.count === samples.length,
    redacted: field.examples.includes(REDACTED),
  }));
}

/** Browser-controlled or transport headers an implementation never sets by hand. */
const NOISE_REQUEST_HEADERS = new Set([
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'content-length',
  'cookie',
  'dnt',
  'host',
  'if-modified-since',
  'if-none-match',
  'keep-alive',
  'origin',
  'pragma',
  'priority',
  'purpose',
  'referer',
  'te',
  'upgrade-insecure-requests',
  'user-agent',
  'x-client-data',
]);

function isRelevantRequestHeader(header: HeaderPair): boolean {
  const name = header.name.trim().toLowerCase();
  if (name === '' || name.startsWith(':') || name.startsWith('sec-') || name.startsWith('proxy-')) return false;
  if (NOISE_REQUEST_HEADERS.has(name)) return false;
  return !(name === 'accept' && header.value.trim() === '*/*');
}

/** Content type for display: multipart boundaries are random per request and dropped. */
function displayContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const { mime } = parseContentType(contentType);
  return mime.startsWith('multipart/') ? mime : contentType.trim();
}

function headerSpecs(headers: HeaderPair[], redactor: Redactor): HeaderSpec[] {
  const seen = new Set<string>();
  const unique = headers.filter((header) => {
    const name = header.name.trim().toLowerCase();
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  const shown = unique.map((header) =>
    header.name.trim().toLowerCase() === 'content-type'
      ? { name: header.name, value: displayContentType(header.value) ?? header.value }
      : header,
  );
  const redacted = redactor.headers(shown);
  return redacted.map((header, i) => ({
    name: header.name,
    value: exampleValue(header.value, MAX_HEADER_VALUE_CHARS),
    redacted: header.value !== shown[i].value,
  }));
}

function cookieNames(cookie: string | undefined): string[] {
  if (!cookie) return [];
  return cookie
    .split(';')
    .map((part) => part.split('=', 1)[0].trim())
    .filter((name) => name !== '');
}

function looksLikeSessionCookie(name: string): boolean {
  return isSensitiveKey(name) || /sess|auth|token|jwt|sid|login|remember/i.test(name);
}

function authorizationSpec(name: string, value: string): AuthSpec {
  const scheme = value.trim().split(/\s+/, 1)[0] ?? '';
  const credentials = value.trim().slice(scheme.length).trim();
  const lower = scheme.toLowerCase();
  if (lower === 'bearer') {
    const jwt = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(credentials);
    return { scheme: 'bearer', location: name, note: `Bearer token${jwt ? ' (JWT)' : ''} in the ${name} header` };
  }
  if (lower === 'basic') return { scheme: 'basic', location: name, note: `HTTP Basic credentials (base64 "user:password") in the ${name} header` };
  return { scheme: 'other', location: name, note: `${credentials ? `"${scheme}" credentials` : 'Opaque credentials'} in the ${name} header` };
}

function tokenHeaderSpec(name: string): AuthSpec {
  const lower = name.toLowerCase();
  if (lower.includes('csrf') || lower.includes('xsrf')) {
    return { scheme: 'other', location: name, note: `CSRF token in the ${name} header (usually read from a cookie or a <meta> tag)` };
  }
  if (lower.includes('key')) return { scheme: 'api-key', location: name, note: `API key in the ${name} header` };
  return { scheme: 'other', location: name, note: `Token in the ${name} header` };
}

/**
 * How the request authenticates: scheme and location only, never the value. `location` is the header, query
 * parameter or cookie name(s); `note` is a self-contained sentence for the prompt.
 */
function authSpecs(primary: RequestSample, cookieHeader: string | undefined, query: QueryParamSpec[]): AuthSpec[] {
  const specs: AuthSpec[] = [];
  const seen = new Set<string>();
  for (const header of primary.headers) {
    const name = header.name.trim();
    const lower = name.toLowerCase();
    if (seen.has(lower) || header.value.trim() === '') continue;
    seen.add(lower);
    if (lower === 'authorization') specs.push(authorizationSpec(name, header.value));
    else if (lower !== 'cookie' && lower !== 'set-cookie' && !lower.startsWith('proxy-') && isSensitiveHeader(name)) {
      specs.push(tokenHeaderSpec(name));
    }
  }
  for (const param of query) {
    if (!isSensitiveKey(param.name)) continue;
    const isKey = /key/i.test(param.name);
    specs.push({
      scheme: isKey ? 'api-key' : 'other',
      location: param.name,
      note: `${isKey ? 'API key' : 'Credential'} in the "${param.name}" query parameter`,
    });
  }
  const names = cookieNames(cookieHeader);
  const session = [...new Set(names.filter(looksLikeSessionCookie))];
  if (session.length > 0) {
    const others = names.length - session.length;
    const quoted = session.map((name) => `"${name}"`).join(', ');
    specs.push({
      scheme: 'cookie',
      location: session.join(', '),
      note: `Session cookie${session.length > 1 ? 's' : ''} ${quoted} sent by the browser${others > 0 ? ` (+${others} other cookie${others > 1 ? 's' : ''})` : ''}`,
    });
  }
  return specs;
}

function formPairs(model: BodyModel, redactor: Redactor): Array<{ name: string; value: string; kind: 'text' | 'file' }> {
  if (model.type === 'form') {
    return model.rows
      .filter((row: KVRow) => row.enabled && (row.key !== '' || row.value !== ''))
      .map((row) => ({ name: row.key, value: exampleValue(redactor.value(row.key, row.value)), kind: 'text' as const }));
  }
  if (model.type === 'multipart') {
    return model.parts
      .filter((part: MultipartPart) => part.enabled)
      .map((part) =>
        part.kind === 'file'
          ? { name: part.name, value: fileDescription(part), kind: 'file' as const }
          : { name: part.name, value: exampleValue(redactor.value(part.name, part.value)), kind: 'text' as const },
      );
  }
  return [];
}

function fileDescription(part: MultipartPart): string {
  const details = [part.mime || 'application/octet-stream'];
  if (typeof part.size === 'number') details.push(formatBytes(part.size));
  return `${part.fileName || 'file'} (${details.join(', ')})`;
}

/** GraphQL request object: the "query" document redacted like any other text (inline literals). */
function redactGraphqlTree(tree: JNode, redactor: Redactor): JNode {
  const query = childByKey(tree, 'query');
  if (!query || query.type !== 'string' || typeof query.value !== 'string') return tree;
  const document = redactor.graphql(query.value);
  if (document === query.value) return tree;
  return { ...tree, children: (tree.children ?? []).map((child) => (child === query ? { ...child, value: document } : child)) };
}

function jsonSample(model: Extract<BodyModel, { type: 'json' }>, redactor: Redactor): JNode {
  const tree = redactor.tree(model.tree);
  return model.flavor === 'graphql' ? redactGraphqlTree(tree, redactor) : tree;
}

function textExcerpt(text: string, redactor: Redactor): { text: string; clipped: boolean } {
  const { text: excerpt, clipped } = clip(text, MAX_TEXT_CHARS);
  return { text: redactor.text(excerpt), clipped };
}

/** BodySpec for samples whose first element decides the kind; other samples add JSON samples / fields. */
function bodySpec(models: BodyModel[], contentType: string | null, truncated: boolean, redactor: Redactor): BodySpec | null {
  const first = models[0];
  if (!first || first.type === 'none') return null;
  const spec: BodySpec = { contentType: displayContentType(contentType), kind: first.type, samples: [], truncated };
  switch (first.type) {
    case 'json':
      if (first.flavor === 'graphql') spec.kind = 'graphql';
      for (const model of models) if (model.type === 'json') spec.samples.push(jsonSample(model, redactor));
      return spec;
    case 'form':
    case 'multipart': {
      const samples = models.filter((model) => model.type === first.type).map((model) => formPairs(model, redactor));
      spec.fields = accumulate(samples, 1).map((field) => ({
        name: field.name,
        kind: field.kind,
        ...(field.examples[0] !== undefined ? { example: field.examples[0] } : {}),
        repeated: field.repeated,
        required: field.count === samples.length,
      }));
      return spec;
    }
    case 'text': {
      const excerpt = textExcerpt(first.text, redactor);
      spec.text = excerpt.text;
      spec.truncated = truncated || excerpt.clipped;
      return spec;
    }
    case 'binary':
      spec.text = `Binary body (${first.mime || contentType || 'application/octet-stream'}, ${formatBytes(first.size)})`;
      return spec;
    case 'unavailable':
      spec.text = first.reason;
      return spec;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------------------------

const OPERATION = /^(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/;

/** Strip leading GraphQL ignored tokens (whitespace, commas, # comments). */
function skipIgnored(text: string): string {
  return text.replace(/^(?:[\s,﻿]+|#[^\n\r]*)+/, '');
}

const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

function operationOf(document: string, name: string | null): { type: GraphqlSpec['operationType']; name: string | null } {
  if (name && GRAPHQL_NAME.test(name)) {
    const named = new RegExp(`(?:^|[\\s,}])(query|mutation|subscription)\\s+${name}\\b`).exec(document);
    if (named) return { type: named[1] as GraphqlSpec['operationType'], name };
  }
  const start = skipIgnored(document);
  if (start.startsWith('{')) return { type: 'query', name };
  const match = OPERATION.exec(start);
  if (!match) return { type: null, name };
  return { type: match[1] as GraphqlSpec['operationType'], name: name ?? match[2] ?? null };
}

function stringChild(tree: JNode, key: string): string | null {
  const node = childByKey(tree, key);
  return node && node.type === 'string' && typeof node.value === 'string' && node.value !== '' ? node.value : null;
}

function graphqlFromBody(model: BodyModel, notes: string[], redactor: Redactor): GraphqlSpec | null {
  if (model.type !== 'json' || !model.flavor) return null;
  if (model.flavor === 'graphql-batch') {
    notes.push(`GraphQL batch request (${model.tree.children?.length ?? 0} operations): typed as a JSON array.`);
    return null;
  }
  const document = stringChild(model.tree, 'query') ?? '';
  const operation = operationOf(document, stringChild(model.tree, 'operationName'));
  if (document === '') {
    notes.push('Automatic persisted query: only the document hash was sent (extensions.persistedQuery), not the document.');
  }
  return { operationName: operation.name, operationType: document === '' ? null : operation.type, query: redactor.graphql(document) };
}

function graphqlFromQuery(url: string, redactor: Redactor): GraphqlSpec | null {
  const rows = parseQueryString(splitUrl(url).query);
  const document = rows.find((row) => row.key === 'query')?.value ?? '';
  if (!looksLikeGraphql(document)) return null;
  const name = rows.find((row) => row.key === 'operationName')?.value || null;
  const operation = operationOf(document, name);
  return { operationName: operation.name, operationType: operation.type, query: redactor.graphql(document) };
}

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

const INTERESTING_RESPONSE_HEADERS = new Set([
  'content-type',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'location',
  'retry-after',
  'www-authenticate',
  'content-disposition',
  'content-encoding',
  'link',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'set-cookie',
  'deprecation',
  'sunset',
  'api-version',
  'x-api-version',
]);
const INTERESTING_RESPONSE_PREFIXES = ['x-ratelimit', 'ratelimit', 'x-rate-limit', 'x-total', 'x-page', 'x-per-page', 'x-next', 'x-pagination'];

function isInterestingResponseHeader(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return INTERESTING_RESPONSE_HEADERS.has(lower) || INTERESTING_RESPONSE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function responseHeaderSpecs(headers: HeaderPair[], redactor: Redactor): HeaderSpec[] {
  const seen = new Set<string>();
  let cookies = 0;
  const kept = headers.filter((header) => {
    const lower = header.name.trim().toLowerCase();
    if (!isInterestingResponseHeader(lower)) return false;
    if (lower === 'set-cookie') return ++cookies <= MAX_SET_COOKIES;
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
  const redacted = redactor.headers(kept);
  return redacted.map((header, i) => ({
    name: header.name,
    value: exampleValue(header.value, MAX_HEADER_VALUE_CHARS),
    redacted: header.value !== kept[i].value,
  }));
}

/** Captured response headers, plus Set-Cookie lines only the network layer saw. */
function originalResponseHeaders(entry: RequestEntry): HeaderPair[] {
  const headers = Array.isArray(entry.responseHeaders) ? entry.responseHeaders : [];
  const wire = Array.isArray(entry.wire?.responseHeaders) ? entry.wire.responseHeaders : [];
  if (headers.length === 0) return wire;
  const names = new Set(headers.map((header) => header.name.toLowerCase()));
  return [...headers, ...wire.filter((header) => header.name.toLowerCase() === 'set-cookie' && !names.has('set-cookie'))];
}

function originalResponse(entry: RequestEntry): ResponseSample | null {
  if (entry.state !== 'done' || typeof entry.status !== 'number' || entry.status <= 0) return null;
  const headers = originalResponseHeaders(entry);
  return {
    status: entry.status,
    ...(entry.statusText ? { statusText: entry.statusText } : {}),
    headers,
    contentType: getHeader(headers, 'content-type') ?? null,
    body: entry.source === 'hook' || entry.responseBody !== undefined ? (entry.responseBody ?? null) : undefined,
    source: 'original',
  };
}

function runResponse(run: TestRun): ResponseSample {
  const result = run.result as NonNullable<TestRun['result']>;
  return {
    status: result.status,
    ...(result.statusText ? { statusText: result.statusText } : {}),
    headers: result.headers,
    contentType: getHeader(result.headers, 'content-type') ?? null,
    body: result.body,
    source: 'run',
  };
}

function notCapturedBody(contentType: string | null, entry: RequestEntry): BodySpec {
  return {
    contentType: displayContentType(contentType),
    kind: 'unavailable',
    samples: [],
    text: `${entry.kind} request seen by the network layer only`,
    truncated: false,
  };
}

const MODEL_RANK: Record<BodyModel['type'], number> = {
  json: 0,
  form: 1,
  multipart: 1,
  text: 1,
  binary: 1,
  none: 2,
  unavailable: 3,
};

function responseSpec(group: ResponseSample[], entry: RequestEntry, redactor: Redactor, notes: string[]): ResponseSpec {
  const first = group[0];
  const statusText = group.find((sample) => sample.statusText)?.statusText;
  const sources = [...new Set(group.map((sample) => sample.source))];
  const captured = group.filter((sample) => sample.body !== undefined).slice(0, MAX_SAMPLES_PER_STATUS);
  let body: BodySpec | null;
  if (captured.length === 0) {
    body = notCapturedBody(first.contentType, entry);
  } else {
    // The most informative sample decides the kind: a JSON run beats a captured body that was not readable.
    const models = captured
      .map((sample) => modelOf(sample.body, sample.contentType))
      .map((model, order) => ({ model, order }))
      .sort((a, b) => MODEL_RANK[a.model.type] - MODEL_RANK[b.model.type] || a.order - b.order)
      .map(({ model }) => model);
    const truncated = captured.some((sample) => isTruncated(sample.body));
    const tooLarge = captured.some((sample) => isTooLarge(sample.body));
    body = bodySpec(models, captured[0].contentType, truncated || tooLarge, redactor);
    if (truncated) notes.push(`A ${first.status} response body was truncated at capture: its example is incomplete.`);
    if (tooLarge) notes.push(`A ${first.status} response body is larger than 5 MB: it was not analyzed.`);
    else if (models[0].type === 'text' && /json/i.test(captured[0].contentType ?? '')) {
      notes.push(`The ${first.status} response is declared JSON but could not be parsed${truncated ? ' (truncated)' : ''}: shown as text.`);
    }
  }
  const headerSource = group.find((sample) => sample.headers.length > 0)?.headers ?? [];
  return {
    status: first.status,
    ...(statusText ? { statusText } : {}),
    body,
    sources,
    headers: responseHeaderSpecs(headerSource, redactor),
  };
}

function responseSpecs(samples: ResponseSample[], entry: RequestEntry, redactor: Redactor, notes: string[]): ResponseSpec[] {
  const groups = new Map<number, ResponseSample[]>();
  for (const sample of samples) {
    const group = groups.get(sample.status);
    if (group) group.push(sample);
    else groups.set(sample.status, [sample]);
  }
  return [...groups.keys()].sort((a, b) => a - b).map((status) => responseSpec(groups.get(status) as ResponseSample[], entry, redactor, notes));
}

// ---------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------

const CREDENTIALS_MODES = new Set(['include', 'same-origin', 'omit']);

/** Credentials the page used: fetch `credentials`, XHR `withCredentials`, else the defaults of the capture kind. */
function credentialsOf(entry: RequestEntry): string | undefined {
  const options = entry.requestOptions;
  if (typeof options?.credentials === 'string' && CREDENTIALS_MODES.has(options.credentials)) return options.credentials;
  if (options?.withCredentials === true) return 'include';
  if (entry.source === 'manual') return undefined;
  if (entry.source === 'hook' && entry.kind !== 'beacon') return 'same-origin';
  return 'include';
}

function requestNotes(entry: RequestEntry, primary: RequestSample, usesDraft: boolean, redactor: Redactor): string[] {
  const notes: string[] = [];
  if (usesDraft) notes.push('The edited draft is the request sample (it differs from the captured request).');
  if (entry.state === 'error' || entry.state === 'aborted') {
    notes.push(`The captured request ${entry.state === 'aborted' ? 'was aborted' : 'failed'}${entry.error ? `: ${clip(entry.error, 200).text}` : ''}.`);
  } else if (entry.state === 'pending') {
    notes.push('The captured request was still pending when this was generated.');
  }
  if (entry.restored) notes.push('Restored from a preserved log: Cookie / Authorization values were not kept.');
  if (entry.redirected && entry.responseUrl) notes.push(`The request was redirected to ${clip(redactor.url(entry.responseUrl), MAX_URL_CHARS).text}.`);
  if (entry.fromCache) notes.push('The captured response came from the browser cache.');
  if (entry.kind === 'document' || entry.kind === 'subdocument') {
    notes.push(`Captured as a ${entry.kind === 'document' ? 'page navigation' : 'frame navigation'} (document request), not a fetch/XHR call.`);
  }
  if (primary.truncated) notes.push('The request body was truncated at capture: its example is incomplete.');
  if (primary.tooLarge) notes.push('The request body is larger than 5 MB: it was not analyzed.');
  if (primary.body.type === 'unavailable') notes.push(`The request body was not captured (${primary.body.reason}).`);
  if (BODYLESS_METHODS.has(primary.method) && primary.body.type !== 'none' && primary.body.type !== 'unavailable') {
    notes.push(`A ${primary.method} request cannot carry a body: the captured body is ignored.`);
  }
  return notes;
}

/** Build the spec. Never throws: unparsable bodies become text samples with a note.
 *
 * Samples: the primary request sample is the edited draft when modified, else the captured request. Requests of
 * 2xx test runs (and the captured request, when the draft is primary and it succeeded) to the same method + path
 * template add request samples, so optional fields and params can be detected. Response samples: the captured
 * response (when the primary sample targets the captured method + path) plus every finished run to the same
 * endpoint, grouped by status (≤ 5 bodies per status). JSON bodies are the raw request/response trees — for
 * GraphQL the whole `{query, variables, operationName}` object and the whole `{data, errors}` response.
 * Bodies over 5 MB are not parsed. Redaction (unless `redact: false`) covers the URL, headers, JSON trees,
 * form/multipart fields, text bodies and GraphQL documents; with `redact: false` a note warns when secrets
 * are included. */
export function buildEndpointSpec(input: EndpointInput): EndpointSpec {
  try {
    return buildSpec(input);
  } catch (error) {
    return fallbackSpec(input, error);
  }
}

function buildSpec(input: EndpointInput): EndpointSpec {
  const { entry } = input;
  const redactor = new Redactor(input.redact !== false);
  const captured = entrySample(entry);
  const edited = input.draft && safeIsModified(input.draft) ? safeDraftSample(input.draft) : null;
  const usesDraft = edited !== null;
  const primary = edited ?? captured;
  const primaryKey = endpointKey(primary.method, primary.url);
  const capturedSameEndpoint = endpointKey(captured.method, captured.url) === primaryKey;
  const runs = finishedRuns(input.runs).filter((run) => endpointKey(normalizeMethod(run.request.method), run.request.url) === primaryKey);

  const extraRequests: RequestSample[] = [];
  if (usesDraft && capturedSameEndpoint && isSuccess(entry.status)) extraRequests.push(captured);
  for (const run of runs) if (isSuccess(run.result?.status)) extraRequests.push(runSample(run));
  const requestSamples = [primary, ...extraRequests].slice(0, MAX_REQUEST_SAMPLES);

  const notes = requestNotes(entry, primary, usesDraft, redactor);
  const location = locate(primary.url);
  const http = isHttp(location);
  const path = http ? detectPathParams(location.pathname) : { template: `${location.scheme || 'url'}:`, params: [] };
  if (!http) notes.push('Not an HTTP(S) URL: there is no endpoint path to implement.');

  const query = querySpecs(requestSamples, redactor);
  const bodyless = BODYLESS_METHODS.has(primary.method);
  const bodySamples = bodyless ? [] : requestSamples.filter((sample) => sample.body.type === primary.body.type);
  const requestBody = bodyless
    ? null
    : bodySpec(bodySamples.map((sample) => sample.body), primary.contentType, primary.truncated || primary.tooLarge === true, redactor);
  const graphql = bodyless ? graphqlFromQuery(primary.url, redactor) : graphqlFromBody(primary.body, notes, redactor);

  const responseSamples: ResponseSample[] = [];
  const original = capturedSameEndpoint ? originalResponse(entry) : null;
  if (original) responseSamples.push(original);
  for (const run of runs) responseSamples.push(runResponse(run));
  const responses = responseSpecs(responseSamples, entry, redactor, notes);
  if (original && original.body === undefined && runs.length === 0) {
    notes.push('Response bodies are not available for requests seen only by the network layer: send a test request from kineReqLens to capture one.');
  }

  const cookieHeader = getHeader(entry.wire?.requestHeaders ?? [], 'cookie') ?? getHeader(captured.headers, 'cookie');
  const auth = authSpecs(primary, cookieHeader, query);
  const requestHeaders = headerSpecs(primary.headers.filter(isRelevantRequestHeader), redactor);
  const url = clip(redactor.url(primary.url), MAX_URL_CHARS);
  const templateSegments = path.template.split('/').map((segment) =>
    segment.startsWith('{') || !looksLikeSecretValue(decodeSegment(segment)) ? segment : redactor.value('', segment),
  );
  const pathParams = path.params.map((param) => ({ ...param, example: exampleValue(redactor.value('', param.example)) }));
  if (!redactor.enabled && redactor.sensitiveSeen) {
    notes.push('Secret values are included unredacted ("Share secrets with Claude" is on): never commit, log or echo them.');
  }

  const spec: EndpointSpec = {
    method: primary.method,
    url: url.clipped ? `${url.text}…` : url.text,
    origin: location.origin,
    pathTemplate: templateSegments.join('/'),
    pathParams,
    query,
    requestHeaders,
    auth,
    requestBody,
    responses,
    graphql,
    pageOrigin: originOf(entry.frameUrl || entry.pageUrl),
    capturedAt: entry.startTime,
    notes,
    redacted: redactor.redacted,
  };
  const credentials = credentialsOf(entry);
  if (credentials) spec.credentials = credentials;
  return spec;
}

function safeIsModified(draft: Draft): boolean {
  try {
    return isDraftModified(draft);
  } catch {
    return false;
  }
}

function safeDraftSample(draft: Draft): RequestSample | null {
  try {
    return draftSample(draft);
  } catch {
    return null;
  }
}

/** Minimal spec for input the builder cannot analyze (malformed entries from an older or foreign source). */
function fallbackSpec(input: EndpointInput, error: unknown): EndpointSpec {
  const entry = (input?.entry ?? {}) as Partial<RequestEntry>;
  const rawUrl = typeof entry.url === 'string' ? entry.url : '';
  const url = input?.redact === false ? rawUrl : redactUrl(rawUrl).url;
  const location = locate(rawUrl);
  const message = error instanceof Error ? error.message : String(error);
  return {
    method: normalizeMethod(typeof entry.method === 'string' ? entry.method : 'GET'),
    url: clip(url, MAX_URL_CHARS).text,
    origin: location.origin,
    pathTemplate: isHttp(location) ? detectPathParams(location.pathname).template : '/',
    pathParams: [],
    query: [],
    requestHeaders: [],
    auth: [],
    requestBody: null,
    responses: [],
    graphql: null,
    pageOrigin: originOf(typeof entry.pageUrl === 'string' ? entry.pageUrl : ''),
    capturedAt: typeof entry.startTime === 'number' ? entry.startTime : 0,
    notes: [`kineReqLens could not analyze this request (${clip(message, 200).text}).`],
    redacted: input?.redact !== false && url !== rawUrl,
  };
}
