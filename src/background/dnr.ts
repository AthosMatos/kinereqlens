// declarativeNetRequest support for extension-mode replays: browser-controlled ("forbidden") request
// headers such as Cookie, Origin or Referer cannot be set through fetch, so they are applied with a
// temporary session rule scoped to exactly one replay (initiator = this extension, exact URL, method,
// no tab) that is removed as soon as the response headers arrive.
import { isForbiddenRequestHeader, isUnsafeToOverride } from '../lib/headers';
import { LANGUAGE_RULE_ID_BASE } from '../shared/constants';
import type { HeaderPair } from '../shared/types';
import { Mutex, abortReason, errorMessage } from './util';

type Dnr = typeof chrome.declarativeNetRequest;
type DnrRule = chrome.declarativeNetRequest.Rule;
type DnrMethod = `${chrome.declarativeNetRequest.RequestMethod}`;
type ModifyHeaderInfo = chrome.declarativeNetRequest.ModifyHeaderInfo;

/** chrome.tabs.TAB_ID_NONE (inlined so the pure builders do not need the chrome global). */
export const TAB_ID_NONE = -1;

/** Methods fetch upper-cases (and therefore sends in a form DNR recognizes) regardless of input case. */
const NORMALIZED_METHODS = new Set(['delete', 'get', 'head', 'options', 'post', 'put']);

/**
 * DNR requestMethods value for the method fetch will actually send, or null when the rule must not
 * restrict the method (non-standard methods, or a lower-case "patch" that fetch sends verbatim).
 */
export function toDnrMethod(method: string): DnrMethod | null {
  const lower = method.toLowerCase();
  if (NORMALIZED_METHODS.has(lower)) return lower as DnrMethod;
  if (method === 'PATCH') return 'patch';
  return null;
}

/** Escape every RE2 metacharacter so `text` matches literally. */
export function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/** Anchored RE2 pattern matching exactly `url`. */
export function exactUrlRegex(url: string): string {
  return `^${escapeRegex(url)}$`;
}

/**
 * Anchored urlFilter for `url` (fallback when the regex is rejected, e.g. too long for RE2's memory cap).
 * `*` and `^` still match themselves; a literal `|` is only an anchor at the ends, so inner ones become
 * `*` (looser by one character, never stricter).
 */
export function exactUrlFilter(url: string): string {
  return `|${url.replace(/\|/g, '*')}|`;
}

export interface SplitHeaders {
  /** Headers fetch can send itself. */
  fetchHeaders: HeaderPair[];
  /** Browser-controlled headers that must go through a DNR rule. */
  dnrHeaders: HeaderPair[];
  /** Header names that cannot be sent at all (would corrupt HTTP framing). */
  dropped: string[];
}

/** Partition replay headers by how extension mode can send them. */
export function splitReplayHeaders(headers: HeaderPair[]): SplitHeaders {
  const out: SplitHeaders = { fetchHeaders: [], dnrHeaders: [], dropped: [] };
  for (const header of headers) {
    if (isUnsafeToOverride(header.name)) out.dropped.push(header.name);
    else if (isForbiddenRequestHeader(header.name)) out.dnrHeaders.push(header);
    else out.fetchHeaders.push(header);
  }
  return out;
}

/**
 * `set` operations for the DNR rule: duplicates of one header are combined (Cookie with "; ", others
 * with ", ") because a rule may set each header only once; an empty value removes the header instead
 * (the user asked for it to be sent empty, which DNR cannot express for every header).
 */
export function buildModifyHeaders(headers: HeaderPair[]): ModifyHeaderInfo[] {
  const grouped = new Map<string, { header: string; values: string[] }>();
  for (const { name, value } of headers) {
    const key = name.toLowerCase();
    const group = grouped.get(key);
    if (group) group.values.push(value);
    else grouped.set(key, { header: name, values: [value] });
  }
  const infos: ModifyHeaderInfo[] = [];
  for (const [key, { header, values }] of grouped) {
    const nonEmpty = values.map((v) => v.trim()).filter((v) => v !== '');
    if (nonEmpty.length === 0) infos.push({ header, operation: 'remove' });
    else infos.push({ header, operation: 'set', value: nonEmpty.join(key === 'cookie' ? '; ' : ', ') });
  }
  return infos;
}

export interface ReplayRuleSpec {
  id: number;
  /** Absolute request URL without fragment, exactly as passed to fetch. */
  url: string;
  method: string;
  /** Headers to apply (already filtered to DNR-able ones). */
  headers: HeaderPair[];
  /** chrome.runtime.id */
  extensionId: string;
  /** Use regexFilter (true) or the urlFilter fallback (false). */
  useRegex: boolean;
}

/** Session rule that applies `headers` to exactly one request this extension sends from its worker. */
export function buildReplayRule(spec: ReplayRuleSpec): DnrRule {
  const condition: chrome.declarativeNetRequest.RuleCondition = {
    initiatorDomains: [spec.extensionId],
    resourceTypes: ['xmlhttprequest', 'other'],
    tabIds: [TAB_ID_NONE],
    isUrlFilterCaseSensitive: false,
  };
  if (spec.useRegex) condition.regexFilter = exactUrlRegex(spec.url);
  else condition.urlFilter = exactUrlFilter(spec.url);
  const method = toDnrMethod(spec.method);
  if (method) condition.requestMethods = [method];
  return {
    id: spec.id,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: buildModifyHeaders(spec.headers) },
    condition,
  };
}

