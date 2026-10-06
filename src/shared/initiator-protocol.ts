/**
 * Initiator tab protocol ("which component is consuming this endpoint", docs/ARCHITECTURE.md §10).
 *
 *  hook.js (MAIN)   records `Error().stack` at fetch / XHR.send / sendBeacon / new WebSocket while capturing
 *                   → HookRequestStart.initiatorStack → RequestEntry.initiatorStack (capped by content.js)
 *  panel            parses + classifies the stack (src/lib/initiator.ts)
 *  panel ──RESOLVE_INITIATOR──► service worker: fetches the scripts and their source maps (host permissions,
 *                   cached), maps bundle positions to original source / line / column / name + an excerpt
 *  panel ──Port call locateComponents──► frame host (ui.js) ──bridge──► content.js ──private port──► hook.js:
 *                   walks the React / Preact / Vue tree for the component names, returns instance rects + paths;
 *                   ui.js draws the temporary highlight boxes. Only ever started by the panel (user action).
 */
import type { CodeExcerpt } from '../lib/sourcemap';

// ------------------------------------------------------------------------------------------------ source maps

/** One stack frame position to resolve (1-based, as printed in V8 stacks). */
export interface ResolveFrameRequest {
  url: string;
  line: number;
  col: number;
}

export type ResolveFailure =
  /** Not an http(s) / data URL (extension, eval, blob…). */
  | 'unsupported-url'
  /** The script (or its map) could not be fetched. */
  | 'fetch-failed'
  /** Over the size cap. */
  | 'too-large'
  /** The script has no sourceMappingURL / SourceMap header. */
  | 'no-map'
  /** The map is not valid JSON / v3. */
  | 'bad-map'
  /** The map has no mapping for this position. */
  | 'no-mapping';

/** Result for one frame. `excerpt` / `enclosing` come from the original source when mapped, else the bundle. */
export type ResolvedFrame =
  | {
      ok: true;
      /** Source path as listed in the map (sourceRoot applied), e.g. "webpack://app/./src/ReportList.tsx". */
      source: string;
      /** 1-based. */
      line: number;
      col: number;
      /** Identifier at the position (map `names`). */
      name?: string;
      /** Functions enclosing the position, innermost first (heuristic on sourcesContent). */
      enclosing?: string[];
      excerpt?: CodeExcerpt;
      approximate?: boolean;
    }
  | {
      ok: false;
      reason: ResolveFailure;
      detail?: string;
      /** The generated line is very long (minified bundle). */
      minified?: boolean;
      enclosing?: string[];
      excerpt?: CodeExcerpt;
    };

/** Most frames resolved per request. */
export const RESOLVE_MAX_FRAMES = 48;
/** Largest script / source map fetched (bytes). */
export const SOURCE_FETCH_MAX_BYTES = 20 * 1024 * 1024;
/** Fetch timeout for a script or map. */
export const SOURCE_FETCH_TIMEOUT_MS = 15_000;

/** Answer of RESOLVE_INITIATOR. */
export type ResolveInitiatorResponse = { ok: true; frames: ResolvedFrame[] } | { ok: false; error: string };

// ------------------------------------------------------------------------------------------------ components

/** A rect in viewport CSS px of the top frame. */
export interface ComponentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the panel asks the page for (names from the stack, innermost first). */
export interface ComponentQuery {
  names: string[];
  /** Scroll the first instance of the first found name into view (before measuring). */
  scroll: boolean;
  /** Draw the temporary highlight (frame host, after the hook answered). */
  highlight: boolean;
}

export type ComponentFramework = 'react' | 'preact' | 'vue';

export interface ComponentInstance {
  /** Component names from the root down to this instance (named components only). */
  path: string[];
  /** Union of the instance's host elements; null when it renders nothing visible. */
  rect: ComponentRect | null;
}

export interface ComponentMatch {
  name: string;
  /** Instances on the page (may exceed `instances.length`). */
  count: number;
  instances: ComponentInstance[];
}

