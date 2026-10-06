// "Send to Claude" screenshots on the hub (mcp/src/shots.ts): `shot-save` chunks from the extension → a 0600 PNG in a
// 0700 $REQLENS_HOME/shots, answered with its absolute path; validation (order, PNG signature, size); retention (24 h,
// file / byte caps, on start and periodically); run screenshots cleaned without touching these; inbox pushes with
// screenshots outside the folder dropped; the inbox tool's image content.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../src/shared/claude-protocol';
import { HUB_FEATURE_SHOTS, SHOT_CHUNK_CHARS, chunkBase64 } from '../../../src/shared/shot-protocol';
import type { ShotFromHost } from '../../../src/shared/shot-protocol';
import type { Hub } from '../hub';
import { ShotStore } from '../shots';
import { inboxContent, inboxImageContent } from '../tools';
import { type FakeExtension, RawSession, removeDir, sleep, startHub, tempDir, waitFor } from './helpers';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');

/** A PNG of about `bytes` bytes (signature + padding: the hub only checks the signature and size). */
function pngOf(bytes: number): string {
  const buf = Buffer.alloc(bytes, 7);
  PNG.copy(buf, 0, 0, 8);
  return buf.toString('base64');
}

function sendShot(ext: FakeExtension, id: string, base64: string, name = 'shot.png'): void {
  const chunks = chunkBase64(base64);
  chunks.forEach((data, seq) => ext.send({ t: 'shot-save', id, seq, total: chunks.length, data, ...(seq === 0 ? { name } : {}) }));
}

const mode = (file: string): number => fs.statSync(file).mode & 0o777;

describe('hub screenshots (shot-save)', () => {
  let root: string;
  let home: string;
  let hub: Hub;
  let ext: FakeExtension;

  beforeEach(async () => {
    root = tempDir();
    home = path.join(root, 'home');
    ({ hub, ext } = await startHub(home));
    ext.sendHello();
  });

  afterEach(async () => {
    await hub?.stop();
    removeDir(root);
  });

  it('announces the feature', async () => {
    const hello = await ext.nth('hello', 1);
    expect(hello.features).toContain(HUB_FEATURE_SHOTS);
  });

  it('assembles chunks into a 0600 PNG in a 0700 folder and answers the absolute path', async () => {
    const big = pngOf(SHOT_CHUNK_CHARS); // base64 is 4/3 longer: 2 chunks
    expect(chunkBase64(big).length).toBeGreaterThan(1);
    sendShot(ext, 'shot-abc', big);
    const saved = await ext.nth('shot-saved', 1);
    const shots = path.join(home, 'shots');
    expect(saved).toEqual({ t: 'shot-saved', id: 'shot-abc', path: path.join(shots, 'shot-abc.png'), bytes: SHOT_CHUNK_CHARS });
    expect(path.isAbsolute(saved.path)).toBe(true);
    expect(fs.readFileSync(saved.path).equals(Buffer.from(big, 'base64'))).toBe(true);
    expect(mode(saved.path)).toBe(0o600);
    expect(mode(shots)).toBe(0o700);
  });

  it('refuses non-PNG data, out-of-order chunks, foreign ids and duplicates', async () => {
    sendShot(ext, 'shot-gif', Buffer.from('GIF89a........').toString('base64'));
    ext.send({ t: 'shot-save', id: 'shot-ooo', seq: 0, total: 3, data: PNG_B64.slice(0, 8) });
    ext.send({ t: 'shot-save', id: 'shot-ooo', seq: 2, total: 3, data: 'AAAA' });
    ext.send({ t: 'shot-save', id: 'shot-late', seq: 1, total: 2, data: 'AAAA' });
    // Invalid at the frame level (not a file id): dropped by the parser, never answered.
    ext.send({ t: 'shot-save', id: '../evil', seq: 0, total: 1, data: PNG_B64 });
    const errors = await waitFor(() => (ext.of('shot-error').length >= 3 ? ext.of('shot-error') : undefined));
    expect(errors).toEqual([
      { t: 'shot-error', id: 'shot-gif', error: 'Not a PNG image' },
      { t: 'shot-error', id: 'shot-ooo', error: 'Screenshot chunks out of order' },
      { t: 'shot-error', id: 'shot-late', error: 'Unknown screenshot upload' },
    ]);
    sendShot(ext, 'shot-dup', PNG_B64);
    await ext.nth('shot-saved', 1);
    sendShot(ext, 'shot-dup', PNG_B64);
    const dup = await ext.nth('shot-error', 4);
    expect(dup.error).toContain('Could not save the screenshot');
    expect(fs.readdirSync(path.join(home, 'shots'))).toEqual(['shot-dup.png']);
    expect(hub.shots.pending).toBe(0);
  });

  it('drops inbox pushes whose screenshots are outside the shots folder', async () => {
    const session = await RawSession.connect(hub.socketPath);
    try {
      session.hello('s1');
      await session.nth('hello', 1);
      const image = { path: path.join(home, 'shots', 'shot-1.png'), name: 'a.png', width: 1, height: 1 };
      const item: InboxItem = { id: 'i1', sentAt: 1, tabId: 1, entryId: '', title: 'Screenshot', target: 'explain', prompt: 'Look', sessionId: 's1', images: [image] };
      ext.send({ t: 'push', item: { ...item, id: 'bad', images: [{ ...image, path: '/etc/shot-1.png' }] } });
      ext.send({ t: 'push', item });
      const push = await session.nth('push', 1);
      expect(push.item).toEqual(item);
      await sleep(100);
      expect(session.of('push')).toHaveLength(1);
    } finally {
      session.close();
    }
  });
});

