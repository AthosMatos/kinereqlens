import { describe, expect, it } from 'vitest';
import { build, transformSync } from 'esbuild';
import type { Plugin } from 'esbuild';
import {
  decodeDataUrl,
  decodeMappings,
  decodeVlq,
  encodeVlq,
  enclosingFunctionNames,
  excerptAround,
  findSourceMappingUrl,
  lineStartsOf,
  looksMinified,
  SourceMapConsumer,
} from '../../src/lib/sourcemap';

/** 0-based line / column of the first occurrence of `needle`. */
function positionOf(text: string, needle: string, from = 0): { line: number; column: number } {
  const index = text.indexOf(needle, from);
  if (index < 0) throw new Error(`not found: ${needle}`);
  const before = text.slice(0, index).split('\n');
  return { line: before.length - 1, column: before[before.length - 1]!.length };
}

describe('VLQ', () => {
  it('decodes known values from the spec / real maps', () => {
    expect(decodeVlq('AAAA')).toEqual([0, 0, 0, 0]);
    expect(decodeVlq('AACA')).toEqual([0, 0, 1, 0]);
    expect(decodeVlq('AAgBC')).toEqual([0, 0, 16, 1]);
    expect(decodeVlq('D')).toEqual([-1]);
    expect(decodeVlq('gB')).toEqual([16]);
    expect(decodeVlq('2H')).toEqual([123]);
    expect(decodeVlq('+/D')).toEqual([2047]);
    expect(decodeVlq('F')).toEqual([-2]);
  });

  it('round-trips encode / decode, including big and negative numbers', () => {
    const values = [0, 1, -1, 15, 16, -16, 31, 32, 1000, -1000, 123456, -987654, 2 ** 30];
    expect(decodeVlq(encodeVlq(values))).toEqual(values);
  });

  it('rejects invalid and truncated input', () => {
    expect(() => decodeVlq('A!')).toThrow();
    expect(() => decodeVlq('g')).toThrow();
  });
});

