// Strict validation of the control plane's calls (bridge method `control`, src/shared/control-protocol.ts). Anything
// Claude sends is untrusted: unknown tools, actions and argument names are rejected, strings and arrays are bounded,
// numbers must be finite integers in range. Messages are shown to Claude, so they say what to fix.
import { CONTROL_ACTIONS, isControlAction, isControlTool } from '../../../shared/control-protocol';
import type { ControlTool } from '../../../shared/control-protocol';
import { SHOT_PADDING_MAX } from '../../../shared/screenshot-protocol';
import { isRecord } from '../../util';
import { ParamError } from '../validate';

/** A validated call: the tool, its action and its normalized arguments. */
export interface ValidControl {
  tool: ControlTool;
  action: string;
  tabId?: number;
  activate?: boolean;
  args: Record<string, unknown>;
}

type Check = (value: unknown, name: string) => unknown;

interface Field {
  check: Check;
  required?: boolean;
}

type Schema = Record<string, Field>;

function fail(message: string): never {
  throw new ParamError(message);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;
const METHOD_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;

/** Max chars of text arguments that carry bodies / messages (host → extension messages are capped at 1 MB). */
export const MAX_TEXT_ARG = 512 * 1024;
export const MAX_IDS = 500;

// ------------------------------------------------------------------------------------------- checks

const bool: Check = (v, name) => (typeof v === 'boolean' ? v : fail(`${name} must be true or false`));

function str(max: number, opts: { min?: number; multiline?: boolean; trim?: boolean } = {}): Check {
  return (v, name) => {
    if (typeof v !== 'string') fail(`${name} must be a string`);
    const s = opts.trim ? v.trim() : v;
    if (s.length < (opts.min ?? 0)) fail(`${name} must not be empty`);
    if (s.length > max) fail(`${name} is too long (max ${max} characters)`);
    if ((opts.multiline ? CONTROL_CHARS : ANY_CONTROL).test(s)) fail(`${name} contains control characters`);
    return s;
  };
}

function int(min: number, max: number): Check {
  return (v, name) => {
    if (typeof v !== 'number' || !Number.isInteger(v)) fail(`${name} must be an integer`);
    if (v < min || v > max) fail(`${name} must be between ${min} and ${max}`);
    return v;
  };
}

function num(min: number, max: number): Check {
  return (v, name) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${name} must be a number`);
    if (v < min || v > max) fail(`${name} must be between ${min} and ${max}`);
    return v;
  };
}

function oneOf(...values: string[]): Check {
  return (v, name) => (typeof v === 'string' && values.includes(v) ? v : fail(`${name} must be one of: ${values.join(', ')}`));
}

function list(item: Check, max: number): Check {
  return (v, name) => {
    if (!Array.isArray(v)) fail(`${name} must be an array`);
    if (v.length > max) fail(`${name} has too many items (max ${max})`);
    return v.map((x, i) => item(x, `${name}[${i}]`));
  };
}

function object(schema: Schema, opts: { atLeastOne?: boolean } = {}): Check {
  return (v, name) => {
    if (!isRecord(v)) fail(`${name} must be an object`);
    const out = fields(schema, v, name);
    if (opts.atLeastOne && Object.keys(out).length === 0) fail(`${name} is empty`);
    return out;
  };
}

function fields(schema: Schema, value: Record<string, unknown>, where: string): Record<string, unknown> {
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      fail(`unknown ${where ? `field "${key}" in ${where}` : `argument "${key}"`} (allowed: ${Object.keys(schema).join(', ') || 'none'})`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    const v = value[key];
    if (v === undefined || v === null) {
      if (field.required) fail(`missing ${where ? `${where}.` : ''}${key}`);
      continue;
    }
    out[key] = field.check(v, where ? `${where}.${key}` : key);
  }
  return out;
}

const requestId = str(128, { min: 1, trim: true });
const opt = (check: Check): Field => ({ check });
const req = (check: Check): Field => ({ check, required: true });

const methodToken: Check = (v, name) => {
  if (typeof v !== 'string' || !METHOD_TOKEN.test(v.trim())) fail(`${name} must be an HTTP method token, e.g. "POST"`);
  return v.trim();
};

const absoluteUrl: Check = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) fail(`${name} must be an absolute http(s) URL`);
  if (v.length > 64 * 1024) fail(`${name} is too long (max 64 KB)`);
  let parsed: URL;
  try {
    parsed = new URL(v.trim());
  } catch {
    fail(`${name} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail(`${name} must use http or https`);
  if (parsed.username || parsed.password) fail(`${name} must not contain credentials`);
  return v.trim();
};

const headerPair: Check = (v, name) => {
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'string') fail(`${name} must be a [name, value] pair`);
  if (!HEADER_NAME.test(v[0])) fail(`${name} has an invalid header name`);
  if (v[1].length > 16 * 1024 || /[\r\n\0]/.test(v[1])) fail(`${name} has an invalid value`);
  return [v[0], v[1]];
};

