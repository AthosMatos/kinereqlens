// OWNER: lib-prompt agent. Secret detection and redaction for anything leaving the browser towards Claude
// (agent prompts, Copy-for-agent, the MCP bridge).
//
// Two complementary signals: names (header / query / form / JSON keys that carry secrets) and values that look
// like credentials whatever they are called (JWTs, "Bearer …", well-known API key prefixes, long random
// tokens). Every function is pure, never throws, and keeps everything that is not a secret byte for byte.
import type { HeaderPair, JNode } from '../shared/types';
import { decodeQueryComponent, splitUrl } from './url';

export const REDACTED = '<redacted>';

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
]);

const SENSITIVE_HEADER_PARTS = ['token', 'secret', 'signature', 'session', 'password', 'apikey', 'api-key', 'api_key', 'auth'];

/** Names matched by the patterns above that carry no secret (challenges, scopes, identifiers). */
const NON_SECRET_HEADERS = new Set([
  'www-authenticate',
  'proxy-authenticate',
  'x-oauth-scopes',
  'x-accepted-oauth-scopes',
  'idempotency-key',
]);

/**
 * Header names whose values are secrets: authorization, proxy-authorization, cookie, set-cookie, x-api-key,
 * api-key, x-auth-token, x-csrf-token, x-xsrf-token, x-amz-security-token, and any name containing
 * "token", "secret", "signature", "session", "password", "apikey"/"api-key"/"api_key".
 *
 * Also: names containing "auth" (custom auth headers such as "X-Kinebot-Auth") and names ending in "-key"
 * ("X-Functions-Key", "Ocp-Apim-Subscription-Key"); not WWW-Authenticate / Proxy-Authenticate (challenges),
 * X-OAuth-Scopes / X-Accepted-OAuth-Scopes or Idempotency-Key.
 */
export function isSensitiveHeader(name: string): boolean {
  if (typeof name !== 'string') return false;
  const lower = name.trim().toLowerCase();
  if (lower === '' || NON_SECRET_HEADERS.has(lower)) return false;
  if (SENSITIVE_HEADERS.has(lower)) return true;
  if (SENSITIVE_HEADER_PARTS.some((part) => lower.includes(part))) return true;
  return lower.endsWith('-key') || lower.endsWith('_key');
}

/** Normalized key names (lower case, "-" / "_" removed) that are secrets when they match exactly. */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'key',
  'auth',
  'authorization',
  'signature',
  'sig',
  'session',
  'sessionid',
  'clientsecret',
  'otp',
  'pin',
  'cvv',
  'cvc',
  'cardnumber',
  'ssn',
  'privatekey',
  'credentials',
  'csrf',
  'xsrf',
  'jwt',
  'sid',
  // Echoed / logged request headers ("headers": {"cookie": "sid=…"}).
  'cookie',
  'cookies',
  'setcookie',
  'proxyauthorization',
]);

const SENSITIVE_KEY_SUFFIXES = ['token', 'secret', 'apikey', 'privatekey', 'secretkey', 'sessionid', 'sessid'];
const SENSITIVE_KEY_PARTS = ['password', 'passwd'];

function normalizeKey(name: string): string {
  return typeof name === 'string' ? name.trim().toLowerCase().replace(/[-_]/g, '') : '';
}

/**
 * Query / form / JSON keys whose values are secrets (case-insensitive, ignoring - and _):
 * password, passwd, pwd, secret, token, access_token, refresh_token, id_token, api_key, apikey, key (exact),
 * auth, authorization, signature, sig (exact), session, sessionid, client_secret, otp, pin (exact), cvv, cvc,
 * card_number, ssn, private_key, credentials. Plus anything ending in "token", "secret", "password".
 *
 * Also: csrf, xsrf, jwt, sid, cookie, cookies, set-cookie, proxy-authorization; anything ending in "apikey",
 * "privatekey", "secretkey", "sessionid", "sessid";
 * anything containing "password" / "passwd" (password_confirmation). Names that merely start with a sensitive
 * word are not sensitive: "tokenizer_version", "token_count", "max_tokens", "keyboard", "author", "pinned".
 */
