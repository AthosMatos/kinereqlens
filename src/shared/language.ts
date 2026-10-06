/**
 * "Site language" tool (docs/ARCHITECTURE.md §11): test a site in another language without changing the
 * browser's settings. Pure and shared by the service worker (DNR rules, effective language per tab), the content
 * script (settings sanitizer, hook pushes) and the overlay UI (picker, validation, Setups).
 *
 * A language *value* is an Accept-Language list as the user types it — "pt-BR", "pt-BR, en;q=0.8" — normalized to
 * the canonical header form "pt-BR,en;q=0.8": tags canonicalized (Intl.getCanonicalLocales), duplicates and q=0
 * items dropped, q values written without trailing zeros. `languagesOf(value)` orders the tags by q (stable) for
 * navigator.languages / the Intl default locale.
 */

/** Captured at module evaluation so nothing patched later can interfere. */
const NativeURL = URL;
/** Max characters of a normalized language value. */
export const MAX_LANGUAGE_VALUE = 200;
/** Max languages in one value. */
export const MAX_LANGUAGE_ITEMS = 10;
/** Max sites with a persisted language (settings.siteLanguages). */
export const MAX_SITE_LANGUAGES = 200;

/** Where an override comes from: this tab (until it is closed) or the page's host (persisted). */
export type LanguageScope = 'tab' | 'site';

/** The language state of one tab, as the overlay shows it. */
export interface LanguageStatus {
  /** Tab-scope override (kept by the service worker in storage.session until the tab closes). */
  tab: string | null;
  /** Site-scope override of the tab's page host (settings.siteLanguages[host]). */
  site: string | null;
  /** The page host the site scope applies to (null for non-http(s) pages). */
  host: string | null;
  /** What applies right now: the tab override, else the site's, else null (the browser's own languages). */
  effective: string | null;
  scope: LanguageScope | null;
}

/** One entry of the language picker: a BCP-47 tag, its native name and its English name (for search). */
export interface LanguageOption {
  tag: string;
  name: string;
  english: string;
}

/** Common languages of the picker (no flags: languages are not countries). */
export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { tag: 'pt-BR', name: 'Português (Brasil)', english: 'Portuguese (Brazil)' },
  { tag: 'pt-PT', name: 'Português (Portugal)', english: 'Portuguese (Portugal)' },
  { tag: 'en-US', name: 'English (United States)', english: 'English (United States)' },
  { tag: 'en-GB', name: 'English (United Kingdom)', english: 'English (United Kingdom)' },
  { tag: 'en-IN', name: 'English (India)', english: 'English (India)' },
  { tag: 'en-AU', name: 'English (Australia)', english: 'English (Australia)' },
  { tag: 'es-ES', name: 'Español (España)', english: 'Spanish (Spain)' },
  { tag: 'es-419', name: 'Español (Latinoamérica)', english: 'Spanish (Latin America)' },
  { tag: 'es-MX', name: 'Español (México)', english: 'Spanish (Mexico)' },
  { tag: 'fr-FR', name: 'Français (France)', english: 'French (France)' },
  { tag: 'fr-CA', name: 'Français (Canada)', english: 'French (Canada)' },
  { tag: 'de-DE', name: 'Deutsch (Deutschland)', english: 'German (Germany)' },
  { tag: 'de-CH', name: 'Deutsch (Schweiz)', english: 'German (Switzerland)' },
  { tag: 'it-IT', name: 'Italiano (Italia)', english: 'Italian (Italy)' },
  { tag: 'nl-NL', name: 'Nederlands (Nederland)', english: 'Dutch (Netherlands)' },
  { tag: 'ca-ES', name: 'Català', english: 'Catalan' },
  { tag: 'sv-SE', name: 'Svenska (Sverige)', english: 'Swedish (Sweden)' },
  { tag: 'da-DK', name: 'Dansk (Danmark)', english: 'Danish (Denmark)' },
  { tag: 'nb-NO', name: 'Norsk bokmål (Norge)', english: 'Norwegian Bokmål (Norway)' },
  { tag: 'fi-FI', name: 'Suomi (Suomi)', english: 'Finnish (Finland)' },
  { tag: 'pl-PL', name: 'Polski (Polska)', english: 'Polish (Poland)' },
  { tag: 'cs-CZ', name: 'Čeština (Česko)', english: 'Czech (Czechia)' },
  { tag: 'hu-HU', name: 'Magyar (Magyarország)', english: 'Hungarian (Hungary)' },
  { tag: 'ro-RO', name: 'Română (România)', english: 'Romanian (Romania)' },
  { tag: 'el-GR', name: 'Ελληνικά (Ελλάδα)', english: 'Greek (Greece)' },
  { tag: 'tr-TR', name: 'Türkçe (Türkiye)', english: 'Turkish (Türkiye)' },
  { tag: 'ru-RU', name: 'Русский (Россия)', english: 'Russian (Russia)' },
  { tag: 'uk-UA', name: 'Українська (Україна)', english: 'Ukrainian (Ukraine)' },
  { tag: 'ar', name: 'العربية', english: 'Arabic' },
  { tag: 'he-IL', name: 'עברית (ישראל)', english: 'Hebrew (Israel)' },
  { tag: 'fa-IR', name: 'فارسی (ایران)', english: 'Persian (Iran)' },
  { tag: 'hi-IN', name: 'हिन्दी (भारत)', english: 'Hindi (India)' },
  { tag: 'bn-BD', name: 'বাংলা (বাংলাদেশ)', english: 'Bangla (Bangladesh)' },
  { tag: 'th-TH', name: 'ไทย (ไทย)', english: 'Thai (Thailand)' },
  { tag: 'vi-VN', name: 'Tiếng Việt (Việt Nam)', english: 'Vietnamese (Vietnam)' },
  { tag: 'id-ID', name: 'Bahasa Indonesia (Indonesia)', english: 'Indonesian (Indonesia)' },
  { tag: 'ms-MY', name: 'Bahasa Melayu (Malaysia)', english: 'Malay (Malaysia)' },
  { tag: 'ja-JP', name: '日本語 (日本)', english: 'Japanese (Japan)' },
  { tag: 'zh-CN', name: '中文（中国）', english: 'Chinese (China, Simplified)' },
  { tag: 'zh-TW', name: '中文（台灣）', english: 'Chinese (Taiwan, Traditional)' },
  { tag: 'ko-KR', name: '한국어 (대한민국)', english: 'Korean (South Korea)' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ------------------------------------------------------------------------------------------- tags

/**
 * Well-formed BCP-47 language tags this tool accepts: language (2–3 or 5–8 letters), optional script (4 letters),
 * optional region (2 letters or 3 digits), optional variants. Extensions (-u-, -x-) and grandfathered tags are not
 * accepted: Accept-Language values never need them, and they keep the hook's input simple.
 */
const TAG = /^(?:[a-z]{2,3}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z0-9]{5,8}|\d[a-z0-9]{3}))*$/i;