describe('ShotStore retention', () => {
  let dir: string;
  let sent: ShotFromHost[];
  beforeEach(() => {
    dir = path.join(tempDir(), 'shots');
    fs.mkdirSync(dir, { mode: 0o700 });
    sent = [];
  });
  afterEach(() => removeDir(path.dirname(dir)));

  const touch = (name: string, ageMs: number, bytes = 10): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.alloc(bytes));
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, t, t);
    return file;
  };

  it('deletes screenshots older than 24 h (only shot-*.png), on start', () => {
    touch('shot-old.png', 25 * 3600_000);
    touch('shot-new.png', 3600_000);
    touch('run-0a.png', 25 * 3600_000);
    touch('notes.txt', 25 * 3600_000);
    const store = new ShotStore({ dir, send: (m) => sent.push(m) });
    store.start();
    store.stop();
    expect(fs.readdirSync(dir).sort()).toEqual(['notes.txt', 'run-0a.png', 'shot-new.png']);
  });

  it('keeps at most N files / M bytes, oldest out first, never the one just written', () => {
    for (let i = 0; i < 5; i++) touch(`shot-f${i}.png`, (10 - i) * 60_000, 100);
    const store = new ShotStore({ dir, send: (m) => sent.push(m), maxFiles: 3 });
    expect(store.prune()).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual(['shot-f2.png', 'shot-f3.png', 'shot-f4.png']);
    const bytes = new ShotStore({ dir, send: (m) => sent.push(m), maxTotalBytes: 150 });
    expect(bytes.prune()).toBe(2);
    expect(fs.readdirSync(dir)).toEqual(['shot-f4.png']);
    // A new upload is written, then the caps make room by removing older ones.
    const capped = new ShotStore({ dir, send: (m) => sent.push(m), maxFiles: 1 });
    capped.handle({ t: 'shot-save', id: 'shot-new', seq: 0, total: 1, data: PNG_B64 });
    expect(sent).toEqual([{ t: 'shot-saved', id: 'shot-new', path: path.join(dir, 'shot-new.png'), bytes: PNG.length }]);
    expect(fs.readdirSync(dir)).toEqual(['shot-new.png']);
  });

  it('prunes periodically and refuses too large images', async () => {
    let now = Date.now();
    const store = new ShotStore({ dir, send: (m) => sent.push(m), now: () => now, pruneIntervalMs: 20, maxBytes: 64 });
    store.start();
    touch('shot-a.png', 0);
    now += 25 * 3600_000;
    await waitFor(() => !fs.existsSync(path.join(dir, 'shot-a.png')), 2000, 'periodic prune');
    store.handle({ t: 'shot-save', id: 'shot-big', seq: 0, total: 1, data: pngOf(100) });
    expect(sent.at(-1)).toMatchObject({ t: 'shot-error', id: 'shot-big', error: expect.stringContaining('too large') });
    store.stop();
    store.handle({ t: 'shot-save', id: 'shot-x', seq: 0, total: 1, data: PNG_B64 });
    expect(sent.at(-1)).toMatchObject({ t: 'shot-error', id: 'shot-x', error: expect.stringContaining('stopping') });
  });

  it('drops an incomplete upload after the timeout', async () => {
    const store = new ShotStore({ dir, send: (m) => sent.push(m), uploadTimeoutMs: 20 });
    store.handle({ t: 'shot-save', id: 'shot-slow', seq: 0, total: 2, data: 'iVBORw0K' });
    expect(store.pending).toBe(1);
    await waitFor(() => store.pending === 0, 2000, 'upload timeout');
    store.handle({ t: 'shot-save', id: 'shot-slow', seq: 1, total: 2, data: 'AAAA' });
    expect(sent.at(-1)).toEqual({ t: 'shot-error', id: 'shot-slow', error: 'Unknown screenshot upload' });
  });

  it('run screenshot cleanup leaves Send-to-Claude screenshots alone', async () => {
    const root = tempDir();
    try {
      const shots = path.join(root, 'home', 'shots');
      fs.mkdirSync(shots, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(shots, 'run-0123abcd.png'), PNG);
      fs.writeFileSync(path.join(shots, 'upload-0123abcd.png'), PNG);
      fs.writeFileSync(path.join(shots, 'shot-keep.png'), PNG);
      const { hub } = await startHub(path.join(root, 'home'));
      expect(fs.readdirSync(shots)).toEqual(['shot-keep.png']);
      await hub.stop();
      expect(fs.readdirSync(shots)).toEqual(['shot-keep.png']);
    } finally {
      removeDir(root);
    }
  });
});