export interface ComponentLocateResult {
  /** Frameworks whose trees were found on the page. */
  frameworks: ComponentFramework[];
  /** One entry per queried name, same order. */
  matches: ComponentMatch[];
  /** Boxes drawn by the frame host (highlight queries). */
  highlighted?: number;
  error?: string;
}

/** Limits of a query / result (also enforced on the untrusted MAIN-world answer). */
export const COMPONENT_MAX_NAMES = 8;
export const COMPONENT_NAME_MAX = 200;
export const COMPONENT_MAX_INSTANCES = 50;
export const COMPONENT_PATH_MAX = 40;
/** The hook's answer is given up after this. */
export const COMPONENT_LOCATE_TIMEOUT_MS = 4_000;
/** Tag of the page-side highlight layer (ui.js). */
export const HIGHLIGHT_LAYER_TAG = 'reqlens-highlight-layer';
/** The highlight disappears by itself after this (or on Esc / a new query). */
export const HIGHLIGHT_DURATION_MS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const NAME_RE = /^[A-Za-z_$][\w$.()-]*$/;

/** A clean query (names deduplicated, identifier-like, bounded). */
export function sanitizeComponentQuery(value: unknown): ComponentQuery {
  const q = isRecord(value) ? value : {};
  const names: string[] = [];
  if (Array.isArray(q.names)) {
    for (const n of q.names) {
      if (names.length >= COMPONENT_MAX_NAMES) break;
      if (typeof n === 'string' && n.length <= COMPONENT_NAME_MAX && NAME_RE.test(n) && !names.includes(n)) names.push(n);
    }
  }
  return { names, scroll: q.scroll === true, highlight: q.highlight === true };
}

function sanitizeRect(value: unknown): ComponentRect | null {
  if (!isRecord(value) || !finite(value.x) || !finite(value.y) || !finite(value.width) || !finite(value.height)) return null;
  const clamp = (n: number) => Math.max(-1e7, Math.min(1e7, n));
  return { x: clamp(value.x), y: clamp(value.y), width: Math.max(0, clamp(value.width)), height: Math.max(0, clamp(value.height)) };
}

const FRAMEWORKS: readonly ComponentFramework[] = ['react', 'preact', 'vue'];

/**
 * Rebuild a locate result from untrusted MAIN-world data: only the queried names, bounded lists, text-only
 * names, finite rects.
 */
export function sanitizeComponentLocateResult(value: unknown, query: ComponentQuery): ComponentLocateResult {
  const v = isRecord(value) ? value : {};
  const frameworks = Array.isArray(v.frameworks)
    ? FRAMEWORKS.filter((f) => (v.frameworks as unknown[]).includes(f))
    : [];
  const given = Array.isArray(v.matches) ? v.matches : [];
  const matches: ComponentMatch[] = query.names.map((name) => {
    const m = given.find((x): x is Record<string, unknown> => isRecord(x) && x.name === name);
    if (!m) return { name, count: 0, instances: [] };
    const instances: ComponentInstance[] = [];
    if (Array.isArray(m.instances)) {
      for (const inst of m.instances.slice(0, COMPONENT_MAX_INSTANCES)) {
        if (!isRecord(inst)) continue;
        const path = Array.isArray(inst.path)
          ? inst.path
              .filter((p): p is string => typeof p === 'string')
              .slice(-COMPONENT_PATH_MAX)
              .map((p) => p.slice(0, COMPONENT_NAME_MAX))
          : [];
        instances.push({ path, rect: sanitizeRect(inst.rect) });
      }
    }
    const count = finite(m.count) ? Math.max(instances.length, Math.min(1e6, Math.floor(m.count))) : instances.length;
    return { name, count, instances };
  });
  const result: ComponentLocateResult = { frameworks, matches };
  if (typeof v.error === 'string') result.error = v.error.slice(0, 500);
  return result;
}