describe('decodeMappings', () => {
  it('reconstructs absolute positions across lines and segments', () => {
    // line 0: col 0 → src 0 line 0 col 0; col 4 → same line col 4 with name 0
    // line 1: (empty)
    // line 2: col 2 → src 0 line 1 col 0; col 3 unmapped segment
    const mappings = `${encodeVlq([0, 0, 0, 0])},${encodeVlq([4, 0, 0, 4, 0])};;${encodeVlq([2, 0, 1, -4])},${encodeVlq([1])}`;
    const d = decodeMappings(mappings);
    expect(Array.from(d.lineStarts)).toEqual([0, 2, 2, 4]);
    expect(Array.from(d.segments)).toEqual([0, 0, 0, 0, -1, 4, 0, 0, 4, 0, 2, 0, 1, 0, -1, 3, -1, -1, -1, -1]);
  });

  it('looks positions up (greatest column ≤ target, unmapped skipped)', () => {
    const map = SourceMapConsumer.parse({
      version: 3,
      sources: ['a.ts'],
      sourceRoot: 'webpack://app/',
      names: ['fetchReports'],
      sourcesContent: ['line0\nline1'],
      mappings: `${encodeVlq([0, 0, 0, 0])},${encodeVlq([4, 0, 0, 4, 0])};;${encodeVlq([2, 0, 1, -4])},${encodeVlq([1])}`,
    });
    expect(map.originalPositionFor(0, 6)).toMatchObject({ source: 'webpack://app/a.ts', line: 0, column: 4, name: 'fetchReports' });
    expect(map.originalPositionFor(0, 1)).toMatchObject({ line: 0, column: 0 });
    expect(map.originalPositionFor(0, 1)?.name).toBeUndefined();
    expect(map.originalPositionFor(1, 0)).toBeNull();
    expect(map.originalPositionFor(2, 9)).toMatchObject({ line: 1, column: 0, content: 'line0\nline1' });
    expect(map.originalPositionFor(2, 0)).toMatchObject({ line: 1, column: 0, approximate: true });
    expect(map.originalPositionFor(9, 0)).toBeNull();
  });

  it('maps an esbuild-generated bundle back to the original TypeScript', () => {
    const source = [
      "import { useEffect } from './hooks';",
      '',
      'export function ReportList(props: { id: string }) {',
      '  useEffect(() => {',
      "    fetch('/api/reports?id=' + props.id).then((r) => r.json());",
      '  }, []);',
      '  return null;',
      '}',
    ].join('\n');
    const out = transformSync(source, { loader: 'ts', sourcemap: 'external', sourcefile: 'src/ReportList.tsx', format: 'esm' });
    const map = SourceMapConsumer.parse(out.map);
    const gen = positionOf(out.code, 'fetch(');
    const pos = map.originalPositionFor(gen.line, gen.column);
    expect(pos).toMatchObject({ source: 'src/ReportList.tsx', line: 4, column: 4 });
    expect(pos?.content).toBe(source);
    // The function enclosing the original call, past the anonymous effect callback.
    expect(enclosingFunctionNames(source, pos!.line, pos!.column)).toEqual(['ReportList']);
  });

  it('maps a minified bundle with names', () => {
    const source = 'function loadReportsFromServer(id) {\n  return fetch("/r/" + id);\n}\nwindow.go = loadReportsFromServer;\n';
    const out = transformSync(source, { loader: 'js', sourcemap: 'external', sourcefile: 'api.js', minify: true });
    const map = SourceMapConsumer.parse(out.map);
    const gen = positionOf(out.code, 'fetch(');
    expect(map.originalPositionFor(gen.line, gen.column)).toMatchObject({ source: 'api.js', line: 1, column: 9 });
  });

  it('handles bundles with several sources (esbuild build, inline sourcesContent)', async () => {
    const files: Record<string, string> = {
      '/v/api.js': 'export function getReports() {\n  return fetch("/api/reports");\n}\n',
      '/v/main.js': 'import { getReports } from "./api.js";\nfunction Page() {\n  getReports();\n}\nPage();\n',
    };
    const virtual: Plugin = {
      name: 'virtual',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => ({ path: args.path.startsWith('/') ? args.path : `/v/${args.path.replace(/^\.\//, '')}`, namespace: 'v' }));
        b.onLoad({ filter: /.*/, namespace: 'v' }, (args) => ({ contents: files[args.path]!, loader: 'js' }));
      },
    };
    const result = await build({ entryPoints: ['/v/main.js'], bundle: true, write: false, sourcemap: 'linked', outfile: '/out/out.js', plugins: [virtual] });
    const code = result.outputFiles.find((f) => f.path.endsWith('out.js'))!.text;
    const mapText = result.outputFiles.find((f) => f.path.endsWith('.map'))!.text;
    const map = SourceMapConsumer.parse(mapText);
    const fetchPos = positionOf(code, 'fetch(');
    expect(map.originalPositionFor(fetchPos.line, fetchPos.column)).toMatchObject({ source: expect.stringMatching(/(^|[/:])api\.js$/), line: 1, column: 9 });
    const callPos = positionOf(code, 'getReports()', code.indexOf('function Page'));
    const call = map.originalPositionFor(callPos.line, callPos.column);
    expect(call).toMatchObject({ source: expect.stringMatching(/(^|[/:])main\.js$/), line: 2 });
    expect(enclosingFunctionNames(call!.content!, call!.line, call!.column)).toEqual(['Page']);
    expect(findSourceMappingUrl(code)).toBe('out.js.map');
  });

  it('supports index maps with sections and the XSSI prefix', () => {
    const inner = { version: 3, sources: ['b.js'], names: [], mappings: encodeVlq([0, 0, 5, 2]) };
    const map = SourceMapConsumer.parse(`)]}'\n${JSON.stringify({ version: 3, sections: [{ offset: { line: 10, column: 4 }, map: inner }] })}`);
    expect(map.originalPositionFor(10, 4)).toMatchObject({ source: 'b.js', line: 5, column: 2 });
    expect(map.originalPositionFor(9, 0)).toBeNull();
    expect(map.sources).toEqual(['b.js']);
  });

  it('rejects non-maps', () => {
    expect(() => SourceMapConsumer.parse('{"version":2}')).toThrow();
    expect(() => SourceMapConsumer.parse('nope')).toThrow();
    expect(() => SourceMapConsumer.parse({ version: 3 })).toThrow();
  });
});

