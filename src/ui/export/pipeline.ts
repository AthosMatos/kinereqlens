// OWNER: ui-export agent. The Export tab's view of the lib pipeline (buildEndpointSpec -> generateEndpointTypes ->
// buildAgentPrompt): memoized per input identity, never throws (failures become `{ ok: false }` outcomes), plus
// the small pure helpers the views need (roles present, role filtering, base-name sanitizing, notes).
import type { PromptTarget, TypeFormat } from '../../shared/claude-protocol';
import type { Draft, RequestEntry, SerializedBody, TestRun } from '../../shared/types';
import { buildAgentPrompt, endpointTitle } from '../../lib/agentPrompt';
import type { EndpointSpec } from '../../lib/endpoint';
import { buildEndpointSpec, suggestBaseName } from '../../lib/endpoint';
import type { GeneratedTypes } from '../../lib/typegen';
import { generateEndpointTypes } from '../../lib/typegen';

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** Parts of an endpoint the Types view can include (GeneratedTypes.names keys of the non-GraphQL roles). */
export type TypeRole = 'pathParams' | 'query' | 'requestBody' | 'response' | 'errorResponse';
export const TYPE_ROLES: readonly TypeRole[] = ['pathParams', 'query', 'requestBody', 'response', 'errorResponse'];

export const FORMAT_LABELS: Record<TypeFormat, string> = {
  typescript: 'TypeScript',
  zod: 'Zod',
  'json-schema': 'JSON Schema',
};

export const TARGET_LABELS: Record<PromptTarget, string> = {
  client: 'Client',
  server: 'Server',
  tests: 'Tests',
  explain: 'Explain',
};

/** Fallback when suggestBaseName is unavailable or returns nothing usable. */
export const FALLBACK_BASE_NAME = 'Endpoint';

/** Inputs heavier than this (characters of bodies) are regenerated after a short debounce instead of per change. */
export const DEFER_WEIGHT = 64 * 1024;

export const ONE_SAMPLE_NOTE = "Only one response sample — optional fields can't be detected; send more test requests to refine.";

function message(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === 'string' ? err : 'unexpected error';
}

function attempt<T>(fn: () => T): Outcome<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (__DEV__) console.warn('[reqlens] export generation failed', err);
    return { ok: false, error: message(err) };
  }
}

// --------------------------------------------------------------------------------------------- spec

interface SpecSlot {
  draft: Draft | null;
  runs: readonly TestRun[];
  redact: boolean;
  outcome: Outcome<EndpointSpec>;
}

/** One slot per entry object: the latest (draft, runs, redact) combination it was built with. */
const specSlots = new WeakMap<RequestEntry, SpecSlot>();

/** The cached spec outcome for exactly these inputs, if any (no work). */
export function peekSpec(entry: RequestEntry, draft: Draft | null, runs: readonly TestRun[], redact: boolean): Outcome<EndpointSpec> | undefined {
  const slot = specSlots.get(entry);
  return slot && slot.draft === draft && slot.runs === runs && slot.redact === redact ? slot.outcome : undefined;
}

/** EndpointSpec of an entry with its draft and runs (memoized by identity of every input). */
export function specOutcome(entry: RequestEntry, draft: Draft | null, runs: readonly TestRun[], redact: boolean): Outcome<EndpointSpec> {
  const cached = peekSpec(entry, draft, runs, redact);
  if (cached) return cached;
  const outcome = attempt(() => buildEndpointSpec({ entry, draft, runs: runs.slice(), redact }));
  specSlots.set(entry, { draft, runs, redact, outcome });
  return outcome;
}

// --------------------------------------------------------------------------------------------- types

export interface TypesOptions {
  format: TypeFormat;
  baseName: string;
  annotate: boolean;
  /** Roles left out of the output. */
  exclude: ReadonlySet<TypeRole>;
}

const PER_SPEC_CACHE_MAX = 16;
const typeCache = new WeakMap<EndpointSpec, Map<string, Outcome<GeneratedTypes>>>();
const promptCache = new WeakMap<EndpointSpec, Map<string, Outcome<string>>>();

