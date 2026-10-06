import { describe, expect, it } from 'vitest';
import { toCurl, toFetchSnippet, type SnippetRequest } from '../../src/lib/curl';
import { bytesToBase64 } from '../../src/lib/encoding';

// The unit tsconfig only loads chrome types (a global node reference would leak into src/), so the Node
// APIs used by the shell round-trip tests are typed locally and imported through a non-literal specifier.
interface ChildProcessModule {
  execFileSync(file: string, args: string[], options: { encoding: 'utf8'; input: string }): string;
}
const childProcessSpecifier = 'node:child_process';
const { execFileSync } = (await import(/* @vite-ignore */ childProcessSpecifier)) as ChildProcessModule;

const req = (patch: Partial<SnippetRequest> = {}): SnippetRequest => ({
  method: 'GET',
  url: 'https://api.example.com/v1/items?x=1',
  headers: [],
  body: { kind: 'none' },
  ...patch,
});

const hasShell = (globalThis as { process?: { platform?: string } }).process?.platform !== 'win32';

/**
 * Run the generated command in a real POSIX shell with `curl` replaced by a function that prints each
 * argument NUL-terminated, plus the bytes it received on stdin (hex) after a marker.
 */
function shellArgs(command: string): { args: string[]; stdinHex: string } {
  const script = `curl() { for a in "$@"; do printf '%s\\0' "$a"; done; printf 'STDIN:'; od -An -tx1 | tr -d ' \\n'; }\n${command}`;
  const out = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8', input: '' });
  const marker = out.lastIndexOf('STDIN:');
  const args = out.slice(0, marker).split('\0');
  args.pop();
  return { args, stdinHex: out.slice(marker + 6) };
}