const kvEdit = (headers: boolean): Check =>
  object({
    name: req(headers ? (v, n) => (typeof v === 'string' && HEADER_NAME.test(v) ? v : fail(`${n} must be a header name`)) : str(4096)),
    value: opt(str(64 * 1024, { multiline: !headers })),
    enabled: opt(bool),
    remove: opt(bool),
    add: opt(bool),
    index: opt(int(0, 1000)),
    rename: opt(headers ? (v, n) => (typeof v === 'string' && HEADER_NAME.test(v) ? v : fail(`${n} must be a header name`)) : str(4096)),
  });

const jsonEdit: Check = (v, name) => {
  if (!isRecord(v)) fail(`${name} must be an object`);
  const out = fields(
    {
      path: req(str(4096)),
      value: opt((x) => x),
      type: opt(oneOf('string', 'number', 'boolean', 'null', 'object', 'array')),
      rename: opt(str(4096)),
      remove: opt(bool),
    },
    v,
    name,
  );
  if (Object.prototype.hasOwnProperty.call(v, 'value') && v.value === null) out.value = null;
  if (out.value !== undefined && JSON.stringify(out.value).length > MAX_TEXT_ARG) fail(`${name}.value is too large`);
  return out;
};

const revertTarget: Check = (v, name) => {
  if (typeof v === 'string') return oneOf('all', 'method', 'url', 'query', 'headers', 'body')(v, name);
  if (!isRecord(v)) fail(`${name} must be "all", a section name, or {param|header|field|path: …}`);
  const keys = ['param', 'header', 'field', 'path'].filter((k) => v[k] !== undefined);
  if (keys.length !== 1) fail(`${name} must name exactly one of param, header, field, path`);
  return fields({ param: opt(str(4096)), header: opt(str(256)), field: opt(str(4096)), path: opt(str(4096)), index: opt(int(0, 1000)) }, v, name);
};

const region = object({ x: req(num(-1e6, 1e7)), y: req(num(-1e6, 1e7)), width: req(num(1, 1e6)), height: req(num(1, 1e6)) });

/** Locator fields shared by screenshot and find_in_page (ElementLocator, src/shared/control-shot.ts). */
const LOCATOR: Schema = {
  selector: opt(str(2000, { min: 1 })),
  text: opt(str(1000, { min: 1 })),
  value: opt(str(1000, { min: 1 })),
  requestId: opt(requestId),
  path: opt(str(4096)),
  exact: opt(bool),
  index: opt(int(0, 10_000)),
};

const LOCATOR_KEYS = ['selector', 'text', 'value', 'requestId'] as const;

function checkLocator(args: Record<string, unknown>, required: boolean): number {
  const given = LOCATOR_KEYS.filter((k) => args[k] !== undefined);
  if (given.length > 1) fail(`give only one of ${LOCATOR_KEYS.join(', ')} (got ${given.join(', ')})`);
  if (required && given.length === 0) fail(`give one of ${LOCATOR_KEYS.join(', ')}`);
  if (args.path !== undefined && args.requestId === undefined) fail('path needs requestId (a value of that request\'s response)');
  return given.length;
}

// ------------------------------------------------------------------------------------------- schemas

const NONE: Schema = {};