export function isSensitiveKey(name: string): boolean {
  const key = normalizeKey(name);
  if (key === '') return false;
  if (SENSITIVE_KEYS.has(key)) return true;
  if (SENSITIVE_KEY_PARTS.some((part) => key.includes(part))) return true;
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

/** JWT / JWS compact form: base64url JSON header ("eyJ" = '{"'), payload, signature (may be empty: alg none). */
const JWT = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/;
/** The whole value is one credential: "Bearer abc…" (prose such as "Basic information about…" is not). */
const AUTH_SCHEME_VALUE = /^(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}$/i;
const KNOWN_KEY_PATTERNS: readonly RegExp[] = [
  /^(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}$/, // OpenAI / Anthropic / Stripe style
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // GitHub tokens
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[abposr]-[A-Za-z0-9-]{10,}$/, // Slack
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^AIza[0-9A-Za-z_-]{30,}$/, // Google API key
  /^glpat-[A-Za-z0-9_-]{20,}$/, // GitLab
];
const RANDOM_TOKEN_CHARSET = /^[A-Za-z0-9+/=_-]+$/;
const RANDOM_TOKEN_MIN = 32;
/** Longer opaque strings are data (base64 images, blobs), not credentials. */
const RANDOM_TOKEN_MAX = 512;

type CharClass = 0 | 1 | 2 | 3;

function charClass(code: number): CharClass {
  if (code >= 0x41 && code <= 0x5a) return 0; // A-Z
  if (code >= 0x61 && code <= 0x7a) return 1; // a-z
  if (code >= 0x30 && code <= 0x39) return 2; // 0-9
  return 3;
}

/**
 * Random-looking token: mixed case with digits that switches character class often. Identifiers such as
 * "InternalServerErrorExceptionHandler2" have long lower-case runs (few switches); hex digests and UUIDs have no
 * upper case, so ids and hashes are kept.
 */
function looksRandom(value: string): boolean {
  if (value.length < RANDOM_TOKEN_MIN || value.length > RANDOM_TOKEN_MAX || !RANDOM_TOKEN_CHARSET.test(value)) return false;
  const counts = [0, 0, 0, 0];
  let switches = 0;
  let previous = charClass(value.charCodeAt(0));
  counts[previous]++;
  for (let i = 1; i < value.length; i++) {
    const current = charClass(value.charCodeAt(i));
    counts[current]++;
    if (current !== previous) switches++;
    previous = current;
  }
  return counts[0] >= 1 && counts[1] >= 1 && counts[2] >= 2 && switches / (value.length - 1) >= 0.45;
}

/** Heuristic: JWT (three base64url parts), "Bearer xxx", sk-/pk-/ghp_/xox*-style keys, ≥ 32-char high-entropy strings. */
export function looksLikeSecretValue(value: string): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 16) return false;
  return (
    JWT.test(text) ||
    AUTH_SCHEME_VALUE.test(text) ||
    KNOWN_KEY_PATTERNS.some((pattern) => pattern.test(text)) ||
    looksRandom(text)
  );
}

// ---------------------------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------------------------

const AUTH_SCHEME = /^([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*)\s+\S/;

function redactAuthorization(value: string): string {
  const scheme = AUTH_SCHEME.exec(value.trim());
  return scheme ? `${scheme[1]} ${REDACTED}` : REDACTED;
}

/** "sid=abc; theme=dark" -> "sid=<redacted>; theme=<redacted>". */
function redactCookieHeader(value: string): string {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const eq = part.indexOf('=');
      return eq > 0 ? `${part.slice(0, eq).trim()}=${REDACTED}` : REDACTED;
    })
    .join('; ');
}

