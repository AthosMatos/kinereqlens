import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InboxItem, RequestSummary } from '../../../src/shared/claude-protocol';
import {
  cell,
  clipToolText,
  code,
  fence,
  formatBody,
  formatBytes,
  formatDuration,
  formatInbox,
  formatRequestList,
  formatRun,
  formatStatus,
  formatTypes,
  notConnectedText,
} from '../format';
import { Inbox } from '../inbox';
import { createFileLogger } from '../log';
import { parseExtensionMessage, parseHubMessage, parseInboxItem, parseMcpMessage } from '../messages';
import { hubSocketPath, maxSocketPathBytes, reqlensHome, socketPathProblem } from '../paths';
import { channelMetaValue, channelParams } from '../server';
import { removeDir, tempDir } from './helpers';

const item = (id: string, extra: Partial<InboxItem> = {}): InboxItem => ({
  id,
  sentAt: 0,
  tabId: 3,
  entryId: 'm:abc',
  title: 'GET /x',
  target: 'explain',
  prompt: `prompt ${id}`,
  sessionId: null,
  ...extra,
});

describe('text helpers', () => {
  it('fences with more backticks than the content holds', () => {
    expect(fence('a')).toBe('```\na\n```');
    expect(fence('x ``` y', 'json')).toBe('````json\nx ``` y\n````');
    expect(fence('`````', '')).toBe('``````\n`````\n``````');
    expect(fence('ends\n')).toBe('```\nends\n```');
  });

  it('keeps table cells on one line with pipes escaped', () => {
    expect(cell('a|b\nc\\d')).toBe('a\\|b c\\\\d');
    expect(cell(undefined)).toBe('—');
    expect(cell('')).toBe('—');
    expect(cell('x'.repeat(10), 5)).toBe('xxxx…');
  });

  it('formats inline code, sizes, durations and clipping', () => {
    expect(code('h:0:1')).toBe('`h:0:1`');
    expect(code('a`b')).toBe('`` a`b ``');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatDuration(12.4)).toBe('12 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(-1)).toBe('—');
    expect(clipToolText('abcdef', 4)).toBe('abcd\n… [result clipped: 2 more characters; ask for less, e.g. a smaller maxBodyChars or limit]');
    expect(clipToolText('abc', 4)).toBe('abc');
    expect(formatTypes({ format: 'zod', code: 'x'.repeat(100_000), names: {}, notes: [] }).length).toBeLessThan(91_000);
  });

  it('renders bodies by kind', () => {
    expect(formatBody('Body', null)).toBe('### Body\n_No body._');
    expect(formatBody('Body', { contentType: null, kind: 'none', text: '', truncated: false })).toBe('### Body\n_No body._');
    expect(formatBody('Body', { contentType: 'image/png', kind: 'binary', text: 'PNG image, 4 KB', truncated: false, size: 4096 })).toBe(
      '### Body · image/png · binary · 4.0 KB\n_PNG image, 4 KB_',
    );
    expect(formatBody('Body', { contentType: 'text/html', kind: 'text', text: '<p>hi</p>', truncated: true })).toBe(
      '### Body · text/html · text (truncated)\n```html\n<p>hi</p>\n```',
    );
    expect(formatBody('Body', { contentType: 'text/plain', kind: 'text', text: '', truncated: false }, '##')).toBe(
      '## Body · text/plain · text\n_Empty body._',
    );
  });
});

