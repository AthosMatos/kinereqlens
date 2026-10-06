import { describe, expect, it } from 'vitest';
import { transformSync } from 'esbuild';
import {
  analyzeInitiator,
  bundleLocation,
  classifyFrame,
  displayPath,
  editorPath,
  functionLabel,
  groupFrames,
  isComponentName,
  isHookName,
  locationText,
  packageOf,
  vscodeUrl,
} from '../../src/lib/initiator';
import { parseStackLine } from '../../src/lib/stack';
import type { ResolvedFrame } from '../../src/shared/initiator-protocol';
import { SourceResolver } from '../../src/background/sources';
import { stackText } from '../../src/ui/detail/InitiatorPanel';
import { resolveStack } from '../../src/ui/detail/initiatorState';

const frame = (line: string) => parseStackLine(line)!;

describe('classifyFrame', () => {
  it('tells app, library, framework, extension and native frames apart', () => {
    expect(classifyFrame(frame('at load (http://localhost:3000/src/api.ts:1:1)'))).toEqual({ kind: 'app' });
    expect(classifyFrame(frame('at dispatchXhrRequest (http://localhost:3000/node_modules/axios/lib/adapters/xhr.js:9:1)'))).toEqual({ kind: 'library', library: 'axios' });
    expect(classifyFrame(frame('at x (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js:9:1)'))).toEqual({ kind: 'framework', library: 'react-dom' });
    expect(classifyFrame(frame('at x (http://localhost:5173/node_modules/.vite/deps/@tanstack_react-query.js:9:1)'))).toEqual({ kind: 'library', library: '@tanstack/react-query' });
    expect(classifyFrame(frame('at x (https://cdn.test/_next/static/chunks/framework-2c79e2a64abdb08b.js:9:1)'))).toEqual({ kind: 'framework', library: 'next' });
    expect(classifyFrame(frame('at x (https://cdn.test/static/js/vendors~main.chunk.js:1:1)'))).toEqual({ kind: 'library', library: 'vendor bundle' });
    expect(classifyFrame(frame('at x (https://cdn.test/js/chunk-vendors.4f2a.js:1:1)'))).toEqual({ kind: 'library', library: 'vendor bundle' });
    expect(classifyFrame(frame('at x (https://unpkg.com/react-dom@18/umd/react-dom.development.js:1:1)'))).toEqual({ kind: 'framework', library: 'react-dom' });
    expect(classifyFrame(frame('at x (chrome-extension://abc/content.js:1:1)'))).toEqual({ kind: 'extension' });
    expect(classifyFrame(frame('at Array.map (<anonymous>)'))).toEqual({ kind: 'native' });
    // Unmapped bundle: React internals recognised by name.
    expect(classifyFrame(frame('at commitHookEffectListMount (https://x.test/main.js:1:1)'))).toEqual({ kind: 'framework' });
  });

  it('prefers the original source path of a mapped frame', () => {
    const f = frame('at a (https://x.test/main.js:1:100)');
    expect(classifyFrame(f, 'webpack://app/./node_modules/@apollo/client/core/QueryManager.js')).toEqual({ kind: 'library', library: '@apollo/client' });
    expect(classifyFrame(f, 'webpack://app/./node_modules/swr/dist/index.mjs')).toEqual({ kind: 'library', library: 'swr' });
    expect(classifyFrame(f, '../node_modules/preact/hooks/dist/hooks.module.js')).toEqual({ kind: 'framework', library: 'preact' });
    expect(classifyFrame(f, 'webpack://app/./src/vendor.js')).toEqual({ kind: 'app' });
    expect(classifyFrame(f, 'webpack://app/webpack/bootstrap')).toEqual({ kind: 'framework', library: 'webpack' });
  });

  it('extracts package names', () => {
    expect(packageOf('/x/node_modules/ky/distribution/index.js')).toBe('ky');
    expect(packageOf('/x/node_modules/@tanstack/query-core/build/x.js')).toBe('@tanstack/query-core');
    expect(packageOf('/x/node_modules/.pnpm/a@1/node_modules/whatwg-fetch/fetch.js')).toBe('whatwg-fetch');
    expect(packageOf('/src/app.js')).toBeNull();
  });
});