/** "sid=abc; Path=/; HttpOnly" -> "sid=<redacted>; Path=/; HttpOnly" (attributes are not secret). */
function redactSetCookie(value: string): string {
  const [first, ...attributes] = value.split(';');
  const eq = first.indexOf('=');
  const cookie = eq > 0 ? `${first.slice(0, eq).trim()}=${REDACTED}` : REDACTED;
  return [cookie, ...attributes.map((attribute) => attribute.trim()).filter((attribute) => attribute !== '')].join('; ');
}

function redactHeaderValue(name: string, value: string): string {
  switch (name.trim().toLowerCase()) {
    case 'authorization':
    case 'proxy-authorization':
      return redactAuthorization(value);
    case 'cookie':
      return redactCookieHeader(value);
    case 'set-cookie':
      return redactSetCookie(value);
    default:
      return REDACTED;
  }
}

/**
 * Header redaction. Authorization keeps its scheme ("Bearer <redacted>", "Basic <redacted>"); Cookie keeps
 * cookie names ("sid=<redacted>; theme=<redacted>"); others become REDACTED.
 *
 * Also: Set-Cookie keeps the cookie name and its attributes; any other header whose value looks like a secret
 * (looksLikeSecretValue) is redacted too; empty values stay empty. `redacted` is true when a value was replaced.
 */
export function redactHeaders(headers: HeaderPair[]): { headers: HeaderPair[]; redacted: boolean } {
  let redacted = false;
  const out = (Array.isArray(headers) ? headers : []).map((input) => {
    const header = { name: String(input?.name ?? ''), value: String(input?.value ?? '') };
    if (header.value.trim() === '') return header;
    if (isSensitiveHeader(header.name)) {
      redacted = true;
      return { name: header.name, value: redactHeaderValue(header.name, header.value) };
    }
    if (looksLikeSecretValue(header.value)) {
      redacted = true;
      return { name: header.name, value: REDACTED };
    }
    return header;
  });
  return { headers: out, redacted };
}

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

/** Redact the values of "k=v&…" text (query or fragment); raw text of untouched segments is preserved. */
function redactParamText(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  const segments = text.split('&').map((segment) => {
    const eq = segment.indexOf('=');
    if (eq < 0) return segment;
    const rawValue = segment.slice(eq + 1);
    if (rawValue === '' || rawValue === REDACTED) return segment;
    const key = decodeQueryComponent(segment.slice(0, eq));
    if (!isSensitiveKey(key) && !looksLikeSecretValue(decodeQueryComponent(rawValue))) return segment;
    redacted = true;
    return `${segment.slice(0, eq)}=${REDACTED}`;
  });
  return { text: segments.join('&'), redacted };
}

function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** scheme://[userinfo@]authority + path, split so the path can be inspected segment by segment. */
const HIERARCHICAL = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/]*)(.*)$/;

function redactAuthority(authority: string): { text: string; redacted: boolean } {
  const at = authority.lastIndexOf('@');
  if (at < 0) return { text: authority, redacted: false };
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(':');
  if (colon < 0 || colon === userinfo.length - 1) return { text: authority, redacted: false };
  return { text: `${userinfo.slice(0, colon)}:${REDACTED}${authority.slice(at)}`, redacted: true };
}

function redactPath(path: string): { text: string; redacted: boolean } {
  let redacted = false;
  const text = path
    .split('/')
    .map((segment) => {
      if (segment === '' || !looksLikeSecretValue(safeDecodeSegment(segment))) return segment;
      redacted = true;
      return REDACTED;
    })
    .join('/');
  return { text, redacted };
}

/**
 * Redact sensitive query values in an absolute URL (keys kept, raw encoding of other params preserved).
 *
 * Also: values that look like secrets under any key, "k=v" parameters in the fragment (OAuth implicit flow
 * "#access_token=…"), the password of `user:password@` userinfo, and path segments that look like secrets
 * (e.g. bot tokens). Non-hierarchical URLs (data:, blob:, about:) are returned unchanged.
 */