describe('tool result formatting', () => {
  const summary = (id: string, extra: Partial<RequestSummary> = {}): RequestSummary => ({
    id,
    method: 'GET',
    url: `https://x.test/${id}`,
    kind: 'fetch',
    state: 'done',
    status: 200,
    startTime: 0,
    modified: false,
    runs: 0,
    selected: false,
    ...extra,
  });

  it('lists requests with paging and empty states', () => {
    const text = formatRequestList({ tabId: 1, total: 12, requests: [summary('a'), summary('b', { state: 'error', status: undefined, runs: 1 })] }, 10);
    expect(text).toContain('Tab 1 · 12 requests match (showing 11–12, newest first).');
    expect(text).toContain('| b | GET | error | fetch | — | — | https://x.test/b | 1 run |');
    expect(text).not.toContain('more: call');
    expect(formatRequestList({ tabId: 1, total: 0, requests: [] })).toBe('Tab 1: no captured requests match.');
    expect(formatRequestList({ tabId: 1, total: 5, requests: [] }, 50)).toContain('no requests in this range (5 match in total)');
  });

  it('renders types per format', () => {
    expect(formatTypes({ format: 'json-schema', code: '{}', names: {}, notes: [] })).toBe('```json\n{}\n```');
    expect(formatTypes({ format: 'zod', code: 'const A = z.object({})', names: { query: 'AQuery' }, notes: ['a\nb'] })).toBe(
      '```ts\nconst A = z.object({})\n```\nRoot types: query → `AQuery`\nNotes:\n- a b',
    );
  });

  it('renders status when not connected and with an inbox', () => {
    const text = formatStatus({
      hub: { state: 'disconnected', extension: { connected: false } },
      session: { id: 's', label: 'proj', cwd: '/p', pid: 1 },
      problem: 'kineReqLens is not connected: X',
      inbox: 2,
    });
    expect(text).toBe('kineReqLens is not connected: X\nThis session: proj (s).\nInbox: 2 new item(s) — call the inbox tool.');
  });

  it('renders the inbox', () => {
    expect(formatInbox([], 0)).toContain('No new items in the kineReqLens inbox.');
    const text = formatInbox([item('1', { title: 'POST /a\n# injected' })], 3);
    expect(text).toContain('## POST /a # injected');
    expect(text).toContain('request `m:abc` · tab 3 · target explain · sent 1970-01-01T00:00:00.000Z');
    expect(text).toContain('prompt 1');
    expect(text).toContain('Inbox cleared (3 items removed).');
  });
});

describe('setup hints', () => {
  const base = { scriptPath: '/r/mcp/dist/reqlens-mcp.mjs', socketPath: '/h/hub.sock' };

  it('explains each not-connected situation', () => {
    const down = { state: 'disconnected' as const, extension: { connected: false }, lastErrorCode: 'ENOENT' };
    expect(notConnectedText(down, { ...base, installed: false })).toContain('npm run mcp:install -- --extension-id <id>');
    const notRunning = notConnectedText(down, { ...base, installed: true });
    expect(notRunning).toContain('the browser bridge is not running');
    expect(notRunning).toContain('Open Edge → kineReqLens overlay → Settings → Claude Code → Enable');
    expect(notRunning).toContain('`node "/r/mcp/dist/reqlens-mcp.mjs" doctor`');
    expect(notConnectedText({ ...down, lastErrorCode: 'EACCES' }, { ...base, installed: true })).toContain('permission denied on the hub socket /h/hub.sock');
    expect(notConnectedText({ state: 'connecting', extension: { connected: false } }, { ...base, installed: true })).toContain('still connecting');
    expect(notConnectedText({ state: 'connected', extension: { connected: false } }, { ...base, installed: true })).toContain(
      'extension has not finished connecting',
    );
    expect(notConnectedText(down, { ...base, installed: true, problem: 'path too long' })).toBe('kineReqLens is not connected: path too long');
  });
});

describe('formatRun', () => {
  const run = {
    runId: 'run-1',
    origin: 'claude' as const,
    state: 'done' as const,
    mode: 'extension' as const,
    startedAt: 0,
    durationMs: 12,
    status: 201,
    request: { method: 'POST', url: 'https://api.example.com/orders' },
    responseBody: { contentType: 'application/json', kind: 'json', text: '{"ok": true}', truncated: false },
  };

  it('renders the plain RunForClaude', () => {
    const text = formatRun(run);
    expect(text).toContain('# Run `run-1` · by Claude · done · extension mode · 201 · 12 ms');
    expect(text).toContain('POST https://api.example.com/orders');
    expect(text).toContain('{"ok": true}');
    expect(text).not.toContain('## Response headers');
  });

  it('renders the extras the extension adds (status text, headers, redirect, dropped / DNR headers)', () => {
    const text = formatRun({
      ...run,
      statusText: 'Created',
      responseHeaders: [['content-type', 'application/json']],
      finalUrl: 'https://api.example.com/orders/7',
      droppedHeaders: ['Host'],
      appliedViaDnr: ['Cookie', 'Origin'],
      redacted: true,
    });
    expect(text).toContain('# Run `run-1` · by Claude · done · extension mode · 201 Created · 12 ms');
    expect(text).toContain('Redirected to: https://api.example.com/orders/7');
    expect(text).toContain('Headers the browser did not send: `Host`');
    expect(text).toContain('declarativeNetRequest rule: `Cookie`, `Origin`');
    expect(text).toContain('Secret values are redacted');
    expect(text).toContain('## Response headers\n```http\ncontent-type: application/json\n```');
  });

  it('ignores extras of the wrong shape', () => {
    const odd = { ...run, droppedHeaders: 'Host', appliedViaDnr: [1, 2], finalUrl: 3 } as unknown as Parameters<typeof formatRun>[0];
    const text = formatRun(odd);
    expect(text).not.toContain('did not send');
    expect(text).not.toContain('declarativeNetRequest');
    expect(text).not.toContain('Redirected');
  });
});