function remember<V>(cache: WeakMap<EndpointSpec, Map<string, V>>, spec: EndpointSpec, key: string, make: () => V): V {
  let map = cache.get(spec);
  if (!map) {
    map = new Map();
    cache.set(spec, map);
  }
  const hit = map.get(key);
  if (hit !== undefined) return hit;
  const value = make();
  if (map.size >= PER_SPEC_CACHE_MAX) map.delete(map.keys().next().value as string);
  map.set(key, value);
  return value;
}

const is2xx = (status: number): boolean => status >= 200 && status < 300;
const isError = (status: number): boolean => status >= 400;

/** The spec without the excluded roles (so the generator simply does not see them). */
export function withoutRoles(spec: EndpointSpec, exclude: ReadonlySet<TypeRole>): EndpointSpec {
  if (exclude.size === 0) return spec;
  const responses = spec.responses.filter(
    (r) => !(exclude.has('response') && is2xx(r.status)) && !(exclude.has('errorResponse') && isError(r.status)),
  );
  return {
    ...spec,
    pathParams: exclude.has('pathParams') ? [] : spec.pathParams,
    query: exclude.has('query') ? [] : spec.query,
    requestBody: exclude.has('requestBody') ? null : spec.requestBody,
    responses,
  };
}

/** Generated types for the spec (memoized per spec and options). */
export function typesOutcome(spec: EndpointSpec, opts: TypesOptions): Outcome<GeneratedTypes> {
  const excluded = TYPE_ROLES.filter((r) => opts.exclude.has(r));
  const key = `${opts.format}\u0000${opts.baseName}\u0000${opts.annotate ? 1 : 0}\u0000${excluded.join(',')}`;
  return remember(typeCache, spec, key, () =>
    attempt(() =>
      generateEndpointTypes(withoutRoles(spec, new Set(excluded)), {
        format: opts.format,
        baseName: opts.baseName,
        annotate: opts.annotate,
      }),
    ),
  );
}

export interface PromptOptions {
  target: PromptTarget;
  baseName: string;
  includeExamples: boolean;
}

/** Agent prompt for the spec (TypeScript types with every role; memoized per spec and options). */
export function promptOutcome(spec: EndpointSpec, opts: PromptOptions): Outcome<string> {
  const key = `${opts.target}\u0000${opts.baseName}\u0000${opts.includeExamples ? 1 : 0}`;
  return remember(promptCache, spec, key, () => {
    const types = typesOutcome(spec, { format: 'typescript', baseName: opts.baseName, annotate: true, exclude: new Set() });
    if (!types.ok) return { ok: false, error: `types: ${types.error}` };
    return attempt(() =>
      buildAgentPrompt(spec, {
        target: opts.target,
        typesTs: types.value.code,
        typeNames: types.value.names,
        includeExamples: opts.includeExamples,
        typeNotes: types.value.notes,
      }),
    );
  });
}

// --------------------------------------------------------------------------------------------- helpers

/** suggestBaseName, never throwing. */
export function suggestedName(spec: EndpointSpec): string {
  try {
    return sanitizeTypeName(suggestBaseName(spec)) || FALLBACK_BASE_NAME;
  } catch {
    return FALLBACK_BASE_NAME;
  }
}

/** "POST /api/orders" (endpointTitle, never throwing). */
export function titleOf(spec: EndpointSpec): string {
  try {
    return endpointTitle(spec);
  } catch {
    return `${spec.method} ${spec.pathTemplate}`;
  }
}

/**
 * A typed base name made safe as a type identifier: characters other than letters, digits, `_` and `$` are
 * dropped and the first letter is upper-cased; a leading digit gets a `_` prefix. '' when nothing is left.
 */
export function sanitizeTypeName(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9_$]/g, '');
  if (!cleaned) return '';
  const head = cleaned[0]!;
  if (head >= '0' && head <= '9') return `_${cleaned}`;
  return head.toUpperCase() + cleaned.slice(1);
}

function hasJsonSamples(body: EndpointSpec['requestBody']): boolean {
  return !!body && body.samples.length > 0;
}