describe('names', () => {
  it('recognises components and hooks', () => {
    expect(isComponentName('ReportList')).toBe(true);
    expect(isComponentName('A')).toBe(false);
    expect(isComponentName('XMLHttpRequest')).toBe(false);
    expect(isComponentName('Promise')).toBe(false);
    expect(isComponentName('HTMLButtonElement')).toBe(false);
    expect(isComponentName('fetchData')).toBe(false);
    expect(isComponentName('URL')).toBe(false);
    expect(isHookName('useReports')).toBe(true);
    expect(isHookName('user')).toBe(false);
  });
});

const STACK = [
  'at loadReports (https://app.test/static/main.js:10:5)',
  'at https://app.test/static/main.js:20:9',
  'at commitHookEffectListMount (https://app.test/static/vendor.js:1:500)',
  'at flushPassiveEffects (https://app.test/static/vendor.js:1:900)',
  'at async ReportsPage (https://app.test/static/main.js:30:3)',
].join('\n');

describe('analyzeInitiator', () => {
  it('without resolution: initiator = first app frame, component from V8 names', () => {
    const a = analyzeInitiator(STACK);
    expect(a.frames.map((f) => f.kind)).toEqual(['app', 'app', 'library', 'library', 'app']);
    expect(a.initiatorIndex).toBe(0);
    expect(a.component).toEqual({ name: 'ReportsPage', frameIndex: 4 });
    expect(a.componentNames).toEqual(['ReportsPage']);
    expect(a.sourceMapped).toBe(false);
    expect(a.minifiedWithoutMaps).toBe(false);
  });

  it('with source maps: original paths, enclosing component of an anonymous effect, hook on the way', () => {
    const resolved: Array<ResolvedFrame | null> = [
      { ok: true, source: 'webpack://app/./src/hooks/useReports.ts', line: 4, col: 10, enclosing: ['loadReports', 'useReports'] },
      { ok: true, source: 'webpack://app/./src/ReportList.tsx', line: 12, col: 7, enclosing: ['ReportList'], excerpt: { startLine: 10, lines: ['a', 'b', 'c'], line: 12, column: 7 } },
      { ok: true, source: 'webpack://app/./node_modules/react-dom/cjs/react-dom.development.js', line: 1, col: 1 },
      { ok: false, reason: 'no-mapping' },
      { ok: true, source: 'webpack://app/./src/ReportsPage.tsx', line: 3, col: 1, enclosing: ['ReportsPage'] },
    ];
    const a = analyzeInitiator(STACK, resolved);
    expect(a.frames.map((f) => f.kind)).toEqual(['app', 'app', 'framework', 'library', 'app']);
    expect(a.component).toEqual({ name: 'ReportList', hook: 'useReports', frameIndex: 1 });
    expect(a.componentNames).toEqual(['ReportList', 'ReportsPage']);
    expect(a.sourceMapped).toBe(true);
    expect(locationText(a.frames[1]!)).toBe('src/ReportList.tsx:12:7');
    expect(functionLabel(a.frames[1]!)).toBe('(anonymous in ReportList)');
    expect(functionLabel({ ...a.frames[1]!, frame: { ...a.frames[1]!.frame, fn: 'Object.__' } })).toBe('(anonymous in ReportList)');
    expect(functionLabel(a.frames[0]!)).toBe('loadReports');
    expect(bundleLocation(a.frames[1]!.frame)).toBe('main.js:20:9');
    expect(groupFrames(a.frames)).toEqual([
      { type: 'frame', index: 0 },
      { type: 'frame', index: 1 },
      { type: 'group', indices: [2, 3], libraries: ['react-dom', 'vendor bundle'] },
      { type: 'frame', index: 4 },
    ]);
    expect(stackText(a).split('\n')[1]).toBe('    at (src/ReportList.tsx:12:7) [https://app.test/static/main.js:20:9]');
  });

  it('flags minified code without source maps', () => {
    const a = analyzeInitiator('at a (https://app.test/m.js:1:4000)', [{ ok: false, reason: 'no-map', minified: true }]);
    expect(a.minifiedWithoutMaps).toBe(true);
    expect(a.component).toBeNull();
  });

  it('falls back to App when it is the only component, and ignores library class names', () => {
    const a = analyzeInitiator(['at Query.fetch (https://x.test/node_modules/@tanstack/query-core/build/query.js:1:1)', 'at App (https://x.test/src/App.jsx:3:3)'].join('\n'));
    expect(a.component).toEqual({ name: 'App', frameIndex: 1 });
  });

  it('handles class components (method names) and empty stacks', () => {
    expect(analyzeInitiator('at ReportList.componentDidMount (https://x.test/src/a.js:1:1)').component?.name).toBe('ReportList');
    const empty = analyzeInitiator('');
    expect(empty).toMatchObject({ frames: [], initiatorIndex: -1, component: null });
  });
});