describe('channel notification params', () => {
  it('uses identifier-safe meta values', () => {
    expect(channelMetaValue('h:0:12')).toBe('h:0:12');
    expect(channelMetaValue('a b"c<d>\n')).toBe('a_b_c_d__');
    expect(channelMetaValue('x'.repeat(200))).toHaveLength(128);
    expect(channelParams(item('1', { entryId: 'r:h:0:1', tabId: 42, target: 'tests' }))).toEqual({
      content: 'prompt 1',
      meta: { source: 'reqlens', request_id: 'r:h:0:1', tab_id: '42', target: 'tests' },
    });
  });
});

describe('Inbox', () => {
  it('returns unseen items once, dedupes ids, keeps the newest within the limit, clears', () => {
    const inbox = new Inbox(3);
    expect(inbox.add(item('1'))).toBe(true);
    expect(inbox.add(item('1'))).toBe(false);
    inbox.add(item('2'));
    expect(inbox.unseenCount).toBe(2);
    expect(inbox.takeUnseen().map((i) => i.id)).toEqual(['1', '2']);
    expect(inbox.takeUnseen()).toEqual([]);
    for (const id of ['3', '4', '5']) inbox.add(item(id));
    expect(inbox.takeUnseen().map((i) => i.id)).toEqual(['3', '4', '5']);
    expect(inbox.clear()).toBe(3);
    expect(inbox.unseenCount).toBe(0);
  });
});

describe('message validation', () => {
  it('parses extension messages and rejects malformed ones', () => {
    expect(parseExtensionMessage({ t: 'hello', v: 1, extensionVersion: '0.2.0', extensionId: 'x', browser: 'Edge' })).toEqual({
      t: 'hello',
      v: 1,
      extensionVersion: '0.2.0',
      extensionId: 'x',
      browser: 'Edge',
    });
    expect(parseExtensionMessage({ t: 'res', id: '1', ok: true, result: [1] })).toEqual({ t: 'res', id: '1', ok: true, result: [1] });
    expect(parseExtensionMessage({ t: 'res', id: '1', ok: false })).toEqual({ t: 'res', id: '1', ok: false, error: 'Unknown error' });
    expect(parseExtensionMessage({ t: 'res', id: '', ok: true })).toBeNull();
    expect(parseExtensionMessage({ t: 'res', id: 'x'.repeat(200), ok: true })).toBeNull();
    expect(parseExtensionMessage({ t: 'hello' })).toBeNull();
    expect(parseExtensionMessage({ t: 'req' })).toBeNull();
    expect(parseExtensionMessage(null)).toBeNull();
    expect(parseExtensionMessage([1])).toBeNull();
  });

  it('validates inbox items', () => {
    expect(parseInboxItem(item('1'))).toEqual(item('1'));
    expect(parseInboxItem({ ...item('1'), sessionId: undefined })).toEqual(item('1'));
    expect(parseInboxItem({ ...item('1'), target: 'deploy' })).toBeNull();
    expect(parseInboxItem({ ...item('1'), tabId: 1.5 })).toBeNull();
    expect(parseInboxItem({ ...item('1'), prompt: 3 })).toBeNull();
    expect(parseInboxItem({ ...item('1'), sessionId: 7 })).toBeNull();
    expect(parseInboxItem({ ...item('1'), title: 't'.repeat(900) })?.title).toHaveLength(500);
  });

  it('parses MCP → hub messages, keeping the id of bad requests for the error reply', () => {
    expect(parseMcpMessage({ t: 'hello', v: 1, session: { id: 's', label: '', cwd: '/w/p', pid: 3 } })).toEqual({
      ok: true,
      message: { t: 'hello', v: 1, session: { id: 's', label: '/w/p', cwd: '/w/p', pid: 3 } },
    });
    expect(parseMcpMessage({ t: 'hello', v: 1, session: { id: 's', cwd: '/w', pid: -1 } }).ok).toBe(false);
    expect(parseMcpMessage({ t: 'req', id: '9', method: 'status' })).toEqual({ ok: true, message: { t: 'req', id: '9', method: 'status', params: {} } });
    expect(parseMcpMessage({ t: 'req', id: '9', method: 'eval', params: {} })).toEqual({ ok: false, id: '9', error: 'Unknown method: eval' });
    expect(parseMcpMessage({ t: 'req', id: 'a\nb', method: 'status' })).toEqual({ ok: false, error: 'Malformed request id' });
    expect(parseMcpMessage({ t: 'push' })).toEqual({ ok: false, error: 'Unknown message type: push' });
  });

  it('parses hub → MCP messages', () => {
    expect(parseHubMessage({ t: 'hello', v: 1, hostVersion: '1', extension: { connected: true, version: '2' } })).toEqual({
      t: 'hello',
      v: 1,
      hostVersion: '1',
      extension: { connected: true, version: '2' },
    });
    expect(parseHubMessage({ t: 'ext', connected: false })).toEqual({ t: 'ext', connected: false });
    expect(parseHubMessage({ t: 'ext' })).toBeNull();
    expect(parseHubMessage({ t: 'push', item: { id: 1 } })).toBeNull();
    expect(parseHubMessage({ t: 'sessions' })).toBeNull();
  });
});

