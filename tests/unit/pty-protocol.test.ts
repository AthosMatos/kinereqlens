import { describe, expect, it } from 'vitest';
import { NATIVE_MAX_INBOUND_BYTES, PTY_DATA_CHUNK_CHARS, PTY_MAX_INPUT_BYTES } from '../../src/shared/claude-protocol';
import {
  OutputTail,
  chunkPtyData,
  isPtyCwdInput,
  isPtyDim,
  isPtyId,
  newPtyId,
  parsePtyFromHost,
  parsePtyToHost,
  pushRecentDir,
  sanitizeRecentDirs,
  splitPtyInput,
  utf8Length,
} from '../../src/shared/pty';

describe('pty field validation', () => {
  it('ids: 1..64 safe chars', () => {
    expect(isPtyId('pty-0123abcd')).toBe(true);
    expect(isPtyId('a'.repeat(64))).toBe(true);
    expect(isPtyId('a'.repeat(65))).toBe(false);
    expect(isPtyId('')).toBe(false);
    expect(isPtyId('a b')).toBe(false);
    expect(isPtyId('a/b')).toBe(false);
    expect(isPtyId(12)).toBe(false);
    expect(isPtyId(newPtyId())).toBe(true);
    expect(newPtyId()).not.toBe(newPtyId());
  });

  it('dimensions: integers 1..1000', () => {
    expect(isPtyDim(1)).toBe(true);
    expect(isPtyDim(1000)).toBe(true);
    expect(isPtyDim(0)).toBe(false);
    expect(isPtyDim(1001)).toBe(false);
    expect(isPtyDim(80.5)).toBe(false);
    expect(isPtyDim(Number.NaN)).toBe(false);
    expect(isPtyDim('80')).toBe(false);
  });

  it('working directories: non-blank, bounded, no control chars', () => {
    expect(isPtyCwdInput('~/projects/app')).toBe(true);
    expect(isPtyCwdInput('/Users/x/My Projects/ünïcode')).toBe(true);
    expect(isPtyCwdInput('   ')).toBe(false);
    expect(isPtyCwdInput('/a\nb')).toBe(false);
    expect(isPtyCwdInput('/a\u0000b')).toBe(false);
    expect(isPtyCwdInput('/' + 'a'.repeat(4096))).toBe(false);
  });

  it('utf8Length counts bytes', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
    expect(utf8Length('\ud83d')).toBe(3);
    expect(utf8Length('😀é')).toBe(new TextEncoder().encode('😀é').length);
  });
});

describe('parsePtyToHost (extension → hub)', () => {
  it('accepts well-formed messages', () => {
    expect(parsePtyToHost({ t: 'pty-open', id: 'p1', cwd: '~', cols: 80, rows: 24, extra: 1 })).toEqual({ t: 'pty-open', id: 'p1', cwd: '~', cols: 80, rows: 24 });
    expect(parsePtyToHost({ t: 'pty-input', id: 'p1', data: '\u001b[A' })).toEqual({ t: 'pty-input', id: 'p1', data: '\u001b[A' });
    expect(parsePtyToHost({ t: 'pty-resize', id: 'p1', cols: 1000, rows: 1 })).toEqual({ t: 'pty-resize', id: 'p1', cols: 1000, rows: 1 });
    expect(parsePtyToHost({ t: 'pty-close', id: 'p1' })).toEqual({ t: 'pty-close', id: 'p1' });
  });

  it('rejects bad ids, sizes, dimensions and unknown types', () => {
    expect(parsePtyToHost({ t: 'pty-open', id: 'p 1', cwd: '~', cols: 80, rows: 24 })).toBeNull();
    expect(parsePtyToHost({ t: 'pty-open', id: 'p1', cwd: '', cols: 80, rows: 24 })).toBeNull();
    expect(parsePtyToHost({ t: 'pty-open', id: 'p1', cwd: '~', cols: 80 })).toBeNull();
    expect(parsePtyToHost({ t: 'pty-resize', id: 'p1', cols: -1, rows: 24 })).toBeNull();
    expect(parsePtyToHost({ t: 'pty-input', id: 'p1', data: '' })).toBeNull();
    expect(parsePtyToHost({ t: 'pty-input', id: 'p1', data: 'a'.repeat(PTY_MAX_INPUT_BYTES) })).not.toBeNull();
    expect(parsePtyToHost({ t: 'pty-input', id: 'p1', data: 'a'.repeat(PTY_MAX_INPUT_BYTES + 1) })).toBeNull();
    // 64 KB in bytes, not chars.
    expect(parsePtyToHost({ t: 'pty-input', id: 'p1', data: '€'.repeat(30_000) })).toBeNull();
    expect(parsePtyToHost({ t: 'pty-exec', id: 'p1' })).toBeNull();
    expect(parsePtyToHost(null)).toBeNull();
    expect(parsePtyToHost([])).toBeNull();
  });
});