/** The canonical form of a language tag ("pt-br" → "pt-BR", "zh-hant-tw" → "zh-Hant-TW"), or null when invalid. */
export function canonicalTag(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > 35 || !TAG.test(text)) return null;
  try {
    const canonical = Intl.getCanonicalLocales(text)[0];
    return typeof canonical === 'string' && canonical.length > 0 && canonical.length <= 35 ? canonical : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------- values

/** One language of a value; `q` null = no explicit weight (1). */
export interface LanguageItem {
  tag: string;
  q: number | null;
}

export type LanguageParse = { ok: true; value: string; items: LanguageItem[] } | { ok: false; error: string };

const Q_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * Parse an Accept-Language list as typed by the user: comma-separated tags, each optionally with `;q=0.8`
 * (0..1, up to 3 decimals). Returns the normalized value or a message for the user.
 */
export function parseLanguageValue(input: unknown): LanguageParse {
  if (typeof input !== 'string') return { ok: false, error: 'Enter a language tag such as pt-BR' };
  const text = input.trim();
  if (!text) return { ok: false, error: 'Enter a language tag such as pt-BR' };
  if (text.length > MAX_LANGUAGE_VALUE * 2) return { ok: false, error: 'Too long' };
  const items: LanguageItem[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const [tagText = '', ...params] = part.split(';').map((s) => s.trim());
    const tag = canonicalTag(tagText);
    if (!tag) return { ok: false, error: `“${tagText.slice(0, 40)}” is not a valid language tag (e.g. pt-BR, en, es-419)` };
    let q: number | null = null;
    for (const param of params) {
      const m = /^q\s*=\s*(.*)$/i.exec(param);
      if (!m || !Q_VALUE.test(m[1]!.trim())) return { ok: false, error: `Invalid weight “${param.slice(0, 20)}” (use q=0.1 … q=1)` };
      q = Number(m[1]!.trim());
    }
    if (q === 0) continue; // "not acceptable": nothing to send
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ tag, q: q === 1 ? null : q });
    if (items.length > MAX_LANGUAGE_ITEMS) return { ok: false, error: `At most ${MAX_LANGUAGE_ITEMS} languages` };
  }
  if (items.length === 0) return { ok: false, error: 'Enter at least one language' };
  const value = formatLanguageItems(items);
  if (value.length > MAX_LANGUAGE_VALUE) return { ok: false, error: 'Too long' };
  return { ok: true, value, items };
}