export function redactUrl(url: string): { url: string; redacted: boolean } {
  if (typeof url !== 'string') return { url: '', redacted: false };
  const { base, query, hash } = splitUrl(url);
  const parts = HIERARCHICAL.exec(base);
  if (!parts) return { url, redacted: false };
  const authority = redactAuthority(parts[2]);
  const path = redactPath(parts[3]);
  const params = redactParamText(query);
  const fragment = hash.includes('=') ? redactParamText(hash) : { text: hash, redacted: false };
  const redacted = authority.redacted || path.redacted || params.redacted || fragment.redacted;
  if (!redacted) return { url, redacted: false };
  const hadQuery = url.charAt(base.length) === '?';
  const rebuilt = `${parts[1]}${authority.text}${path.text}${hadQuery ? `?${params.text}` : ''}`;
  return { url: url.includes('#') ? `${rebuilt}#${fragment.text}` : rebuilt, redacted: true };
}

// ---------------------------------------------------------------------------------------------
// JSON trees
// ---------------------------------------------------------------------------------------------

function redactedLeaf(node: JNode): JNode {
  const out: JNode = { id: node.id, type: 'string', value: REDACTED };
  if (node.key !== undefined) out.key = node.key;
  return out;
}

/** A scalar that carries a value worth hiding (empty strings, booleans and null reveal nothing). */
function hasSecretValue(node: JNode): boolean {
  if (node.type === 'number') return true;
  return node.type === 'string' && typeof node.value === 'string' && node.value !== '' && node.value !== REDACTED;
}

/** Field names of `{name: "Authorization", value: "…"}` style entries (HAR, echoed header lists). */
const PAIR_NAME_KEYS = new Set(['name', 'key', 'header', 'field', 'param']);

function isSecretName(name: string): boolean {
  return isSensitiveKey(name) || SENSITIVE_HEADERS.has(name.trim().toLowerCase());
}

/**
 * Index of the child that holds a secret because a sibling names it: `["token", "…"]` pairs and
 * `{name: "Cookie", value: "…"}` entries. -1 when there is none.
 */
function namedSecretIndex(node: JNode): number {
  const kids = node.children;
  if (!Array.isArray(kids)) return -1;
  if (node.type === 'array') {
    const [name, value] = kids;
    return kids.length === 2 && name?.type === 'string' && value?.type !== 'object' && value?.type !== 'array' && isSecretName(String(name.value))
      ? 1
      : -1;
  }
  let named = false;
  let valueIndex = -1;
  for (let i = 0; i < kids.length; i++) {
    const key = kids[i].key?.toLowerCase();
    if (key === 'value') valueIndex = i;
    else if (key !== undefined && PAIR_NAME_KEYS.has(key) && kids[i].type === 'string' && isSecretName(String(kids[i].value))) named = true;
  }
  return named ? valueIndex : -1;
}

interface Frame {
  source: JNode;
  /** Inside the value of a sensitive key: every scalar below is redacted. */
  sensitive: boolean;
  /** Child index named a secret by a sibling (namedSecretIndex). */
  secretIndex: number;
  /** Index of the next child to visit. */
  next: number;
  /** Rebuilt children; null while every visited child is unchanged (structural sharing). */
  children: JNode[] | null;
}

/**
 * Redact sensitive keys anywhere in a JSON tree (string/number values -> "<redacted>" string), plus
 * values that look like JWTs / bearer tokens / long random secrets regardless of key, and secrets embedded in
 * longer strings (an echoed query string "api_key=<redacted>&page=1", a URL, "Bearer <redacted>" in a log
 * line) and values a sibling names as secret (`["token", "<redacted>"]` pairs, `{"name": "Cookie", "value":
 * "<redacted>"}` entries as in HAR files or echoed header lists). Returns a new tree.
 *
 * Details: under a sensitive key whose value is an object or array ("credentials": {...}) every string/number
 * leaf is redacted and the structure is kept, so types can still be inferred. Ids and keys are kept; untouched
 * subtrees are shared with the input (trees are immutable values), and the input itself is returned when
 * nothing was redacted. Iterative: safe for any depth.
 */