describe('paths', () => {
  it('resolves REQLENS_HOME and the socket', () => {
    expect(reqlensHome({}, '/Users/me')).toBe('/Users/me/.reqlens');
    expect(reqlensHome({ REQLENS_HOME: '/data/rl/' }, '/Users/me')).toBe('/data/rl');
    expect(reqlensHome({ REQLENS_HOME: '  ' }, '/Users/me')).toBe('/Users/me/.reqlens');
    expect(hubSocketPath('/Users/me/.reqlens', 'darwin')).toBe('/Users/me/.reqlens/hub.sock');
    expect(hubSocketPath('C:\\Users\\me\\.reqlens', 'win32', 'Jane Doe')).toBe('\\\\.\\pipe\\reqlens-hub-Jane_Doe');
  });

  it('detects socket paths too long for AF_UNIX', () => {
    expect(maxSocketPathBytes('darwin')).toBe(103);
    expect(maxSocketPathBytes('linux')).toBe(107);
    expect(socketPathProblem(`/${'a'.repeat(102)}`, 'darwin')).toBeNull();
    expect(socketPathProblem(`/${'a'.repeat(103)}`, 'darwin')).toMatch(/104 bytes/);
    expect(socketPathProblem(`/${'a'.repeat(103)}`, 'linux')).toBeNull();
    expect(socketPathProblem(`/${'é'.repeat(60)}`, 'darwin')).toMatch(/121 bytes/);
    expect(socketPathProblem(`/${'a'.repeat(300)}`, 'win32')).toBeNull();
  });
});

describe('file logger', () => {
  it('appends single-line entries and rotates at the size limit', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'logs', 'hub.log');
      const logger = createFileLogger(file, 200);
      logger.info('first\nline');
      expect(fs.readFileSync(file, 'utf8')).toMatch(/^\S+ INFO first line\n$/);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      for (let i = 0; i < 10; i++) logger.warn(`entry ${i} ${'x'.repeat(20)}`);
      expect(fs.existsSync(`${file}.1`)).toBe(true);
      expect(fs.statSync(file).size).toBeLessThanOrEqual(200);
      expect(fs.readFileSync(file, 'utf8')).toContain('entry 9');
    } finally {
      removeDir(dir);
    }
  });

  it('never throws when the file cannot be written', () => {
    const logger = createFileLogger('/dev/null/not-a-dir/hub.log');
    expect(() => logger.error('x')).not.toThrow();
  });
});