describe('parsePtyFromHost (hub → extension)', () => {
  it('normalizes events', () => {
    expect(parsePtyFromHost({ t: 'pty-opened', id: 'p1', pid: 42, cwd: '/x' })).toEqual({ t: 'pty-opened', id: 'p1', pid: 42, cwd: '/x' });
    expect(parsePtyFromHost({ t: 'pty-opened', id: 'p1', pid: -1 })).toBeNull();
    expect(parsePtyFromHost({ t: 'pty-data', id: 'p1', data: 'x' })).toEqual({ t: 'pty-data', id: 'p1', data: 'x' });
    expect(parsePtyFromHost({ t: 'pty-data', id: 'p1', data: 'x'.repeat(300_000) })).toBeNull();
    expect(parsePtyFromHost({ t: 'pty-exit', id: 'p1', code: 0, signal: null })).toEqual({ t: 'pty-exit', id: 'p1', code: 0, signal: null });
    expect(parsePtyFromHost({ t: 'pty-exit', id: 'p1', code: 'x', signal: 'SIGHUP' })).toEqual({ t: 'pty-exit', id: 'p1', code: null, signal: 'SIGHUP' });
    expect(parsePtyFromHost({ t: 'pty-error', id: 'p1', error: 'e'.repeat(5000) })).toMatchObject({ error: 'e'.repeat(2000) });
    expect(parsePtyFromHost({ t: 'pty-error', id: 'p1' })).toEqual({ t: 'pty-error', id: 'p1', error: 'Terminal error' });
    expect(parsePtyFromHost({ t: 'pty-weird', id: 'p1' })).toBeNull();
  });
});

describe('chunkPtyData', () => {
  it('passes small output through and splits big output', () => {
    expect(chunkPtyData('')).toEqual([]);
    expect(chunkPtyData('abc')).toEqual(['abc']);
    const big = 'x'.repeat(PTY_DATA_CHUNK_CHARS * 2 + 5);
    const chunks = chunkPtyData(big);
    expect(chunks.map((c) => c.length)).toEqual([PTY_DATA_CHUNK_CHARS, PTY_DATA_CHUNK_CHARS, 5]);
    expect(chunks.join('')).toBe(big);
  });

  it('never splits a surrogate pair', () => {
    const text = 'a😀😀😀';
    const chunks = chunkPtyData(text, 2);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) expect(/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(chunk)).toBe(false);
  });

  it('keeps worst-case frames (escape-heavy output) far below 1 MB', () => {
    const worst = '\u0001'.repeat(PTY_DATA_CHUNK_CHARS * 3);
    for (const chunk of chunkPtyData(worst)) {
      const bytes = new TextEncoder().encode(JSON.stringify({ t: 'pty-data', id: 'x'.repeat(64), data: chunk })).length;
      expect(bytes).toBeLessThan(NATIVE_MAX_INBOUND_BYTES / 2);
    }
  });
});

describe('splitPtyInput', () => {
  it('splits pastes by UTF-8 bytes, keeping characters whole', () => {
    expect(splitPtyInput('')).toEqual([]);
    expect(splitPtyInput('ls\r')).toEqual(['ls\r']);
    const paste = '€😀a'.repeat(20_000);
    const chunks = splitPtyInput(paste);
    expect(chunks.join('')).toBe(paste);
    for (const chunk of chunks) {
      expect(utf8Length(chunk)).toBeLessThanOrEqual(PTY_MAX_INPUT_BYTES);
      expect(parsePtyToHost({ t: 'pty-input', id: 'p', data: chunk })).not.toBeNull();
    }
    expect(splitPtyInput('😀😀', 4)).toEqual(['😀', '😀']);
  });
});

describe('OutputTail', () => {
  it('keeps the last N chars', () => {
    const tail = new OutputTail(10);
    tail.push('hello ');
    tail.push('world');
    expect(tail.text()).toBe('ello world');
    expect(tail.size).toBe(10);
    tail.push('0123456789abc');
    expect(tail.text()).toBe('3456789abc');
    tail.push('');
    expect(tail.size).toBe(10);
    tail.clear();
    expect(tail.text()).toBe('');
  });

  it('does not start with half a surrogate pair', () => {
    const tail = new OutputTail(3);
    tail.push('a😀b');
    expect(tail.text()).toBe('😀b');
    tail.push('😀😀');
    expect(tail.text()).not.toMatch(/^[\udc00-\udfff]/);
  });
});

describe('recent directories', () => {
  it('sanitizes and keeps most-recent-first, at most 10', () => {
    expect(sanitizeRecentDirs(null)).toEqual([]);
    expect(sanitizeRecentDirs(['  ~/a ', '~/a', '', 3, '/b\nc', '/c'])).toEqual(['~/a', '/c']);
    const many = Array.from({ length: 15 }, (_, i) => `/d${i}`);
    expect(sanitizeRecentDirs(many)).toEqual(many.slice(0, 10));
    expect(sanitizeRecentDirs(['/' + 'x'.repeat(5000)])).toEqual([]);
  });

  it('pushRecentDir moves a directory to the front', () => {
    expect(pushRecentDir(['/a', '/b', '/c'], '/c')).toEqual(['/c', '/a', '/b']);
    expect(pushRecentDir(['/a'], ' /b ')).toEqual(['/b', '/a']);
    const full = Array.from({ length: 10 }, (_, i) => `/d${i}`);
    expect(pushRecentDir(full, '/new')).toEqual(['/new', ...full.slice(0, 9)]);
  });
});