export function redactJsonTree(tree: JNode): { tree: JNode; redacted: boolean } {
  let redacted = false;
  const visitScalar = (node: JNode, sensitive: boolean): JNode => {
    if (!hasSecretValue(node)) return node;
    if (sensitive || (node.type === 'string' && looksLikeSecretValue(String(node.value)))) {
      redacted = true;
      return redactedLeaf(node);
    }
    if (node.type === 'string') {
      // Secrets inside a longer string: an echoed query ("api_key=sk_live_…"), a logged header line, a URL.
      const inline = redactInlineValue(String(node.value));
      if (inline !== null) {
        redacted = true;
        return { ...node, value: inline };
      }
    }
    return node;
  };
  const isContainer = (node: JNode) => (node.type === 'object' || node.type === 'array') && Array.isArray(node.children);
  if (!isContainer(tree)) {
    const leaf = visitScalar(tree, false);
    return { tree: leaf, redacted };
  }
  const stack: Frame[] = [{ source: tree, sensitive: false, secretIndex: namedSecretIndex(tree), next: 0, children: null }];
  let result: JNode = tree;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const kids = frame.source.children as JNode[];
    if (frame.next < kids.length) {
      const index = frame.next++;
      const child = kids[index];
      const sensitive =
        frame.sensitive ||
        index === frame.secretIndex ||
        (frame.source.type === 'object' && child.key !== undefined && isSensitiveKey(child.key));
      if (isContainer(child)) {
        stack.push({ source: child, sensitive, secretIndex: sensitive ? -1 : namedSecretIndex(child), next: 0, children: null });
        continue;
      }
      const replaced = visitScalar(child, sensitive);
      if (replaced !== child) (frame.children ??= kids.slice(0, frame.next - 1)).push(replaced);
      else frame.children?.push(child);
      continue;
    }
    stack.pop();
    const rebuilt = frame.children ? { ...frame.source, children: frame.children } : frame.source;
    const parent = stack[stack.length - 1];
    if (!parent) {
      result = rebuilt;
      break;
    }
    const parentKids = parent.source.children as JNode[];
    if (rebuilt !== frame.source) (parent.children ??= parentKids.slice(0, parent.next - 1)).push(rebuilt);
    else parent.children?.push(frame.source);
  }
  return { tree: result, redacted };
}

// ---------------------------------------------------------------------------------------------
// Free text (text bodies, GraphQL documents)
// ---------------------------------------------------------------------------------------------

const INLINE_JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const INLINE_BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g;
/** "Basic <base64>" with a digit, "=" or two capitals in the credentials, so "Basic Information" is prose. */
const INLINE_BASIC = /\b(Basic)\s+(?=[A-Za-z0-9+/]*(?:\d|[A-Z][A-Za-z0-9+/]*[A-Z])|[A-Za-z0-9+/]{8,}=)[A-Za-z0-9+/]{8,}={0,2}/g;
const INLINE_KNOWN_KEY =
  /\b(?:(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,})/g;
/**
 * name = value, name: value, "name": "value", name="value" (form-like text, YAML, logs, XML attributes). The
 * name must start a word (lookbehind): otherwise every position inside a long word is a new start and the scan
 * turns quadratic (100 KB of letters took ~20 s).
 */
