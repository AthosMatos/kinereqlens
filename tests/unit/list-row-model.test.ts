import { describe, expect, it } from 'vitest';
import type { RequestEntry } from '../../src/shared/types';
import { durationMs, queryPreview, responseSize, rowTooltip, statusCell } from '../../src/ui/list/rowModel';
import { OVERSCAN_ROWS, scrollAnchor, scrollTopToReveal, visibleRange } from '../../src/ui/list/virtual';

function entry(patch: Partial<RequestEntry> = {}): RequestEntry {
  return {
    id: 'h:0:1',
    source: 'hook',
    kind: 'fetch',
    frameId: 0,
    pageUrl: 'https://app.example.com/',
    method: 'GET',
    url: 'https://api.example.com/items',
    requestHeaders: [],
    requestBody: null,
    requestContentType: null,
    startTime: 1000,
    state: 'done',
    ...patch,
  };
}

describe('statusCell', () => {
  it('shows a spinner while pending', () => {
    expect(statusCell(entry({ state: 'pending', status: 200 }))).toEqual({ kind: 'pending' });
  });

  it('shows the status code (and text) when done', () => {
    expect(statusCell(entry({ status: 201, statusText: 'Created' }))).toEqual({ kind: 'code', status: 201, statusText: 'Created' });
    expect(statusCell(entry({ status: 304 }))).toEqual({ kind: 'code', status: 304, statusText: '' });
  });

  it('shows a failed call as an error even when the network answered (status in the message)', () => {
    expect(statusCell(entry({ state: 'error', status: 500, error: 'body read failed' }))).toEqual({ kind: 'error', message: '500 · body read failed' });
    // CORS-blocked fetch: webRequest saw a 200, the page's call failed.
    expect(statusCell(entry({ state: 'error', status: 200, error: 'TypeError: Failed to fetch' })).kind).toBe('error');
  });

  it('reports errors without a status, with a fallback message', () => {
    expect(statusCell(entry({ state: 'error', error: 'net::ERR_FAILED' }))).toEqual({ kind: 'error', message: 'net::ERR_FAILED' });
    expect(statusCell(entry({ state: 'error' }))).toEqual({ kind: 'error', message: 'Request failed' });
  });

  it('marks aborted requests and done-without-status (beacons)', () => {
    expect(statusCell(entry({ state: 'aborted', status: 200 }))).toEqual({ kind: 'aborted' });
    expect(statusCell(entry({ kind: 'beacon' }))).toEqual({ kind: 'none' });
    expect(statusCell(entry({ status: 0 }))).toEqual({ kind: 'none' });
  });
});

describe('durationMs', () => {
  it('is end - start, or null when unknown / inconsistent', () => {
    expect(durationMs(entry({ endTime: 1250 }))).toBe(250);
    expect(durationMs(entry({ endTime: 1000 }))).toBe(0);
    expect(durationMs(entry())).toBeNull();
    expect(durationMs(entry({ endTime: 900 }))).toBeNull();
    expect(durationMs(entry({ endTime: Number.NaN }))).toBeNull();
  });
});

describe('responseSize', () => {
  it('uses the full captured body size (even when truncated)', () => {
    expect(responseSize(entry({ responseBody: { kind: 'text', text: 'abc', size: 3 } }))).toBe(3);
    expect(responseSize(entry({ responseBody: { kind: 'base64', base64: 'AA==', size: 9_000_000, truncated: true } }))).toBe(9_000_000);
  });

  it('falls back to Content-Length from page headers, then wire headers', () => {
    expect(responseSize(entry({ responseHeaders: [{ name: 'Content-Length', value: ' 1234 ' }] }))).toBe(1234);
    expect(
      responseSize(entry({ wire: { requestId: '1', responseHeaders: [{ name: 'content-length', value: '77' }] } })),
    ).toBe(77);
    expect(
      responseSize(
        entry({
          responseBody: { kind: 'unavailable', reason: 'opaque' },
          responseHeaders: [{ name: 'content-length', value: '5' }],
        }),
      ),
    ).toBe(5);
  });

  it('ignores malformed Content-Length values', () => {
    expect(responseSize(entry({ responseHeaders: [{ name: 'content-length', value: '12, 12' }] }))).toBeNull();
    expect(responseSize(entry({ responseHeaders: [{ name: 'content-length', value: '-1' }] }))).toBeNull();
    expect(responseSize(entry({ responseHeaders: [{ name: 'content-length', value: '99999999999999999999' }] }))).toBeNull();
    expect(responseSize(entry())).toBeNull();
  });
});