describe('paths and VS Code links', () => {
  it('shortens source paths for display', () => {
    expect(displayPath('webpack://my-app/./src/components/ReportList.tsx?abc')).toBe('src/components/ReportList.tsx');
    expect(displayPath('webpack-internal:///(app-pages-browser)/./src/x.ts')).toBe('src/x.ts');
    expect(displayPath('../../src/ReportList.jsx')).toBe('src/ReportList.jsx');
    expect(displayPath('http://localhost:5173/src/App.tsx?t=1')).toBe('/src/App.tsx');
    expect(displayPath('file:///Users/me/app/src/a%20b.ts')).toBe('/Users/me/app/src/a b.ts');
  });

  it('links absolute paths directly and relative ones under the workspace root', () => {
    expect(vscodeUrl('file:///Users/me/app/src/a.ts', 12, 5, '')).toBe('vscode://file/Users/me/app/src/a.ts:12:5');
    expect(vscodeUrl('/home/dev/app/src/a.ts', 3, 0, '')).toBe('vscode://file/home/dev/app/src/a.ts:3');
    expect(vscodeUrl('webpack:///Users/me/app/src/a.js', 1, 2, '')).toBe('vscode://file/Users/me/app/src/a.js:1:2');
    expect(vscodeUrl('http://localhost:5173/@fs/Users/me/lib/x.ts', 1, 1, '')).toBe('vscode://file/Users/me/lib/x.ts:1:1');
    expect(vscodeUrl('C:\\work\\app\\src\\a.ts', 7, 1, '')).toBe('vscode://file/C:/work/app/src/a.ts:7:1');
    expect(vscodeUrl('webpack://app/./src/ReportList.tsx', 12, 7, '')).toBeNull();
    expect(vscodeUrl('webpack://app/./src/ReportList.tsx', 12, 7, '/Users/me/my app/')).toBe('vscode://file/Users/me/my%20app/src/ReportList.tsx:12:7');
    expect(vscodeUrl('/src/App.tsx?t=1', 2, 3, '/Users/me/app')).toBe('vscode://file/Users/me/app/src/App.tsx:2:3');
    expect(vscodeUrl('../../tests/fixture/ReportList.jsx', 9, 1, 'C:\\proj')).toBe('vscode://file/C:/proj/tests/fixture/ReportList.jsx:9:1');
    expect(editorPath('', '/x')).toBeNull();
    expect(editorPath('https://cdn.test/', '/x')).toBeNull();
  });
});