describe('inbox tool image content', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(tempDir(), 'shots');
    fs.mkdirSync(dir);
  });
  afterEach(() => removeDir(path.dirname(dir)));

  it('returns the PNG inline, the path when too large / missing / foreign, and plain text for old items', () => {
    const file = path.join(dir, 'shot-1.png');
    fs.writeFileSync(file, PNG);
    const image = { path: file, name: 'shot.png', width: 1, height: 1 };
    const inline = inboxImageContent(image, dir);
    expect(inline).toEqual([
      { type: 'text', text: `Screenshot "shot.png" (1 × 1 px): ${file} (also readable with the Read tool):` },
      { type: 'image', data: PNG_B64, mimeType: 'image/png' },
    ]);
    expect(inboxImageContent(image, dir, 10)[0]).toMatchObject({ type: 'text', text: expect.stringContaining('too large to return inline: view it with the Read tool') });
    expect(inboxImageContent({ ...image, path: path.join(dir, 'shot-2.png') }, dir)[0]).toMatchObject({ text: expect.stringContaining('the file is gone') });
    expect(inboxImageContent({ ...image, path: '/etc/shot-1.png' }, dir)[0]).toMatchObject({ text: expect.stringContaining('not a kineReqLens screenshot file') });
    fs.writeFileSync(path.join(dir, 'shot-3.png'), 'not a png');
    expect(inboxImageContent({ ...image, path: path.join(dir, 'shot-3.png') }, dir)[0]).toMatchObject({ text: expect.stringContaining('not a PNG') });

    const item: InboxItem = { id: 'i1', sentAt: 1_700_000_000_000, tabId: 3, entryId: '', title: 'Screenshot · a.test: Look', target: 'explain', prompt: 'Look', images: [image] };
    const content = inboxContent([item], 0, dir);
    expect(content).toHaveLength(3);
    expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('tab 3 · 1 screenshot · sent') });
    expect((content[0] as { text: string }).text).toContain(`Screenshot: ${file} (use the Read tool to view it)`);
    expect((content[0] as { text: string }).text).not.toContain('request ``');
    expect(content[2]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const old = inboxContent([{ ...item, entryId: 'h:1', target: 'client', images: undefined }], 0, dir);
    expect(old).toHaveLength(1);
    expect((old[0] as { text: string }).text).toContain('request `h:1` · tab 3 · target client');
  });
});