const INLINE_ASSIGNMENT = /(?<![\w-])(["']?)([A-Za-z_][\w-]*)\1(\s*[:=]\s*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s&;,"'<>(){}[\]]+)/g;
/** <password>value</password> */
const INLINE_XML_ELEMENT = /<([A-Za-z_][\w-]*)>([^<]{1,4096})<\/\1>/g;
/** "Authorization: Token abc…" in logs / header dumps: keep the scheme, redact the credentials. */
const INLINE_AUTHORIZATION = /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)([A-Za-z][\w-]*)\s+(?!<redacted>)[^\s"',;]+/gi;
/** Unquoted values that reveal nothing: literals, auth scheme names and GraphQL variable references. */
const HARMLESS_VALUE = /^(?:null|true|false|bearer|basic|token|digest|negotiate|\$[_A-Za-z][_0-9A-Za-z]*)$/i;

function redactAssigned(value: string, quotedOnly: boolean): string | null {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    return value.length <= 2 || value.includes(REDACTED) ? null : `${quote}${REDACTED}${quote}`;
  }
  if (quotedOnly || HARMLESS_VALUE.test(value) || value === REDACTED) return null;
  return REDACTED;
}

function redactFreeText(text: string, quotedOnly: boolean): { text: string; redacted: boolean } {
  if (typeof text !== 'string' || text === '') return { text: typeof text === 'string' ? text : '', redacted: false };
  let out = text
    .replace(INLINE_JWT, REDACTED)
    .replace(INLINE_BEARER, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(INLINE_BASIC, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(INLINE_KNOWN_KEY, REDACTED)
    .replace(INLINE_AUTHORIZATION, (_match, prefix: string, scheme: string) => `${prefix}${scheme} ${REDACTED}`);
  out = out.replace(INLINE_ASSIGNMENT, (match, quote: string, name: string, separator: string, value: string) => {
    if (!isSensitiveKey(name)) return match;
    const replaced = redactAssigned(value, quotedOnly);
    return replaced === null ? match : `${quote}${name}${quote}${separator}${replaced}`;
  });
  if (!quotedOnly) {
    out = out.replace(INLINE_XML_ELEMENT, (match, name: string) => (isSensitiveKey(name) ? `<${name}>${REDACTED}</${name}>` : match));
  }
  return { text: out, redacted: out !== text };
}

/** Strings shorter than this cannot hold "k=<secret>" worth redacting inside a JSON value. */
const INLINE_MIN_CHARS = 6;
/** Longer JSON strings (embedded documents, base64 blobs) are not scanned inline. */
const INLINE_MAX_CHARS = 256 * 1024;
/** Cheap pre-check before the inline scan: an assignment, a credential prefix or a URL with a query. */
const INLINE_HINT = /[=:]|eyJ|bearer|basic|sk[-_]|pk[-_]|rk[-_]|gh[pousr]_|github_pat_|xox|AKIA|AIza|glpat-/i;

/**
 * Secrets embedded in a JSON string value (the value as a whole is not a secret): URLs with sensitive query
 * parameters, `k=v&…` text, "Bearer …", JWTs, well-known API keys, `password: …`. Returns the redacted string,
 * or null when nothing was found.
 */
function redactInlineValue(value: string): string | null {
  if (value.length < INLINE_MIN_CHARS || value.length > INLINE_MAX_CHARS || !INLINE_HINT.test(value)) return null;
  let out = value;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/.test(out)) {
    const url = redactUrl(out);
    if (url.redacted) out = url.url;
  } else if (/^[^\s&=]+=[^\s&]*(?:&[^\s&=]+(?:=[^\s&]*)?)*$/.test(out)) {
    const params = redactParamText(out);
    if (params.redacted) out = params.text;
  }
  const free = redactFreeText(out, false);
  if (free.redacted) out = free.text;
  return out === value ? null : out;
}

/**
 * Best-effort redaction of free text (non-JSON bodies): JWTs, bearer / basic credentials, well-known API key
 * formats, and values assigned to sensitive names (`password=…`, `"token": "…"`, `apiKey: …`,
 * `<password>…</password>`). Text without secrets is returned unchanged.
 */
export function redactText(text: string): { text: string; redacted: boolean } {
  return redactFreeText(text, false);
}

/**
 * Redaction for a GraphQL document: credentials anywhere, plus string literals passed to sensitive arguments
 * (`login(password: "hunter2")`). Unquoted tokens are left alone so aliases (`token: login(…)`), variable
 * references (`password: $password`) and selections keep the document valid.
 */
export function redactGraphqlDocument(text: string): { text: string; redacted: boolean } {
  return redactFreeText(text, true);
}
