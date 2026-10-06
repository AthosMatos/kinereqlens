import { describe, expect, it } from 'vitest';
import type { ReplayRequest, ReplayResult, ResponseData, TestRun } from '../../src/shared/types';
import { chooseCompare, findPreviousRun, headerNameIn, modeLabel, pickActiveRun } from '../../src/ui/response/results-model';

const request: ReplayRequest = {
  runId: 'x',
  entryId: 'e',
  mode: 'page',
  frameId: 0,
  method: 'GET',
  url: 'https://api.test/',
  headers: [],
  body: { kind: 'none' },
  credentials: 'include',
  redirect: 'follow',
  timeoutMs: 1000,
  responseBodyCap: 1000,
};

const result = (runId: string): ReplayResult => ({
  runId,
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: [],
  body: { kind: 'text', text: runId, size: runId.length },
  url: 'https://api.test/',
  redirected: false,
  timing: { start: 0, end: 10 },
  size: runId.length,
});

const run = (runId: string, state: TestRun['state'] = 'done', withResult = state !== 'running'): TestRun => ({
  runId,
  entryId: 'e',
  request: { ...request, runId },
  startedAt: 1_700_000_000_000,
  state,
  result: withResult ? result(runId) : undefined,
});

const originalWithBody: ResponseData = { state: 'done', status: 200, headers: [], body: { kind: 'text', text: 'orig', size: 4 } };
const originalNoBody: ResponseData = { state: 'done', status: 200, headers: [], body: null, bodyNote: 'n/a' };

// Newest first.
const runs = [run('r4', 'running'), run('r3'), run('r2', 'error', false), run('r1')];

describe('pickActiveRun', () => {
  it('returns the requested run, else the newest', () => {
    expect(pickActiveRun(runs, 'r3')?.runId).toBe('r3');
    expect(pickActiveRun(runs, 'missing')?.runId).toBe('r4');
    expect(pickActiveRun(runs, null)?.runId).toBe('r4');
    expect(pickActiveRun([], null)).toBeNull();
  });
});

describe('findPreviousRun', () => {
  it('skips running runs and runs without a result', () => {
    expect(findPreviousRun(runs, 'r4')?.runId).toBe('r3');
    expect(findPreviousRun(runs, 'r3')?.runId).toBe('r1');
    expect(findPreviousRun(runs, 'r1')).toBeNull();
    expect(findPreviousRun(runs, 'nope')).toBeNull();
  });
});

describe('chooseCompare', () => {
  it('defaults to the original response when it has a body', () => {
    const c = chooseCompare('original', originalWithBody, runs, runs[1]);
    expect(c.target).toBe('original');
    expect(c.baseline).toBe(originalWithBody);
    expect(c.label).toBe('Original response');
    expect(c.previousAvailable).toBe(true);
  });

  it('honours the previous-run preference when available', () => {
    const c = chooseCompare('previous', originalWithBody, runs, runs[1]);
    expect(c.target).toBe('previous');
    expect(c.previousRun?.runId).toBe('r1');
    expect(c.baseline?.body).toEqual({ kind: 'text', text: 'r1', size: 2 });
    expect(c.label).toMatch(/^Previous run \(/);
  });

  it('falls back to the previous run when the original has no body', () => {
    const c = chooseCompare('original', originalNoBody, runs, runs[1]);
    expect(c.target).toBe('previous');
    expect(c.originalAvailable).toBe(false);
  });

  it('falls back to the original when there is no previous run', () => {
    const c = chooseCompare('previous', originalWithBody, runs, runs[3]);
    expect(c.target).toBe('original');
  });

  it('offers nothing when neither baseline exists', () => {
    const c = chooseCompare('original', originalNoBody, [runs[3]], runs[3]);
    expect(c).toMatchObject({ target: null, baseline: null, originalAvailable: false, previousAvailable: false });
    expect(chooseCompare('original', originalWithBody, [], null).target).toBeNull();
  });
});

describe('helpers', () => {
  it('modeLabel', () => {
    expect(modeLabel('page')).toBe('Page');
    expect(modeLabel('extension')).toBe('Extension');
  });

  it('headerNameIn is case-insensitive', () => {
    expect(headerNameIn(['Cookie', 'origin'], { name: 'cookie', value: '' })).toBe(true);
    expect(headerNameIn(['Cookie'], { name: 'Referer', value: '' })).toBe(false);
    expect(headerNameIn(undefined, { name: 'Cookie', value: '' })).toBe(false);
  });
});