describe('toCurl', () => {
  it('emits a plain GET without -X, one option per line', () => {
    expect(toCurl(req({ headers: [{ name: 'Accept', value: 'application/json' }] }))).toBe(
      "curl 'https://api.example.com/v1/items?x=1' \\\n  -H 'Accept: application/json'",
    );
    expect(toCurl(req())).toBe("curl 'https://api.example.com/v1/items?x=1'");
  });

  it('omits -X for POST with a body and uses --data-raw', () => {
    const out = toCurl(
      req({ method: 'POST', headers: [{ name: 'Content-Type', value: 'application/json' }], body: { kind: 'text', text: '{"a":1}' } }),
    );
    expect(out).toBe(
      "curl 'https://api.example.com/v1/items?x=1' \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{\"a\":1}'",
    );
  });

  it('adds -X for POST without body, GET with body and other methods', () => {
    expect(toCurl(req({ method: 'POST' }))).toContain('\n  -X POST');
    expect(toCurl(req({ method: 'GET', body: { kind: 'text', text: 'x' } }))).toContain('\n  -X GET');
    expect(toCurl(req({ method: 'PUT', body: { kind: 'text', text: 'x' } }))).toContain('\n  -X PUT');
    expect(toCurl(req({ method: 'DELETE' }))).toContain('\n  -X DELETE');
    expect(toCurl(req({ method: 'PATCH', body: { kind: 'text', text: '' } }))).toContain('\n  -X PATCH');
    expect(toCurl(req({ method: 'PROPFIND' }))).toContain('\n  -X PROPFIND');
  });

  it('normalizes methods like fetch and quotes unusual custom methods', () => {
    expect(toCurl(req({ method: 'get' }))).not.toContain('-X');
    expect(toCurl(req({ method: 'post', body: { kind: 'text', text: 'a' } }))).not.toContain('-X');
    expect(toCurl(req({ method: 'patch' }))).toContain('-X patch');
    expect(toCurl(req({ method: 'X;rm' }))).toContain("-X 'X;rm'");
  });

  it('uses --head for HEAD', () => {
    expect(toCurl(req({ method: 'HEAD' }))).toBe("curl 'https://api.example.com/v1/items?x=1' \\\n  --head");
  });

  it('escapes single quotes POSIX-style', () => {
    const out = toCurl(
      req({
        url: "https://a.example/it's",
        method: 'POST',
        headers: [{ name: 'X-Q', value: "it's 'quoted'" }],
        body: { kind: 'text', text: "{'a':'b'}" },
      }),
    );
    expect(out).toContain("curl 'https://a.example/it'\\''s'");
    expect(out).toContain("-H 'X-Q: it'\\''s '\\''quoted'\\'''");
    expect(out).toContain("--data-raw '{'\\''a'\\'':'\\''b'\\''}'");
  });

  it('writes empty header values with the ";" syntax', () => {
    expect(toCurl(req({ headers: [{ name: 'X-Empty', value: '' }] }))).toContain("-H 'X-Empty;'");
  });

  it('adds --globoff for URLs with brackets or braces', () => {
    expect(toCurl(req({ url: 'https://a.example/?a[]=1' }))).toContain('\n  --globoff');
    expect(toCurl(req({ url: 'https://a.example/{id}' }))).toContain('\n  --globoff');
    expect(toCurl(req())).not.toContain('--globoff');
  });

  it('pipes binary bodies through base64 -d', () => {
    const out = toCurl(req({ method: 'POST', body: { kind: 'base64', base64: 'AAEC/w==' } }));
    expect(out).toBe(
      "printf '%s' 'AAEC/w==' | base64 -d | curl 'https://api.example.com/v1/items?x=1' \\\n  -H 'Content-Type:' \\\n  --data-binary @-",
    );
    expect(toCurl(req({ method: 'PUT', body: { kind: 'base64', base64: 'AA==' } }))).toContain('-X PUT');
  });

  it('ships text containing NUL as binary', () => {
    const out = toCurl(req({ method: 'POST', body: { kind: 'text', text: 'a\0b' } }));
    expect(out.startsWith(`printf '%s' '${bytesToBase64(new Uint8Array([0x61, 0, 0x62]))}' | base64 -d | curl`)).toBe(true);
    expect(out).toContain('--data-binary @-');
  });

  it.skipIf(!hasShell)('produces arguments that survive a real POSIX shell unchanged', () => {
    const nasty = "it's $HOME `id` $(whoami) \"dq\" \\ back\nnew line ; & | * ? ~ ! # 😀 '' ''' ";
    const command = toCurl({
      method: 'PATCH',
      url: "https://a.example/p?q='x'&y=$z",
      headers: [
        { name: 'X-Nasty', value: nasty },
        { name: 'Cookie', value: 'a=1; b=2' },
        { name: 'X-Empty', value: '' },
        { name: 'Content-Type', value: 'text/plain' },
      ],
      body: { kind: 'text', text: nasty },
    });
    const { args } = shellArgs(command);
    expect(args).toEqual([
      "https://a.example/p?q='x'&y=$z",
      '-X',
      'PATCH',
      '-H',
      `X-Nasty: ${nasty}`,
      '-H',
      'Cookie: a=1; b=2',
      '-H',
      'X-Empty;',
      '-H',
      'Content-Type: text/plain',
      '--data-raw',
      nasty,
    ]);
  });

  it.skipIf(!hasShell)('reproduces the exact bytes of a binary body', () => {
    const bytes = new Uint8Array(512).map((_, i) => (i * 37) & 0xff);
    const command = toCurl(req({ method: 'POST', body: { kind: 'base64', base64: bytesToBase64(bytes) } }));
    const { args, stdinHex } = shellArgs(command);
    expect(args).toEqual(['https://api.example.com/v1/items?x=1', '-H', 'Content-Type:', '--data-binary', '@-']);
    expect(stdinHex).toBe(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
  });
});

describe('toFetchSnippet', () => {
  it('emits a GET with headers as an object literal', () => {
    expect(toFetchSnippet(req({ headers: [{ name: 'Accept', value: 'application/json' }] }))).toBe(
      'await fetch("https://api.example.com/v1/items?x=1", {\n  method: "GET",\n  headers: {\n    "Accept": "application/json"\n  },\n});',
    );
  });

  it('omits headers and body when absent', () => {
    expect(toFetchSnippet(req())).toBe('await fetch("https://api.example.com/v1/items?x=1", {\n  method: "GET",\n});');
  });

  it('JSON-escapes strings', () => {
    const out = toFetchSnippet(
      req({
        method: 'POST',
        url: 'https://a.example/"q"',
        headers: [{ name: 'X-A', value: 'line\n"quoted" \\ </script>' }, { name: 'content-type', value: 'application/json' }],
        body: { kind: 'text', text: '{"a":"ü 😀\\n"}' },
      }),
    );
    expect(out).toContain('await fetch("https://a.example/\\"q\\"", {');
    expect(out).toContain('"X-A": "line\\n\\"quoted\\" \\\\ </script>"');
    expect(out).toContain('body: "{\\"a\\":\\"ü 😀\\\\n\\"}"');
  });

  it('keeps a request without Content-Type untyped (fetch would add text/plain for a string body)', () => {
    const out = toFetchSnippet(req({ method: 'POST', body: { kind: 'text', text: '{"a":1}' } }));
    expect(out).toContain('body: new TextEncoder().encode("{\\"a\\":1}")');
    expect(toCurl(req({ method: 'POST', body: { kind: 'text', text: 'x' } }))).toContain("-H 'Content-Type:'");
    expect(toCurl(req({ method: 'POST', headers: [{ name: 'Content-Type', value: 'text/plain' }], body: { kind: 'text', text: 'x' } }))).not.toContain("'Content-Type:'");
    expect(toCurl(req({ method: 'GET' }))).not.toContain('Content-Type');
  });

  it('uses array-of-tuples headers when names repeat (case-insensitively)', () => {
    const out = toFetchSnippet(
      req({
        headers: [
          { name: 'X-Dup', value: '1' },
          { name: 'x-dup', value: '2' },
          { name: 'Accept', value: '*/*' },
        ],
      }),
    );
    expect(out).toContain('  headers: [\n    ["X-Dup", "1"],\n    ["x-dup", "2"],\n    ["Accept", "*/*"]\n  ],');
  });

  it('decodes binary bodies with atob', () => {
    const out = toFetchSnippet(req({ method: 'PUT', body: { kind: 'base64', base64: 'AAEC/w==' } }));
    expect(out).toContain('body: Uint8Array.from(atob("AAEC/w=="), (c) => c.charCodeAt(0))');
  });

  it('produces syntactically valid JavaScript', () => {
    const snippets = [
      toFetchSnippet(req()),
      toFetchSnippet(req({ method: 'POST', headers: [{ name: 'a', value: '1' }, { name: 'A', value: '2' }], body: { kind: 'text', text: "'`${x}`'" } })),
      toFetchSnippet(req({ method: 'PUT', body: { kind: 'base64', base64: 'AA==' } })),
    ];
    for (const snippet of snippets) {
      // Compile only (never executed): wrap in an async function so top-level await is legal.
      expect(() => new Function(`return async () => { ${snippet} }`)).not.toThrow();
    }
  });
});
