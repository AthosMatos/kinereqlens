import { describe, expect, it } from 'vitest';
import { capStackText, cleanStack, firstFrameUrl, parseStack, parseStackLine, STACK_MAX_CHARS, STACK_MAX_FRAMES } from '../../src/lib/stack';

const OWN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/hook.js';

const CHROME_STACK = `Error
    at d (${OWN}:1:2345)
    at Ce (${OWN}:1:9876)
    at window.fetch (${OWN}:1:12000)
    at loadReports (http://localhost:5173/src/api.ts?t=1700:12:10)
    at async ReportList.componentDidMount (http://localhost:5173/src/ReportList.tsx:40:5)
    at Object.fetchData [as fetch] (https://cdn.example.com/app.min.js:1:44031)
    at new Store (https://cdn.example.com/app.min.js:1:50000)
    at https://cdn.example.com/app.min.js:2:17
    at Array.map (<anonymous>)
    at async Promise.all (index 0)
    at eval (eval at run (http://x.test/a.js:1:1), <anonymous>:3:9)
    at <anonymous>`;

describe('parseStackLine', () => {
  it('parses the V8 / Edge frame forms', () => {
    const frames = parseStack(CHROME_STACK);
    expect(frames).toHaveLength(12);
    expect(frames[3]).toMatchObject({ fn: 'loadReports', url: 'http://localhost:5173/src/api.ts?t=1700', line: 12, col: 10, async: false, native: false });
    expect(frames[4]).toMatchObject({ fn: 'ReportList.componentDidMount', line: 40, col: 5, async: true });
    expect(frames[5]).toMatchObject({ fn: 'Object.fetchData [as fetch]', url: 'https://cdn.example.com/app.min.js', line: 1, col: 44031 });
    expect(frames[6]).toMatchObject({ fn: 'Store', ctor: true, line: 1, col: 50000 });
    expect(frames[7]).toMatchObject({ fn: '', url: 'https://cdn.example.com/app.min.js', line: 2, col: 17 });
    expect(frames[8]).toMatchObject({ fn: 'Array.map', native: true, url: '' });
    expect(frames[9]).toMatchObject({ fn: 'Promise.all', async: true, native: true });
    expect(frames[10]).toMatchObject({ fn: 'eval', native: true, url: '' });
    expect(frames[11]).toMatchObject({ native: true });
  });

  it('parses SpiderMonkey / JavaScriptCore frames', () => {
    expect(parseStackLine('loadReports@http://x.test/a.js:3:7')).toMatchObject({ fn: 'loadReports', url: 'http://x.test/a.js', line: 3, col: 7 });
    expect(parseStackLine('async*ReportList@http://x.test/a.js:9:1')).toMatchObject({ fn: 'ReportList', async: true, line: 9 });
    expect(parseStackLine('@http://x.test/a.js:1:2')).toMatchObject({ fn: '', line: 1, col: 2 });
  });

  it('skips headers and junk', () => {
    expect(parseStackLine('Error: boom')).toBeNull();
    expect(parseStackLine('')).toBeNull();
    expect(parseStackLine('TypeError: x is not a function')).toBeNull();
  });

  it('handles URLs with parentheses and ports', () => {
    expect(parseStackLine('at f (http://x.test:8080/a(1).js:4:2)')).toMatchObject({ fn: 'f', url: 'http://x.test:8080/a(1).js', line: 4, col: 2 });
  });
});

describe('cleanStack', () => {
  it('drops the header and our own wrapper frames', () => {
    const clean = cleanStack(CHROME_STACK, OWN);
    expect(clean.split('\n')[0]).toBe('at loadReports (http://localhost:5173/src/api.ts?t=1700:12:10)');
    expect(clean).not.toContain(OWN);
    expect(clean).not.toMatch(/^Error/);
    expect(firstFrameUrl(CHROME_STACK)).toBe(OWN);
  });

  it('caps frames and characters at line boundaries', () => {
    const many = Array.from({ length: 100 }, (_, i) => `    at f${i} (https://x.test/${'p'.repeat(300)}.js:${i + 1}:1)`).join('\n');
    const clean = cleanStack(many, '');
    const lines = clean.split('\n');
    expect(lines.length).toBeLessThanOrEqual(STACK_MAX_FRAMES);
    expect(clean.length).toBeLessThanOrEqual(STACK_MAX_CHARS);
    expect(lines.every((l) => /^at f\d+ \(/.test(l))).toBe(true);
    expect(capStackText(clean, 1000).length).toBeLessThanOrEqual(1000);
    expect(capStackText(clean, 1000).endsWith(':1)')).toBe(true);
    expect(capStackText('short')).toBe('short');
  });

  it('keeps everything when the own URL is unknown', () => {
    expect(cleanStack(CHROME_STACK, '').split('\n')[0]).toContain(OWN);
  });
});