describe('SourceResolver (worker)', () => {
  const original = ['export function ReportList() {', '  useEffect(() => {', "    fetch('/api/reports');", '  }, []);', '}'].join('\n');
  const built = transformSync(original, { loader: 'js', sourcemap: 'external', sourcefile: 'src/ReportList.jsx', format: 'esm', minify: true });
  const bundle = `${built.code}//# sourceMappingURL=app.js.map\n`;
  const fetchCol = bundle.indexOf('fetch(') + 1;

  function resolver(files: Record<string, string>, log: Array<{ url: string; credentials: string }> = []) {
    return new SourceResolver({
      now: () => 0,
      fetchText: async (url, opts) => {
        log.push({ url, credentials: opts.credentials });
        if (!(url in files)) throw new Error('HTTP 404');
        return { text: files[url]!, mapHeader: null };
      },
    });
  }

  it('fetches the script and its map once, maps the position and returns an excerpt + enclosing names', async () => {
    const log: Array<{ url: string; credentials: string }> = [];
    const r = resolver({ 'https://app.test/js/app.js': bundle, 'https://app.test/js/app.js.map': built.map }, log);
    const [res] = await r.resolve([{ url: 'https://app.test/js/app.js', line: 1, col: fetchCol }], 'https://app.test/page');
    expect(res).toMatchObject({ ok: true, source: 'src/ReportList.jsx', line: 3, col: 5, enclosing: ['ReportList'] });
    expect(res!.ok && res!.excerpt?.lines[2]).toBe("    fetch('/api/reports');");
    await r.resolve([{ url: 'https://app.test/js/app.js', line: 1, col: fetchCol }], 'https://app.test/page');
    expect(log).toEqual([
      { url: 'https://app.test/js/app.js', credentials: 'include' },
      { url: 'https://app.test/js/app.js.map', credentials: 'include' },
    ]);
  });

  it('omits credentials cross-origin and reports missing maps / failures', async () => {
    const log: Array<{ url: string; credentials: string }> = [];
    const plain = 'function load() {\n  fetch("/x");\n}\n';
    const r = resolver({ 'https://cdn.test/a.js': plain, 'https://cdn.test/b.js': `x();\n//# sourceMappingURL=b.js.map` }, log);
    const out = await r.resolve(
      [
        { url: 'https://cdn.test/a.js', line: 2, col: 3 },
        { url: 'https://cdn.test/b.js', line: 1, col: 1 },
        { url: 'https://cdn.test/missing.js', line: 1, col: 1 },
        { url: 'chrome-extension://x/a.js', line: 1, col: 1 },
      ],
      'https://app.test/',
    );
    expect(out[0]).toMatchObject({ ok: false, reason: 'no-map', enclosing: ['load'] });
    expect(out[1]).toMatchObject({ ok: false, reason: 'fetch-failed' });
    expect(out[2]).toMatchObject({ ok: false, reason: 'fetch-failed' });
    expect(out[3]).toMatchObject({ ok: false, reason: 'unsupported-url' });
    expect(log.every((l) => l.credentials === 'omit')).toBe(true);
  });

  it('reads inline data: maps', async () => {
    const inline = transformSync(original, { loader: 'js', sourcemap: 'inline', sourcefile: 'src/Inline.jsx', format: 'esm' }).code;
    const r = resolver({ 'https://app.test/i.js': inline });
    const lines = inline.split('\n');
    const line = lines.findIndex((l) => l.includes('fetch('));
    const [res] = await r.resolve([{ url: 'https://app.test/i.js', line: line + 1, col: lines[line]!.indexOf('fetch(') + 1 }], 'https://app.test/');
    expect(res).toMatchObject({ ok: true, source: 'src/Inline.jsx', line: 3, enclosing: ['ReportList'] });
  });

  it('resolveStack maps results back to the stack frames by index', async () => {
    const stack = ['at Array.map (<anonymous>)', `at https://app.test/js/app.js:1:${fetchCol}`].join('\n');
    const calls: unknown[] = [];
    const { resolved } = await resolveStack(stack, 'https://app.test/', async (frames, pageUrl) => {
      calls.push({ frames, pageUrl });
      return { ok: true, frames: frames.map((): ResolvedFrame => ({ ok: true, source: 's.js', line: 1, col: 1 })) };
    });
    expect(calls).toEqual([{ frames: [{ url: 'https://app.test/js/app.js', line: 1, col: fetchCol }], pageUrl: 'https://app.test/' }]);
    expect(resolved[0]).toBeNull();
    expect(resolved[1]).toMatchObject({ ok: true, source: 's.js' });
  });
});