describe('rowTooltip', () => {
  it('shows method and full URL', () => {
    expect(rowTooltip(entry())).toBe('GET https://api.example.com/items');
  });

  it('adds redirect target, error, cancel, cache and restored notes', () => {
    const tip = rowTooltip(
      entry({
        redirected: true,
        responseUrl: 'https://api.example.com/items/',
        state: 'error',
        error: 'boom',
        fromCache: true,
        restored: true,
      }),
    );
    expect(tip.split('\n')).toEqual([
      'GET https://api.example.com/items',
      '→ https://api.example.com/items/',
      'Error: boom',
      'Served from cache',
      'From a previous page (preserved log)',
    ]);
    expect(rowTooltip(entry({ state: 'aborted' }))).toContain('Canceled');
  });

  it('omits a redirect line when the final URL is unchanged', () => {
    expect(rowTooltip(entry({ redirected: true, responseUrl: 'https://api.example.com/items' }))).not.toContain('→');
  });
});

describe('queryPreview', () => {
  it('prefixes "?" and caps long queries with an ellipsis', () => {
    expect(queryPreview('')).toBe('');
    expect(queryPreview('a=1&b=2')).toBe('?a=1&b=2');
    const long = queryPreview('x'.repeat(200), 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith('…')).toBe(true);
    expect(queryPreview('abc', 4)).toBe('?abc');
  });
});

describe('virtualization math', () => {
  it('renders the visible rows plus overscan, clamped to the list', () => {
    expect(visibleRange(0, 280, 28, 1000)).toEqual({ start: 0, end: 11 + OVERSCAN_ROWS });
    expect(visibleRange(2800, 280, 28, 1000)).toEqual({ start: 100 - OVERSCAN_ROWS, end: 111 + OVERSCAN_ROWS });
    expect(visibleRange(1e9, 280, 28, 1000)).toEqual({ start: 1000, end: 1000 });
    expect(visibleRange(27_900, 280, 28, 1000, 0)).toEqual({ start: 996, end: 1000 });
  });

  it('handles empty lists, negative scroll and degenerate sizes', () => {
    expect(visibleRange(0, 280, 28, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(-50, 280, 28, 5)).toEqual({ start: 0, end: 5 });
    expect(visibleRange(0, 280, 0, 5)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(0, -10, 28, 500, 0)).toEqual({ start: 0, end: 1 });
  });

  it('computes the scrollTop needed to reveal a row', () => {
    // viewport shows rows 10..19 (scrollTop 280, height 280)
    expect(scrollTopToReveal(12, 28, 280, 280)).toBeNull();
    expect(scrollTopToReveal(5, 28, 280, 280)).toBe(140);
    expect(scrollTopToReveal(20, 28, 280, 280)).toBe(21 * 28 - 280);
    expect(scrollTopToReveal(-1, 28, 280, 280)).toBeNull();
    expect(scrollTopToReveal(0, 28, 0, 0)).toBeNull();
  });

  it('finds the anchor row at the top edge', () => {
    expect(scrollAnchor(0, 28)).toEqual({ index: 0, offset: 0 });
    expect(scrollAnchor(70, 28)).toEqual({ index: 2, offset: 14 });
    expect(scrollAnchor(-5, 28)).toEqual({ index: 0, offset: 0 });
    expect(scrollAnchor(70, 0)).toEqual({ index: 0, offset: 0 });
  });
});