const SCHEMAS: { [T in ControlTool]: Record<string, Schema> } = {
  inspect: {
    tabs: NONE,
    overlay: NONE,
    setups: { setupId: opt(str(64)), export: opt(bool) },
    websocket: { wsId: opt(str(128)) },
    ws_messages: {
      wsId: opt(str(128)),
      channel: opt(str(512)),
      direction: opt(oneOf('all', 'in', 'out')),
      filter: opt(str(1000)),
      heartbeats: opt(bool),
      limit: opt(int(1, 200)),
      before: opt(int(0, Number.MAX_SAFE_INTEGER)),
      frameId: opt(int(0, Number.MAX_SAFE_INTEGER)),
    },
    language: NONE,
    settings: NONE,
    errors: { filter: opt(oneOf('all', '5xx', '4xx', 'network')), key: opt(str(4096)), shots: opt(bool) },
    run: { requestId: req(requestId), runId: opt(str(128)), maxBodyChars: opt(int(0, 1_000_000)) },
    compare: { requestId: req(requestId), runId: opt(str(128)), against: opt(oneOf('original', 'previous')), maxLines: opt(int(10, 5000)) },
    snippet: { requestId: req(requestId), format: opt(oneOf('curl', 'fetch')) },
    initiator: { requestId: req(requestId) },
    source: { text: req(str(1000, { min: 1 })) },
    activity: NONE,
  },
  overlay: {
    open: { hidden: opt(bool) },
    close: NONE,
    show: NONE,
    hide: NONE,
    minimize: NONE,
    restore: NONE,
    dock: { dock: req(oneOf('float', 'right', 'left', 'bottom')) },
    view: {
      view: req(oneOf('requests', 'websocket', 'errors', 'screenshot')),
      resultsTab: opt(oneOf('original', 'export', 'initiator', 'test')),
      exportTab: opt(oneOf('types', 'prompt')),
      requestId: opt(requestId),
    },
    select: { requestId: opt(requestId) },
    highlight: { requestId: req(requestId) },
    reload_page: NONE,
    use_tab: NONE,
    activate_tab: NONE,
  },
  requests: {
    record: { on: req(bool) },
    preserve_log: { on: req(bool) },
    clear: NONE,
    new: {
      method: opt(methodToken),
      url: opt(absoluteUrl),
      headers: opt(list(headerPair, 200)),
      body: opt(str(MAX_TEXT_ARG, { multiline: true })),
      select: opt(bool),
    },
    duplicate: { requestId: req(requestId), select: opt(bool) },
    remove: { requestIds: req(list(requestId, MAX_IDS)) },
    restore: { requestIds: opt(list(requestId, MAX_IDS)) },
    resend: { requestId: req(requestId), runId: opt(str(128)), maxBodyChars: opt(int(0, 1_000_000)) },
    cancel: { requestId: req(requestId), runId: opt(str(128)) },
    select_run: { requestId: req(requestId), runId: req(str(128)) },
    clear_runs: { requestId: req(requestId) },
    ws_send: { wsId: req(str(128)), text: req(str(MAX_TEXT_ARG, { multiline: true })) },
    ws_clear: NONE,
  },
  edit_request: {
    edit: {
      requestId: req(requestId),
      revert: opt(list(revertTarget, 50)),
      method: opt(methodToken),
      url: opt(absoluteUrl),
      params: opt(list(kvEdit(false), 500)),
      headers: opt(list(kvEdit(true), 200)),
      bodyType: opt(oneOf('none', 'json', 'form', 'multipart', 'text')),
      body: opt(str(MAX_TEXT_ARG, { multiline: true })),
      form: opt(list(kvEdit(false), 500)),
      json: opt(list(jsonEdit, 200)),
      options: opt(
        object(
          {
            mode: opt(oneOf('page', 'extension')),
            credentials: opt(oneOf('include', 'same-origin', 'omit', 'auto')),
            redirect: opt(oneOf('follow', 'manual', 'error')),
            timeoutMs: opt((v, n) => (v === 'default' ? v : int(1000, 600_000)(v, n))),
          },
          { atLeastOne: true },
        ),
      ),
    },
  },
  list_config: {
    types: { types: req(list(oneOf('all', 'fetch', 'doc', 'js', 'css', 'img', 'media', 'font', 'other'), 10)) },
    add_rule: {
      mode: req(oneOf('hide', 'only')),
      url: opt(absoluteUrl),
      exact: opt(bool),
      method: opt(methodToken),
      template: opt(str(2048, { min: 1 })),
      requestId: opt(requestId),
    },
    toggle_rule: { ruleId: req(str(64)), enabled: opt(bool) },
    delete_rule: { ruleId: req(str(64)) },
    clear_rules: NONE,
    group: { on: req(bool) },
    url_display: { value: req(oneOf('template', 'full')) },
    text: { text: req(str(1000)) },
  },
  setups: {
    save: { name: req(str(80, { min: 1, trim: true })), group: opt(str(60, { trim: true })), sites: opt(list(str(300), 20)), includeMode: opt(bool), includeLanguage: opt(bool) },
    apply: { setupId: req(str(64)) },
    update: { setupId: req(str(64)) },
    rename: { setupId: req(str(64)), name: req(str(80, { min: 1, trim: true })) },
    move: { setupId: req(str(64)), group: req(str(60, { trim: true })) },
    sites: { setupId: req(str(64)), sites: req(list(str(300), 20)) },
    duplicate: { setupId: req(str(64)) },
    delete: { setupId: req(str(64)) },
    import: { json: req(str(MAX_TEXT_ARG, { multiline: true })), mode: opt(oneOf('merge', 'replace')) },
  },
  language: {
    set: { value: req(str(200, { min: 1, trim: true })), scope: opt(oneOf('tab', 'site')), reload: opt(bool) },
    reset: { reload: opt(bool) },
  },
  settings: {
    set: { values: req((v, n) => (isRecord(v) && Object.keys(v).length > 0 ? v : fail(`${n} must be an object of settings, e.g. {"theme": "dark"}`))) },
  },
  errors: {
    capture: { key: req(str(4096)) },
    analyze: { key: req(str(4096)), waitSeconds: opt(int(0, 600)) },
    cancel: { key: req(str(4096)) },
    fix: { key: req(str(4096)), pr: opt(bool) },
    issue: { key: req(str(4096)) },
    commit: { key: req(str(4096)) },
    pull_request: { key: req(str(4096)) },
    discard: { key: req(str(4096)) },
  },
  screenshot: {
    capture: {
      ...LOCATOR,
      target: opt(oneOf('visible', 'full', 'region', 'element')),
      region: opt(region),
      padding: opt(int(0, SHOT_PADDING_MAX)),
      open: opt(bool),
    },
  },
  find_in_page: {
    find: { ...LOCATOR, highlight: opt(bool), limit: opt(int(1, 500)) },
  },
};

