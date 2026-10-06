/**
 * Initiator analysis (pure): which code — and which UI component — made a request, from the call stack the
 * hook recorded (src/lib/stack.ts) and the source-map resolution of its frames (src/background/sources.ts).
 *
 *  - classify every frame: app code, library (node_modules / vendor chunks: axios, @tanstack/query, apollo, swr,
 *    ky, fetch polyfills…), framework internals (react-dom, scheduler, preact, vue…), browser extension, native;
 *  - initiator = the first app frame (closest to the request);
 *  - component guess = the innermost PascalCase function (React / Preact / Vue / Svelte component) of the app
 *    frames, looking at the V8 function name and at the functions enclosing the original position (effect
 *    callbacks are anonymous, so `useEffect(() => fetch(…))` inside `ReportList` is attributed to ReportList),
 *    with the innermost `use*` hook on the way;
 *  - editor links: `vscode://file/<abs path>:<line>:<col>` for absolute sources, or relative ones under a
 *    configured workspace root (`settings.editorRoot`).
 */
import type { ResolvedFrame } from '../shared/initiator-protocol';
import type { CodeExcerpt } from './sourcemap';
import type { StackFrame } from './stack';
import { parseStack } from './stack';

export type { StackFrame } from './stack';

export type FrameKind = 'app' | 'library' | 'framework' | 'extension' | 'native';

/** A frame with its classification and (when resolved) original location. */
export interface AnalyzedFrame {
  frame: StackFrame;
  kind: FrameKind;
  /** npm package (or well-known bundle) the frame belongs to, for library / framework frames. */
  library?: string;
  /** Original position (source maps). */
  original?: {
    source: string;
    /** Short path for display (webpack:// prefixes, query strings, leading ./ and ../ removed). */
    path: string;
    line: number;
    col: number;
    name?: string;
    approximate?: boolean;
  };
  /** Functions enclosing the position, innermost first. */
  enclosing: string[];
  excerpt?: CodeExcerpt;
  /** The resolution failed for this frame (why). */
  unresolved?: Extract<ResolvedFrame, { ok: false }>['reason'];
  /** The bundle line is minified (and no source map applied). */
  minified?: boolean;
}

export interface ComponentGuess {
  /** e.g. "ReportList". */
  name: string;
  /** Innermost hook between the request and the component, e.g. "useReports". */
  hook?: string;
  /** Index (in `frames`) of the frame the guess comes from. */
  frameIndex: number;
}

export interface InitiatorAnalysis {
  frames: AnalyzedFrame[];
  /** Index of the first app frame, -1 when there is none. */
  initiatorIndex: number;
  component: ComponentGuess | null;
  /** Component names found along the app frames, innermost first (unique). */
  componentNames: string[];
  /** The initiator frame is minified and could not be source-mapped. */
  minifiedWithoutMaps: boolean;
  /** At least one frame was mapped through a source map. */
  sourceMapped: boolean;
}

// --------------------------------------------------------------------------------------------- classification

/** npm packages that are UI framework internals (their frames are "framework"). */
const FRAMEWORK_PACKAGES = new Set([
  'react',
  'react-dom',
  'react-reconciler',
  'react-server-dom-webpack',
  'scheduler',
  'preact',
  'vue',
  'svelte',
  'solid-js',
  'next',
  'zone.js',
  'inferno',
  'mithril',
  'lit-html',
  'lit-element',
]);
const FRAMEWORK_SCOPES = ['@vue/', '@preact/', '@angular/', '@sveltejs/', '@remix-run/', '@builder.io/qwik'];