/**
 * Key under which replays can see each other's rules. Rules match case-insensitively and regardless of
 * method for non-standard methods, so the lower-cased URL is a conservative key.
 */
export function ruleConflictKey(url: string): string {
  return url.toLowerCase();
}

/** Owns this extension's DNR session rules: startup cleanup, unique ids, serialized replays. */
export class DnrManager {
  private readonly mutex = new Mutex();
  private nextId = 1;
  private cleared: Promise<void> | null = null;
  /** Conflict keys of DNR replays that are queued or running, with their count. */
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly extensionId: string,
    private readonly dnr: Dnr = chrome.declarativeNetRequest,
  ) {}

  /**
   * Remove every replay session rule (left over from a worker that died mid-replay). Idempotent per worker run.
   * The "Site language" rules (ids from LANGUAGE_RULE_ID_BASE, src/background/language.ts) are owned and
   * rewritten by the language manager, so they are kept.
   */
  clearAll(): Promise<void> {
    this.cleared ??= (async () => {
      try {
        const rules = (await this.dnr.getSessionRules()).filter((r) => r.id < LANGUAGE_RULE_ID_BASE);
        if (rules.length > 0) await this.dnr.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
      } catch (err) {
        console.warn('[kineReqLens] could not clear session rules', err);
      }
    })();
    return this.cleared;
  }

  /**
   * Run `send` while a rule applying `headers` to (`method`, `url`) is installed. DNR-using replays are
   * serialized so two concurrent replays of the same URL cannot pick up each other's headers. The rule is
   * removed in `finally`. When the rule cannot be installed, `send` still runs and the header names are
   * reported as not applied.
   */
  async withHeaders<T>(
    req: { url: string; method: string; headers: HeaderPair[] },
    signal: AbortSignal,
    send: () => Promise<T>,
  ): Promise<{ value: T; applied: string[]; failed: string[]; error?: string }> {
    // Registered synchronously so a plain replay of the same URL issued right after this one waits for it.
    const key = ruleConflictKey(req.url);
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    try {
      await this.clearAll();
      const release = await this.mutex.acquire(signal);
      try {
        return await this.sendWithRule(req, signal, send);
      } finally {
        release();
      }
    } finally {
      const count = (this.pending.get(key) ?? 1) - 1;
      if (count > 0) this.pending.set(key, count);
      else this.pending.delete(key);
    }
  }

  /**
   * Run `send` for a replay that needs no rule. When a DNR replay of the same URL is queued or running,
   * its rule could also rewrite this request's headers, so `send` then waits for the lock and holds it
   * until the response headers arrived. (The converse — a rule installed while a plain replay of the same
   * URL has not yet reached the header stage — is a window of a few milliseconds and is not guarded.)
   */
  async withoutHeaders<T>(url: string, signal: AbortSignal, send: () => Promise<T>): Promise<T> {
    if (!this.pending.has(ruleConflictKey(url))) return send();
    const release = await this.mutex.acquire(signal);
    try {
      if (signal.aborted) throw abortReason(signal);
      return await send();
    } finally {
      release();
    }
  }

  /** Install the rule, send, and always remove the rule again. Caller holds the mutex. */
  private async sendWithRule<T>(
    req: { url: string; method: string; headers: HeaderPair[] },
    signal: AbortSignal,
    send: () => Promise<T>,
  ): Promise<{ value: T; applied: string[]; failed: string[]; error?: string }> {
    if (signal.aborted) throw abortReason(signal);
    const id = this.nextId++;
    // Stay below the language rules' id range (a million replays in one worker run is not a real case).
    if (this.nextId >= LANGUAGE_RULE_ID_BASE) this.nextId = 1;
    let installed = false;
    let error: string | undefined;
    try {
      try {
        await this.install(id, req);
        installed = true;
      } catch (err) {
        error = errorMessage(err);
        console.warn('[kineReqLens] DNR rule rejected; sending without browser-controlled headers', err);
      }
      const value = await send();
      const names = uniqueNames(req.headers);
      return installed ? { value, applied: names, failed: [] } : { value, applied: [], failed: names, error };
    } finally {
      if (installed) {
        try {
          await this.dnr.updateSessionRules({ removeRuleIds: [id] });
        } catch (err) {
          console.warn('[kineReqLens] could not remove session rule', id, err);
        }
      }
    }
  }

  private async install(id: number, req: { url: string; method: string; headers: HeaderPair[] }): Promise<void> {
    const base = { id, url: req.url, method: req.method, headers: req.headers, extensionId: this.extensionId };
    const useRegex = await this.regexSupported(exactUrlRegex(req.url));
    if (useRegex) {
      try {
        await this.dnr.updateSessionRules({ removeRuleIds: [id], addRules: [buildReplayRule({ ...base, useRegex })] });
        return;
      } catch {
        // Fall through to the urlFilter form (e.g. regex rule quota or engine limits).
      }
    }
    await this.dnr.updateSessionRules({ removeRuleIds: [id], addRules: [buildReplayRule({ ...base, useRegex: false })] });
  }

  private async regexSupported(regex: string): Promise<boolean> {
    if (typeof this.dnr.isRegexSupported !== 'function') return true;
    try {
      const result = await this.dnr.isRegexSupported({ regex, isCaseSensitive: false, requireCapturing: false });
      return result.isSupported;
    } catch {
      return false;
    }
  }
}

function uniqueNames(headers: HeaderPair[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const { name } of headers) {
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}