/** Tools whose single action is implied (the MCP tool has no `action` argument). */
const DEFAULT_ACTION: Partial<Record<ControlTool, string>> = { edit_request: 'edit', settings: 'set', screenshot: 'capture', find_in_page: 'find' };

/** Validate the params of a `control` call. Throws ParamError with a message for Claude. */
export function validateControl(raw: unknown): ValidControl {
  if (!isRecord(raw)) fail('params must be an object');
  for (const key of Object.keys(raw)) if (!['tool', 'action', 'tabId', 'activate', 'args'].includes(key)) fail(`unknown parameter "${key}"`);
  const tool = raw.tool;
  if (!isControlTool(tool)) fail(`unknown tool "${String(tool).slice(0, 40)}"`);
  const action = raw.action === undefined || raw.action === null ? DEFAULT_ACTION[tool] : raw.action;
  if (!isControlAction(tool, action)) fail(`${tool}: action must be one of: ${CONTROL_ACTIONS[tool].join(', ')}`);
  const out: ValidControl = { tool, action, args: {} };
  if (raw.tabId !== undefined && raw.tabId !== null) {
    if (typeof raw.tabId !== 'number' || !Number.isSafeInteger(raw.tabId) || raw.tabId < 0) fail('tabId must be a tab id (non-negative integer) from inspect tabs / status');
    out.tabId = raw.tabId;
  }
  if (raw.activate !== undefined && raw.activate !== null) {
    if (typeof raw.activate !== 'boolean') fail('activate must be true or false');
    out.activate = raw.activate;
  }
  const args = raw.args === undefined || raw.args === null ? {} : raw.args;
  if (!isRecord(args)) fail('args must be an object');
  out.args = fields(SCHEMAS[tool][action]!, args, '');
  // Cross-field rules.
  if (tool === 'screenshot') {
    const locators = checkLocator(out.args, false);
    const target = (out.args.target as string | undefined) ?? (locators ? 'element' : 'visible');
    if (target === 'element' && !locators) fail('target "element" needs a locator: selector, text, value or requestId');
    if (target === 'region' && !out.args.region) fail('target "region" needs region {x, y, width, height} (page CSS px)');
    if (target !== 'region' && out.args.region) fail('region is only used with target "region"');
    if ((target === 'visible' || target === 'full') && locators) fail(`target "${target}" captures the page: drop the locator (or use target "element")`);
  }
  if (tool === 'find_in_page') checkLocator(out.args, true);
  if (tool === 'list_config' && action === 'add_rule') {
    const kinds = ['url', 'method', 'template', 'requestId'].filter((k) => out.args[k] !== undefined);
    if (kinds.length !== 1) fail('add_rule needs exactly one of url (prefix), method, template or requestId (its endpoint)');
    if (out.args.exact !== undefined && out.args.url === undefined) fail('exact is only used with url');
  }
  if (tool === 'edit_request' && Object.keys(out.args).length === 1) fail('edit_request: give at least one change (method, url, params, headers, bodyType, body, form, json, options or revert)');
  return out;
}

export { SCHEMAS as CONTROL_SCHEMAS };