describe('sourceMappingURL / data URLs', () => {
  it('finds the last comment in its supported forms', () => {
    expect(findSourceMappingUrl('a();\n//# sourceMappingURL=app.js.map\n')).toBe('app.js.map');
    expect(findSourceMappingUrl('a();\n//@ sourceMappingURL=old.map')).toBe('old.map');
    expect(findSourceMappingUrl('a{}\n/*# sourceMappingURL=style.css.map */')).toBe('style.css.map');
    expect(findSourceMappingUrl('x = "sourceMappingURL=fake";\n//# sourceMappingURL=real.map')).toBe('real.map');
    expect(findSourceMappingUrl('var s = "sourceMappingURL=nothing";')).toBeNull();
    expect(findSourceMappingUrl('//# sourceMappingURL=a.map\n//# sourceMappingURL=b.map')).toBe('b.map');
  });

  it('decodes base64 and percent-encoded data URLs (UTF-8)', () => {
    const json = JSON.stringify({ version: 3, sources: ['ç.ts'], mappings: '' });
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
    expect(decodeDataUrl(`data:application/json;charset=utf-8;base64,${b64}`)).toBe(json);
    expect(decodeDataUrl(`data:application/json,${encodeURIComponent(json)}`)).toBe(json);
    expect(decodeDataUrl('https://x.test/a.map')).toBeNull();
    const inline = transformSync('const a = 1;\nfetch("/x");\n', { sourcemap: 'inline', sourcefile: 'inline.js' }).code;
    const url = findSourceMappingUrl(inline)!;
    expect(url.startsWith('data:application/json;base64,')).toBe(true);
    expect(SourceMapConsumer.parse(decodeDataUrl(url)!).sources).toEqual(['inline.js']);
  });
});

describe('excerpts and enclosing names', () => {
  const code = ['function A() {', '  return 1;', '}', 'const ReportList = () => {', '  useEffect(() => {', '    fetch("/x");', '  });', '};'].join('\n');

  it('excerpts lines around a position', () => {
    const ex = excerptAround(code, 5, 4, 2)!;
    expect(ex).toMatchObject({ startLine: 4, line: 6, column: 5 });
    expect(ex.lines).toEqual(['const ReportList = () => {', '  useEffect(() => {', '    fetch("/x");', '  });', '};']);
    expect(excerptAround(code, 99, 0)).toBeNull();
  });

  it('clips long minified lines around the column', () => {
    const long = `${'a'.repeat(5000)}fetch("/x")${'b'.repeat(5000)}`;
    const ex = excerptAround(long, 0, 5000, 3)!;
    expect(ex.clipped).toBe(true);
    expect(ex.lines[0]!.length).toBeLessThanOrEqual(240);
    expect(ex.lines[0]!.slice(ex.column - 1, ex.column + 4)).toBe('fetch');
    expect(looksMinified(long, 0)).toBe(true);
    expect(looksMinified(code, 0)).toBe(false);
  });

  it('names the enclosing functions, skipping anonymous callbacks and control blocks', () => {
    const at = positionOf(code, 'fetch(');
    expect(enclosingFunctionNames(code, at.line, at.column)).toEqual(['ReportList']);
    const src = [
      'export default function ReportsPage({ id }: Props): JSX.Element {',
      '  const load = async () => {',
      '    if (id) {',
      '      for (const x of [1]) {',
      '        await fetch(`/a/${x}`);',
      '      }',
      '    }',
      '  };',
      '  return <div onClick={() => { load(); }}>{id}</div>;',
      '}',
      'class Store extends Base {',
      '  async refresh(): Promise<void> {',
      '    await fetch("/s");',
      '  }',
      '}',
      'const obj = { useThing() { return fetch("/t"); } };',
      'const Typed: FC<Props> = (props) => { return fetch("/u"); };',
      'const old = function () { fetch("/v"); };',
    ].join('\n');
    const p1 = positionOf(src, 'await fetch(`');
    expect(enclosingFunctionNames(src, p1.line, p1.column)).toEqual(['load', 'ReportsPage']);
    const p2 = positionOf(src, 'load();');
    expect(enclosingFunctionNames(src, p2.line, p2.column)).toEqual(['ReportsPage']);
    const p3 = positionOf(src, 'fetch("/s")');
    expect(enclosingFunctionNames(src, p3.line, p3.column)).toEqual(['refresh', 'Store']);
    const p4 = positionOf(src, 'fetch("/t")');
    expect(enclosingFunctionNames(src, p4.line, p4.column)).toEqual(['useThing']);
    const p5 = positionOf(src, 'fetch("/u")');
    expect(enclosingFunctionNames(src, p5.line, p5.column)).toEqual(['Typed']);
    const p6 = positionOf(src, 'fetch("/v")');
    expect(enclosingFunctionNames(src, p6.line, p6.column)).toEqual(['old']);
  });

  it('computes line starts for every line-break style', () => {
    expect(Array.from(lineStartsOf('a\nb\r\nc\rd'))).toEqual([0, 2, 5, 7]);
  });
});