/** Roles that would produce a declaration for this spec, in display order. */
export function rolesPresent(spec: EndpointSpec): TypeRole[] {
  const present: TypeRole[] = [];
  if (spec.pathParams.length > 0) present.push('pathParams');
  if (spec.query.length > 0) present.push('query');
  const body = spec.requestBody;
  if (body && (hasJsonSamples(body) || (body.fields?.length ?? 0) > 0)) present.push('requestBody');
  if (spec.responses.some((r) => is2xx(r.status) && hasJsonSamples(r.body))) present.push('response');
  if (spec.responses.some((r) => isError(r.status) && hasJsonSamples(r.body))) present.push('errorResponse');
  return present;
}

/** Checkbox label of a role (GraphQL endpoints call the body and the response Variables / Data). */
export function roleLabel(role: TypeRole, graphql: boolean): string {
  switch (role) {
    case 'pathParams':
      return 'Path params';
    case 'query':
      return 'Query';
    case 'requestBody':
      return graphql ? 'Variables' : 'Request body';
    case 'response':
      return graphql ? 'Data' : 'Response';
    case 'errorResponse':
      return 'Error response';
  }
}

/** Number of JSON samples behind the success response type. */
export function successSampleCount(spec: EndpointSpec): number {
  let n = 0;
  for (const r of spec.responses) if (is2xx(r.status)) n += r.body?.samples.length ?? 0;
  return n;
}

export type ResponseHint =
  | { kind: 'none' }
  /** No response body to learn from (not captured / still pending): a test run would provide one. */
  | { kind: 'send'; pending: boolean }
  /** The response is not JSON: there is no response type to infer. */
  | { kind: 'not-json'; contentType: string | null }
  /** Every observed response is empty (204, 304, no body). */
  | { kind: 'empty' };

const EMPTY_STATUSES = new Set([204, 205, 304]);

/** What the Types view says about the response type when there is none. */
export function responseHint(spec: EndpointSpec, entry: Pick<RequestEntry, 'state'>): ResponseHint {
  if (spec.responses.some((r) => hasJsonSamples(r.body))) return { kind: 'none' };
  if (spec.responses.length > 0 && spec.responses.every((r) => EMPTY_STATUSES.has(r.status) || r.body?.kind === 'none')) {
    return { kind: 'empty' };
  }
  const withBody = spec.responses.find((r) => r.body && r.body.kind !== 'none' && r.body.kind !== 'unavailable');
  if (withBody?.body) return { kind: 'not-json', contentType: withBody.body.contentType };
  return { kind: 'send', pending: entry.state === 'pending' };
}

/** Notes under the code: spec caveats, generator notes, the single-sample hint; deduplicated, in order. */
export function compileNotes(spec: EndpointSpec, types: GeneratedTypes | null, exclude: ReadonlySet<TypeRole>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (note: string) => {
    const text = note.trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  };
  for (const n of spec.notes) add(n);
  if (types) for (const n of types.notes) add(n);
  const mentionsSamples = out.some((n) => /\bone (response )?sample\b/i.test(n));
  if (!mentionsSamples && !exclude.has('response') && successSampleCount(spec) === 1) add(ONE_SAMPLE_NOTE);
  return out;
}

/** Characters of a captured body (a cheap size proxy; form data counts its text values). */
export function bodyWeight(body: SerializedBody | null | undefined): number {
  if (!body) return 0;
  switch (body.kind) {
    case 'text':
      return body.text.length;
    case 'base64':
      return body.base64.length;
    case 'formFields':
      return body.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    case 'formData':
      return body.entries.reduce((n, e) => n + e.name.length + (e.type === 'text' ? e.value.length : 64), 0);
    case 'unavailable':
      return 0;
  }
}

/** Size of everything the spec parses for an entry (request + response + run responses). */
export function exportWeight(entry: Pick<RequestEntry, 'requestBody' | 'responseBody'>, runs: readonly TestRun[]): number {
  let n = bodyWeight(entry.requestBody) + bodyWeight(entry.responseBody);
  for (const run of runs) n += bodyWeight(run.result?.body);
  return n;
}

/** Rough LLM token count of a prompt (~4 characters per token), e.g. "~1.2k tokens". */
export function tokenEstimate(text: string): string {
  const tokens = Math.ceil(text.length / 4);
  if (tokens < 1000) return `~${tokens} tokens`;
  return `~${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k tokens`;
}

/** Lines of a text ('' has one empty line). */
export function lineCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n;
}