/** The header form of parsed items: "pt-BR,en;q=0.8". */
export function formatLanguageItems(items: readonly LanguageItem[]): string {
  return items.map((i) => (i.q === null ? i.tag : `${i.tag};q=${String(i.q)}`)).join(',');
}

/** The normalized value of `input`, or null when it is not a valid language list. */
export function normalizeLanguageValue(input: unknown): string | null {
  const parsed = parseLanguageValue(input);
  return parsed.ok ? parsed.value : null;
}

/** The tags of a value ordered by weight (stable), as navigator.languages reports them. [] when invalid. */
export function languagesOf(value: unknown): string[] {
  const parsed = parseLanguageValue(value);
  if (!parsed.ok) return [];
  return parsed.items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.q ?? 1) - (a.item.q ?? 1) || a.index - b.index)
    .map(({ item }) => item.tag);
}

/** The first (preferred) tag of a value, or null. */
export function primaryLanguage(value: unknown): string | null {
  return languagesOf(value)[0] ?? null;
}

// ------------------------------------------------------------------------------------------- picker

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Picker entries matching `query` (tag prefix, or a word of the native / English name); all for ''. */
export function searchLanguages(query: string, options: readonly LanguageOption[] = LANGUAGE_OPTIONS): LanguageOption[] {
  const q = fold(query.trim());
  if (!q) return options.slice();
  const tagHits: LanguageOption[] = [];
  const nameHits: LanguageOption[] = [];
  for (const option of options) {
    if (fold(option.tag).startsWith(q) || fold(option.tag.replace('-', '_')).startsWith(q)) tagHits.push(option);
    else if (fold(option.name).includes(q) || fold(option.english).includes(q)) nameHits.push(option);
  }
  return [...tagHits, ...nameHits];
}

/** Native name of a tag when it is in the picker list (exact, else by language), else null. */
export function languageName(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();
  const exact = LANGUAGE_OPTIONS.find((o) => o.tag.toLowerCase() === lower);
  if (exact) return exact.name;
  try {
    const display = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    return display && display.toLowerCase() !== lower ? display : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------- sites

/** The site key of a page URL: its host name (http(s) only, any port), lower-case punycode. Null otherwise. */
export function siteKeyOf(pageUrl: string | null | undefined): string | null {
  if (typeof pageUrl !== 'string' || !pageUrl) return null;
  let url: URL;
  try {
    url = new NativeURL(pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let host = url.hostname;
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host || null;
}

/** A stored site key, canonicalized (host name only), or null. */
export function normalizeSiteKey(input: unknown): string | null {
  if (typeof input !== 'string' || !input || input.length > 260 || /[\s/?#@\\%]/.test(input)) return null;
  const host = siteKeyOf(`http://${input}/`);
  return host && host.length <= 253 ? host : null;
}

/** settings.siteLanguages: valid hosts → normalized values, at most MAX_SITE_LANGUAGES (first ones kept). */
export function sanitizeSiteLanguages(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= MAX_SITE_LANGUAGES) break;
    const host = normalizeSiteKey(key);
    const lang = normalizeLanguageValue(raw);
    if (!host || !lang || Object.prototype.hasOwnProperty.call(out, host)) continue;
    out[host] = lang;
    count++;
  }
  return out;
}

/** Same hosts with the same values (order ignored). */
export function siteLanguagesEqual(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] === a[k]);
}

/** `siteLanguages` with `host` set to `value` (or removed for null). Hosts beyond the cap are refused (unchanged). */
export function withSiteLanguage(
  siteLanguages: Readonly<Record<string, string>>,
  host: string,
  value: string | null,
): Record<string, string> {
  const next: Record<string, string> = { ...siteLanguages };
  if (value === null) {
    delete next[host];
    return next;
  }
  if (!Object.prototype.hasOwnProperty.call(next, host) && Object.keys(next).length >= MAX_SITE_LANGUAGES) return next;
  next[host] = value;
  return next;
}

/** What applies to a tab: its own override, else its page host's. */
export function effectiveLanguage(
  tab: string | null,
  siteLanguages: Readonly<Record<string, string>>,
  host: string | null,
): LanguageStatus {
  const site = host && Object.prototype.hasOwnProperty.call(siteLanguages, host) ? siteLanguages[host]! : null;
  const effective = tab ?? site;
  return { tab, site, host, effective, scope: tab ? 'tab' : site ? 'site' : null };
}

/** Shape check of a LanguageStatus received over a message (values re-normalized). */
export function sanitizeLanguageStatus(value: unknown): LanguageStatus | null {
  if (!isRecord(value)) return null;
  const tab = value.tab === null ? null : normalizeLanguageValue(value.tab);
  const site = value.site === null ? null : normalizeLanguageValue(value.site);
  const host = value.host === null ? null : normalizeSiteKey(value.host);
  return effectiveLanguage(tab, site && host ? { [host]: site } : {}, host);
}