/** Bundle file names / paths of frameworks and vendor chunks (when no node_modules path is visible). */
const FRAMEWORK_FILES: ReadonlyArray<[RegExp, string]> = [
  [/(?:^|\/)react-dom(?:[.-][\w.-]*)?\.m?js$/i, 'react-dom'],
  [/(?:^|\/)react(?:\.development|\.production(?:\.min)?)?\.m?js$/i, 'react'],
  [/(?:^|\/)scheduler(?:[.-][\w.-]*)?\.m?js$/i, 'scheduler'],
  [/(?:^|\/)preact(?:[.-][\w.-]*)?\.m?js$/i, 'preact'],
  [/(?:^|\/)vue(?:\.runtime)?(?:\.esm-browser|\.esm-bundler|\.global|\.cjs)?(?:\.prod)?\.m?js$/i, 'vue'],
  [/(?:^|\/)runtime-(?:core|dom)(?:[.-][\w.-]*)?\.m?js$/i, 'vue'],
  [/\/_next\/static\/chunks\/(?:framework|main|webpack|polyfills)(?:-[\w]+)?\.js$/i, 'next'],
  [/(?:^|\/)zone(?:\.min)?\.js$/i, 'zone.js'],
];
const VENDOR_FILES: ReadonlyArray<[RegExp, string]> = [
  [/(?:^|\/)axios(?:\.min)?\.m?js$/i, 'axios'],
  [/(?:^|\/)jquery(?:[.-][\w.-]*)?\.js$/i, 'jquery'],
  [/(?:^|\/)(?:whatwg-fetch|unfetch|isomorphic-fetch|cross-fetch|fetch(?:-polyfill)?)(?:[.-][\w.-]*)?\.m?js$/i, 'fetch polyfill'],
  [/polyfills?(?:[.-][\w.-]*)?\.js$/i, 'polyfills'],
  [/(?:^|\/|[.~_-])(?:chunk-vendors|vendors?)(?:[.~_-][\w.~-]*)?\.m?js$/i, 'vendor bundle'],
];

/** Internal function names of React / Vue / Preact (frames of unmapped bundles). */
const FRAMEWORK_FUNCTIONS = new Set([
  'commitHookEffectListMount',
  'commitHookPassiveMountEffects',
  'commitPassiveMountOnFiber',
  'commitPassiveMountEffects',
  'recursivelyTraversePassiveMountEffects',
  'commitPassiveMountEffects_complete',
  'commitPassiveMountEffects_begin',
  'flushPassiveEffects',
  'flushPassiveEffectsImpl',
  'commitRootImpl',
  'commitRoot',
  'commitLayoutEffects',
  'commitLayoutEffectOnFiber',
  'performSyncWorkOnRoot',
  'performConcurrentWorkOnRoot',
  'performWorkOnRoot',
  'performWorkOnRootViaSchedulerTask',
  'flushSyncCallbacks',
  'flushSyncWorkAcrossRoots_impl',
  'workLoop',
  'workLoopSync',
  'workLoopConcurrent',
  'flushWork',
  'performWorkUntilDeadline',
  'renderWithHooks',
  'mountIndeterminateComponent',
  'beginWork',
  'callCallback',
  'invokeGuardedCallbackDev',
  'invokeGuardedCallback',
  'invokeGuardedCallbackAndCatchFirstError',
  'executeDispatch',
  'processDispatchQueue',
  'processDispatchQueueItemsInOrder',
  'dispatchEventForPluginEventSystem',
  'dispatchEventForPlugins',
  'batchedUpdates',
  'batchedUpdates$1',
  'dispatchDiscreteEvent',
  'dispatchEvent',
  'runWithFiberInDEV',
  'callWithErrorHandling',
  'callWithAsyncErrorHandling',
  'flushPostFlushCbs',
  'flushPreFlushCbs',
  'flushJobs',
  'queueFlush',
  'invokeWithErrorHandling',
  'callHook',
]);

/** Package name of a `node_modules` path (`@scope/name` or `name`), or null. */
export function packageOf(path: string): string | null {
  const index = path.lastIndexOf('node_modules/');
  if (index < 0) return null;
  const rest = path.slice(index + 'node_modules/'.length);
  const parts = rest.split('/');
  if (parts[0] === '.vite' || parts[0] === '.pnpm') {
    // .vite/deps/react-dom.js, .vite/deps/@tanstack_react-query.js, .pnpm/<pkg@ver>/node_modules/<pkg>
    if (parts[0] === '.vite' && parts[1] === 'deps' && parts[2]) {
      const file = parts[2].replace(/\.m?js(?:\?.*)?$/, '').replace(/^chunk-[\w]+$/, 'vendor chunk');
      return file.startsWith('@') ? file.replace('_', '/') : file.split('_')[0]!;
    }
    return null;
  }
  if (!parts[0]) return null;
  return parts[0].startsWith('@') && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
}

function isFrameworkPackage(pkg: string): boolean {
  return FRAMEWORK_PACKAGES.has(pkg) || FRAMEWORK_SCOPES.some((s) => pkg.startsWith(s));
}

function pathOfUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url.split(/[?#]/)[0]!;
  }
}

/** Last segment of a V8 function name: "Object.fetchReports" → "fetchReports", "new X" handled by the parser. */
function shortName(fn: string): string {
  const bare = fn.replace(/\s*\[as [^\]]+\]$/, '');
  const dot = bare.lastIndexOf('.');
  return dot >= 0 ? bare.slice(dot + 1) : bare;
}

/** Classify a frame from its (original, when known) location and its function name. */
export function classifyFrame(frame: StackFrame, originalSource?: string): { kind: FrameKind; library?: string } {
  if (/^(?:chrome|moz|safari-web|ms-browser|edge)-extension:\/\//i.test(frame.url)) return { kind: 'extension' };
  if (frame.native || !frame.url) return { kind: 'native' };
  const candidates = [originalSource ?? '', pathOfUrl(frame.url)].filter(Boolean);
  for (const path of candidates) {
    const clean = path.replace(/\\/g, '/');
    const pkg = packageOf(clean);
    if (pkg) return { kind: isFrameworkPackage(pkg) ? 'framework' : 'library', library: pkg };
    if (/^webpack\/(?:bootstrap|runtime)/.test(clean.replace(/^webpack:\/\/[^/]*\//, ''))) return { kind: 'framework', library: 'webpack' };
    // An original source path decides alone (app code may live in a file called vendor.js only by accident).
    if (path === originalSource) break;
    for (const [re, name] of FRAMEWORK_FILES) if (re.test(clean)) return { kind: 'framework', library: name };
    for (const [re, name] of VENDOR_FILES) if (re.test(clean)) return { kind: 'library', library: name };
  }
  if (!originalSource && FRAMEWORK_FUNCTIONS.has(shortName(frame.fn))) return { kind: 'framework' };
  return { kind: 'app' };
}

// --------------------------------------------------------------------------------------------- names

/** PascalCase names that are built-ins / library classes, never UI components. */
const NOT_COMPONENTS = new Set([
  'Object', 'Array', 'Promise', 'Function', 'Generator', 'AsyncGenerator', 'AsyncFunction', 'Module', 'Window',
  'Document', 'HTMLDocument', 'XMLHttpRequest', 'XMLHttpRequestEventTarget', 'Response', 'Request', 'Headers',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Reflect', 'Proxy', 'JSON', 'Math', 'Error', 'TypeError', 'EventTarget',
  'Element', 'HTMLElement', 'Node', 'Navigator', 'WebSocket', 'URL', 'URLSearchParams', 'Symbol', 'Number',
  'String', 'Boolean', 'Date', 'RegExp', 'MessagePort', 'Worker', 'Iterator', 'IntersectionObserver',
  'MutationObserver', 'ResizeObserver', 'AbortController', 'ReadableStream', 'FileReader', 'Image', 'Audio',
  'Axios', 'InterceptorManager', 'Query', 'QueryObserver', 'QueryClient', 'QueryCache', 'Mutation',
  'MutationCache', 'Retryer', 'ApolloClient', 'ApolloLink', 'QueryManager', 'ObservableQuery', 'Observable',
  'Subscriber', 'SafeSubscriber', 'Subject', 'HttpClient', 'HttpXhrBackend', 'Zone', 'ZoneDelegate',
  'ZoneAwarePromise', 'Timeout', 'Anonymous', 'Component', 'PureComponent', 'Fragment', 'Suspense', 'StrictMode',
  'Profiler', 'Provider', 'Consumer', 'App', 'Root',
]);

/** A UI component name: PascalCase, ≥ 2 characters with a lower-case letter, not a built-in / library class. */
export function isComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*[a-z][A-Za-z0-9_$]*$/.test(name) && !NOT_COMPONENTS.has(name) && !/(?:Element|Event|Error)$/.test(name);
}

/** `App` and `Root` are components too, but too generic to be the innermost guess. */
function isWeakComponentName(name: string): boolean {
  return name === 'App' || name === 'Root';
}

/** A hook name: `use` + upper-case letter / digit. */
export function isHookName(name: string): boolean {
  return /^use[A-Z0-9][\w$]*$/.test(name);
}

/** Candidate names of a frame, innermost first: enclosing functions (original source), then the V8 name parts. */
function frameNames(f: AnalyzedFrame): string[] {
  const names: string[] = [];
  const push = (n: string | undefined) => {
    if (n && !names.includes(n)) names.push(n);
  };
  const bare = f.frame.fn.replace(/\s*\[as [^\]]+\]$/, '');
  const parts = bare.split('.').filter((p) => p && p !== '<anonymous>' && p !== '<computed>');
  // V8's name is the innermost function (`ReportList.componentDidMount`: method, then class).
  for (let i = parts.length - 1; i >= 0; i--) push(parts[i]);
  for (const n of f.enclosing) push(n);
  return names;
}

// --------------------------------------------------------------------------------------------- analysis

/**
 * Analyze a recorded stack with the resolution of its frames (`resolved[i]` belongs to the i-th frame of
 * `parseStack(stack)`; missing / null entries = not resolved).
 */
export function analyzeInitiator(stack: string, resolved: ReadonlyArray<ResolvedFrame | null | undefined> = []): InitiatorAnalysis {
  const parsed = parseStack(stack);
  const frames: AnalyzedFrame[] = parsed.map((frame, i) => {
    const r = resolved[i];
    const analyzed: AnalyzedFrame = { frame, kind: 'app', enclosing: [] };
    if (r && r.ok) {
      analyzed.original = { source: r.source, path: displayPath(r.source), line: r.line, col: r.col };
      if (r.name) analyzed.original.name = r.name;
      if (r.approximate) analyzed.original.approximate = true;
    } else if (r && !r.ok) {
      analyzed.unresolved = r.reason;
      if (r.minified) analyzed.minified = true;
    }
    if (r?.enclosing) analyzed.enclosing = r.enclosing.filter((n) => typeof n === 'string').slice(0, 8);
    if (r?.excerpt) analyzed.excerpt = r.excerpt;
    const cls = classifyFrame(frame, analyzed.original?.source);
    analyzed.kind = cls.kind;
    if (cls.library) analyzed.library = cls.library;
    return analyzed;
  });
  const initiatorIndex = frames.findIndex((f) => f.kind === 'app');
  const componentNames: string[] = [];
  let component: ComponentGuess | null = null;
  let weak: ComponentGuess | null = null;
  let hook: string | undefined;
  for (let index = 0; index < frames.length; index++) {
    const f = frames[index]!;
    if (f.kind !== 'app') continue;
    for (const name of frameNames(f)) {
      if (isHookName(name)) {
        if (!component && !hook) hook = name;
        continue;
      }
      if (!isComponentName(name) && !isWeakComponentName(name)) continue;
      if (!componentNames.includes(name)) componentNames.push(name);
      if (isWeakComponentName(name)) {
        if (!weak) weak = { name, frameIndex: index };
        continue;
      }
      if (!component) component = { name, frameIndex: index };
    }
  }
  const guess: ComponentGuess | null = component ?? weak;
  if (guess && hook) guess.hook = hook;
  const initiator = initiatorIndex >= 0 ? frames[initiatorIndex] : undefined;
  return {
    frames,
    initiatorIndex,
    component: guess,
    componentNames,
    minifiedWithoutMaps: !!initiator && !initiator.original && initiator.minified === true,
    sourceMapped: frames.some((f) => !!f.original),
  };
}

/** Display rows of a stack: app frames one by one, consecutive other frames collapsed into one group. */
export type FrameRow =
  | { type: 'frame'; index: number }
  | { type: 'group'; indices: number[]; libraries: string[] };

export function groupFrames(frames: readonly AnalyzedFrame[]): FrameRow[] {
  const rows: FrameRow[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (f.kind === 'app') {
      rows.push({ type: 'frame', index: i });
      continue;
    }
    const last = rows[rows.length - 1];
    if (last && last.type === 'group') {
      last.indices.push(i);
      if (f.library && !last.libraries.includes(f.library)) last.libraries.push(f.library);
    } else rows.push({ type: 'group', indices: [i], libraries: f.library ? [f.library] : [] });
  }
  return rows;
}

// --------------------------------------------------------------------------------------------- paths

/** Short display path of a source / script URL ("webpack://app/./src/x.tsx?abc" → "src/x.tsx"). */
export function displayPath(source: string): string {
  let s = source.trim();
  s = s.replace(/^webpack-internal:\/\/\/(?:\([^)]*\)\/)?/, '');
  s = s.replace(/^webpack:\/\/[^/]*\//, '');
  s = s.replace(/^(?:rollup|vite|turbopack|ng|sveltekit):\/\/[^/]*\//, '');
  if (/^file:\/\//i.test(s)) {
    try {
      s = decodeURIComponent(new URL(s).pathname);
    } catch {
      s = s.replace(/^file:\/\//i, '');
    }
  } else if (/^https?:\/\//i.test(s)) {
    try {
      s = decodeURIComponent(new URL(s).pathname);
    } catch {
      /* keep */
    }
  }
  s = s.split(/[?#]/)[0]!;
  s = s.replace(/^\/@fs\//, '/');
  while (s.startsWith('./') || s.startsWith('../')) s = s.slice(s.startsWith('./') ? 2 : 3);
  return s || source;
}

/** First path segments that make a POSIX path a file-system path (not a URL path like "/src/App.tsx"). */
const FS_ROOTS = /^\/(?:Users|home|var|opt|private|tmp|mnt|srv|root|Volumes|usr|workspace|workspaces|data|build|code|projects)\//;

function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * Absolute file-system path of a source for the editor, or null. Absolute paths (file://, Windows drive,
 * /Users/…, /home/…, Vite's /@fs/…) are used as they are; anything else needs `editorRoot` (the folder the
 * bundler's paths are relative to, e.g. the project root): "webpack://app/./src/x.tsx" → "<root>/src/x.tsx".
 */
export function editorPath(source: string, editorRoot: string): string | null {
  let p = source.trim();
  if (!p) return null;
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      return null;
    }
    return (/^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p).replace(/\\/g, '/');
  }
  // Old webpack: "webpack:///Users/me/app/src/x.js" / "webpack:///C:/app/src/x.js".
  const webpackAbs = /^webpack:\/\/(\/(?!\.).*)$/.exec(p);
  if (webpackAbs) p = /^\/[A-Za-z]:/.test(webpackAbs[1]!) ? webpackAbs[1]!.slice(1) : webpackAbs[1]!;
  // Vite serves files outside the root as /@fs/<abs path>.
  const fsIndex = p.indexOf('/@fs/');
  if (fsIndex >= 0) return p.slice(fsIndex + 4).split(/[?#]/)[0]!;
  const bare = p.split(/[?#]/)[0]!;
  if (isWindowsPath(bare)) return bare.replace(/\\/g, '/');
  if (bare.startsWith('/') && FS_ROOTS.test(bare)) return bare;
  const root = editorRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root) return null;
  const rel = displayPath(p).replace(/^\/+/, '');
  if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel)) return null;
  return `${root}/${rel}`;
}

/** `vscode://file/<abs path>:<line>:<col>` for a source position, or null (see editorPath). */
export function vscodeUrl(source: string, line: number, col: number, editorRoot: string): string | null {
  const path = editorPath(source, editorRoot);
  if (!path) return null;
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  const position = line > 0 ? `:${line}${col > 0 ? `:${col}` : ''}` : '';
  return `vscode://file${encodeURI(withSlash)}${position}`;
}

/** "file.tsx:12:5" style location of a frame's original (else bundle) position. */
export function locationText(f: AnalyzedFrame): string {
  if (f.original) return `${f.original.path}:${f.original.line}:${f.original.col}`;
  return bundleLocation(f.frame);
}

/** "app.js:1:2345" style bundle location (file name of the script URL). */
export function bundleLocation(frame: StackFrame): string {
  if (!frame.url) return frame.raw.replace(/^at\s+/, '');
  const path = pathOfUrl(frame.url);
  const file = path.split('/').filter(Boolean).pop() ?? frame.url;
  return `${file}${frame.line ? `:${frame.line}` : ''}${frame.col ? `:${frame.col}` : ''}`;
}

/** A function name for display ("(anonymous)" when none). */
export function functionLabel(f: AnalyzedFrame): string {
  // An anonymous callback called as `obj.__()` (mangled internals, e.g. Preact's effect slots) is printed by V8
  // with the property name: no help to the reader.
  const last = shortName(f.frame.fn);
  const internal = last === '<anonymous>' || /^_{1,2}[A-Za-z]{0,2}$/.test(last);
  const fn = f.frame.fn && !internal ? f.frame.fn : '';
  const prefix = `${f.frame.async ? 'async ' : ''}${f.frame.ctor ? 'new ' : ''}`;
  if (fn) return prefix + fn;
  const outer = f.enclosing[0];
  return outer ? `${prefix}(anonymous in ${outer})` : `${prefix}(anonymous)`;
}
