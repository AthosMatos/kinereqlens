import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../src/shared/claude-protocol';
import { BridgeError, HubClient } from '../client';
import { EXTENSION_GONE_ERROR, HUB_BUSY_ERROR, Hub, probeSocket } from '../hub';
import { encodeLine } from '../line-protocol';
import { hubSocketPath } from '../paths';
import { FakeExtension, RawSession, makeStaleSocket, removeDir, sleep, startHub, tempDir, waitFor } from './helpers';

const item = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: 'i1',
  sentAt: 1_700_000_000_000,
  tabId: 7,
  entryId: 'h:0:3',
  title: 'POST /api/orders',
  target: 'client',
  prompt: '# Implement POST /api/orders',
  sessionId: null,
  ...overrides,
});

let root: string;
let home: string;
const cleanups: Array<() => unknown> = [];

beforeEach(() => {
  root = tempDir();
  home = path.join(root, 'home');
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  removeDir(root);
});

async function hubWithSessions(...ids: string[]): Promise<{ hub: Hub; ext: FakeExtension; sessions: RawSession[] }> {
  const { hub, ext } = await startHub(home);
  cleanups.push(() => hub.stop());
  const sessions: RawSession[] = [];
  for (const id of ids) {
    const session = await RawSession.connect(hub.socketPath);
    cleanups.push(() => session.close());
    session.hello(id);
    await session.nth('hello', 1);
    sessions.push(session);
  }
  return { hub, ext, sessions };
}

describe('hub startup', () => {
  it('greets the extension, creates a private home and a 0600 socket', async () => {
    const { hub, ext } = await startHub(home);
    cleanups.push(() => hub.stop());
    expect(await ext.nth('hello', 1)).toEqual({ t: 'hello', v: 1, hostVersion: 'test-hub', features: ['fs', 'runs', 'shots'] });
    expect(await ext.nth('sessions', 1)).toEqual({ t: 'sessions', sessions: [] });
    expect(hub.socketPath).toBe(hubSocketPath(home));
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    expect(fs.statSync(hub.socketPath).isSocket()).toBe(true);
    expect(fs.statSync(hub.socketPath).mode & 0o777).toBe(0o600);
    expect(await probeSocket(hub.socketPath)).toBe('live');
  });

  it('recovers a stale socket file left by a killed hub', async () => {
    fs.mkdirSync(home, { recursive: true });
    const socketPath = hubSocketPath(home);
    makeStaleSocket(socketPath);
    expect(await probeSocket(socketPath)).toBe('stale');
    const { hub } = await startHub(home);
    cleanups.push(() => hub.stop());
    const session = await RawSession.connect(socketPath);
    cleanups.push(() => session.close());
    session.hello('s1');
    expect((await session.nth('hello', 1)).hostVersion).toBe('test-hub');
  });

  it('refuses to start when another live hub owns the socket, without touching it', async () => {
    const { hub: first } = await startHub(home);
    cleanups.push(() => first.stop());
    const ext2 = new FakeExtension();
    const second = new Hub({ home, input: ext2.input, output: ext2.output, version: 'test-hub-2' });
    expect(await second.start()).toEqual({ status: 'refused', reason: HUB_BUSY_ERROR });
    await second.closed;
    expect(ext2.of('hello')[0]).toMatchObject({ t: 'hello', error: HUB_BUSY_ERROR });
    expect(fs.existsSync(first.socketPath)).toBe(true);
    const session = await RawSession.connect(first.socketPath);
    cleanups.push(() => session.close());
    session.hello('still-works');
    expect((await session.nth('hello', 1)).hostVersion).toBe('test-hub');
  });

  it('does not delete a regular file in the socket place', async () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(hubSocketPath(home), 'not a socket');
    const ext = new FakeExtension();
    const hub = new Hub({ home, input: ext.input, output: ext.output, version: 't' });
    const result = await hub.start();
    expect(result.status).toBe('error');
    expect(fs.readFileSync(hubSocketPath(home), 'utf8')).toBe('not a socket');
  });

  it('reports a socket path that is too long for AF_UNIX', async () => {
    const deep = path.join(root, 'x'.repeat(120));
    const ext = new FakeExtension();
    const hub = new Hub({ home: deep, input: ext.input, output: ext.output, version: 't' });
    const result = await hub.start();
    expect(result.status).toBe('error');
    expect(ext.of('hello')[0]).toMatchObject({ error: expect.stringMatching(/shorter REQLENS_HOME/) });
  });
});

describe('hub sessions and routing', () => {
  it('lists sessions to the extension as they come and go', async () => {
    const { ext, sessions } = await hubWithSessions('a', 'b');
    const last = await ext.nth('sessions', 3);
    expect(last.sessions.map((s) => [s.id, s.label, s.cwd, s.pid])).toEqual([
      ['a', 'a', '/work/a', 4242],
      ['b', 'b', '/work/b', 4242],
    ]);
    expect(last.sessions[0]?.connectedAt).toBeGreaterThan(0);
    sessions[0]?.close();
    const after = await ext.nth('sessions', 4);
    expect(after.sessions.map((s) => s.id)).toEqual(['b']);
  });

  it('tells sessions about the extension in hello and when it connects', async () => {
    const { ext, sessions } = await hubWithSessions('a');
    expect(sessions[0]?.of('hello')[0]).toEqual({ t: 'hello', v: 1, hostVersion: 'test-hub', extension: { connected: false } });
    ext.sendHello();
    expect(await sessions[0]?.nth('ext', 1)).toEqual({ t: 'ext', connected: true, version: '0.2.0', browser: 'Edge 141' });
    const late = await RawSession.connect(hubSocketPath(home));
    cleanups.push(() => late.close());
    late.hello('late');
    expect((await late.nth('hello', 1)).extension).toEqual({ connected: true, version: '0.2.0', browser: 'Edge 141' });
  });

  it('routes requests by hub id even when two sessions reuse the same request id', async () => {
    const { ext, sessions } = await hubWithSessions('a', 'b');
    const [a, b] = sessions as [RawSession, RawSession];
    a.send({ t: 'req', id: '1', method: 'listRequests', params: { limit: 5 } });
    b.send({ t: 'req', id: '1', method: 'getRequest', params: { id: 'h:0:1' } });
    const reqA = await ext.nth('req', 1);
    const reqB = await ext.nth('req', 2);
    expect(reqA).toMatchObject({ sessionId: 'a', method: 'listRequests', params: { limit: 5 } });
    expect(reqB).toMatchObject({ sessionId: 'b', method: 'getRequest', params: { id: 'h:0:1' } });
    expect(reqA.id).not.toBe(reqB.id);
    // Answer out of order.
    ext.send({ t: 'res', id: reqB.id, ok: false, error: 'No such request' });
    ext.send({ t: 'res', id: reqA.id, ok: true, result: { total: 0 } });
    expect(await a.nth('res', 1)).toEqual({ t: 'res', id: '1', ok: true, result: { total: 0 } });
    expect(await b.nth('res', 1)).toEqual({ t: 'res', id: '1', ok: false, error: 'No such request' });
    // Each session got exactly its own answer.
    await sleep(30);
    expect(a.of('res')).toHaveLength(1);
    expect(b.of('res')).toHaveLength(1);
  });

  it('rejects unknown methods, bad params and requests before hello without bothering the extension', async () => {
    const { hub, ext, sessions } = await hubWithSessions('a');
    const [a] = sessions as [RawSession];
    a.send({ t: 'req', id: 'x', method: 'deleteEverything', params: {} });
    a.send({ t: 'req', id: 'y', method: 'status', params: [1, 2] });
    expect(await a.nth('res', 1)).toEqual({ t: 'res', id: 'x', ok: false, error: 'Unknown method: deleteEverything' });
    expect(await a.nth('res', 2)).toEqual({ t: 'res', id: 'y', ok: false, error: 'params must be an object' });
    const anon = await RawSession.connect(hub.socketPath);
    cleanups.push(() => anon.close());
    anon.send({ t: 'req', id: 'z', method: 'status', params: {} });
    expect(await anon.nth('res', 1)).toMatchObject({ id: 'z', ok: false, error: 'Send hello before requests' });
    await sleep(30);
    expect(ext.of('req')).toHaveLength(0);
  });

  it('addresses pushes to one session or to all, and drops pushes for unknown sessions', async () => {
    const { ext, sessions } = await hubWithSessions('a', 'b');
    const [a, b] = sessions as [RawSession, RawSession];
    ext.send({ t: 'push', item: item({ id: 'only-b', sessionId: 'b' }) });
    ext.send({ t: 'push', item: item({ id: 'nobody', sessionId: 'zzz' }) });
    ext.send({ t: 'push', item: item({ id: 'everyone', sessionId: null }) });
    expect((await b.nth('push', 1)).item.id).toBe('only-b');
    expect((await b.nth('push', 2)).item.id).toBe('everyone');
    expect((await a.nth('push', 1)).item.id).toBe('everyone');
    await sleep(30);
    expect(a.of('push')).toHaveLength(1);
    expect(b.of('push')).toHaveLength(2);
  });

  it('ignores malformed extension frames and pushes', async () => {
    const { ext, sessions } = await hubWithSessions('a');
    const [a] = sessions as [RawSession];
    ext.input.write(Buffer.from([3, 0, 0, 0, 0x7b, 0x7b, 0x7b]));
    ext.send({ t: 'push', item: { id: 'bad' } });
    ext.send({ t: 'mystery' });
    ext.send({ t: 'push', item: item({ id: 'good' }) });
    expect((await a.nth('push', 1)).item.id).toBe('good');
    expect(a.of('push')).toHaveLength(1);
  });

  it('drops over-long socket lines and keeps serving the session', async () => {
    const { hub, ext } = await startHub(home, { maxLineBytes: 1024 });
    cleanups.push(() => hub.stop());
    const s = await RawSession.connect(hub.socketPath);
    cleanups.push(() => s.close());
    s.hello('a');
    await s.nth('hello', 1);
    s.socket.write(`{"t":"req","id":"big","method":"status","params":{"x":"${'a'.repeat(5000)}"}}\n`);
    s.send({ t: 'req', id: 'small', method: 'status', params: {} });
    const req = await ext.nth('req', 1);
    expect(ext.of('req')).toHaveLength(1);
    ext.send({ t: 'res', id: req.id, ok: true, result: 'fine' });
    expect(await s.nth('res', 1)).toMatchObject({ id: 'small', ok: true });
  });

  it('answers requests that cannot fit a native message with an error', async () => {
    const { ext, sessions } = await hubWithSessions('a');
    const [a] = sessions as [RawSession];
    a.send({ t: 'req', id: 'huge', method: 'sendRequest', params: { id: 'h:0:1', overrides: { body: 'b'.repeat(1_100_000) } } });
    expect(await a.nth('res', 1)).toMatchObject({ id: 'huge', ok: false, error: expect.stringMatching(/too large/) });
    expect(ext.of('req')).toHaveLength(0);
  });

  it('turns a response too large for a socket line into an error', async () => {
    const { ext, sessions } = await hubWithSessions('a');
    const [a] = sessions as [RawSession];
    a.send({ t: 'req', id: 'big', method: 'getRequest', params: { id: 'h:0:1' } });
    const req = await ext.nth('req', 1);
    ext.send({ t: 'res', id: req.id, ok: true, result: 'x'.repeat(17 * 1024 * 1024) });
    expect(await a.nth('res', 1, 10_000)).toEqual({ t: 'res', id: 'big', ok: false, error: 'Response too large for the hub socket' });
  });

  it('drops a late response for a session that disconnected', async () => {
    const { ext, sessions } = await hubWithSessions('a', 'b');
    const [a, b] = sessions as [RawSession, RawSession];
    a.send({ t: 'req', id: '1', method: 'status', params: {} });
    const req = await ext.nth('req', 1);
    a.close();
    await ext.nth('sessions', 4);
    ext.send({ t: 'res', id: req.id, ok: true, result: {} });
    b.send({ t: 'req', id: '2', method: 'status', params: {} });
    const reqB = await ext.nth('req', 2);
    ext.send({ t: 'res', id: reqB.id, ok: true, result: 'b' });
    expect(await b.nth('res', 1)).toMatchObject({ id: '2', result: 'b' });
  });

  it('replaces a session that reconnects with the same id', async () => {
    const { hub, ext, sessions } = await hubWithSessions('a');
    const again = await RawSession.connect(hub.socketPath);
    cleanups.push(() => again.close());
    again.hello('a', 'a-again');
    await again.nth('hello', 1);
    await waitFor(() => sessions[0]?.closed, 2000, 'old connection closed');
    const last = await ext.nth('sessions', 3);
    expect(last.sessions.map((s) => s.label)).toEqual(['a-again']);
    expect(hub.sessionList).toHaveLength(1);
  });
});

describe('hub shutdown', () => {
  it('fails pending calls, tells sessions and removes the socket when the extension disconnects', async () => {
    const { hub, ext, sessions } = await hubWithSessions('a');
    const [a] = sessions as [RawSession];
    ext.sendHello();
    await a.nth('ext', 1);
    a.send({ t: 'req', id: 'p', method: 'getRequest', params: { id: 'selected' } });
    await ext.nth('req', 1);
    ext.disconnect();
    expect(await a.nth('res', 1)).toEqual({ t: 'res', id: 'p', ok: false, error: EXTENSION_GONE_ERROR });
    expect(await a.nth('ext', 2)).toEqual({ t: 'ext', connected: false });
    await hub.closed;
    await waitFor(() => a.closed, 2000, 'session socket closed');
    expect(fs.existsSync(hub.socketPath)).toBe(false);
  });

  it('stop() is idempotent', async () => {
    const { hub } = await startHub(home);
    await Promise.all([hub.stop(), hub.stop()]);
    await hub.stop();
    expect(fs.existsSync(hub.socketPath)).toBe(false);
  });
});

describe('HubClient (MCP side)', () => {
  const session = { id: 'sess-1', label: 'proj', cwd: '/work/proj', pid: 1 };

  /** A stand-in listening on the hub socket; its connections are destroyed on cleanup. */
  function fakeHubServer(onConnection: (socket: net.Socket) => void): net.Server {
    const sockets = new Set<net.Socket>();
    const server = net
      .createServer((socket) => {
        sockets.add(socket);
        socket.resume();
        onConnection(socket);
      })
      .listen(hubSocketPath(home));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(resolve);
        }),
    );
    return server;
  }

  function client(extra: Partial<ConstructorParameters<typeof HubClient>[0]> = {}): HubClient {
    const c = new HubClient({ socketPath: hubSocketPath(home), session, minBackoffMs: 20, maxBackoffMs: 100, ...extra });
    cleanups.push(() => c.close());
    return c;
  }

  it('says hello, calls methods and maps errors', async () => {
    const { hub, ext } = await startHub(home);
    cleanups.push(() => hub.stop());
    ext.sendHello();
    ext.responder = (req) =>
      req.method === 'status'
        ? { ok: true, result: { extensionVersion: '0.2.0', browser: 'Edge', tabs: [], allowSend: false, shareSecrets: false } }
        : { ok: false, error: 'No request with id nope' };
    const c = client();
    c.start();
    expect(await c.ensureConnected(2000)).toBe(true);
    expect(c.status()).toMatchObject({ state: 'connected', hostVersion: 'test-hub', extension: { connected: true, version: '0.2.0' } });
    const sessions = await ext.nth('sessions', 2);
    expect(sessions.sessions[0]).toMatchObject(session);
    expect(await c.call('status', {})).toMatchObject({ extensionVersion: '0.2.0' });
    await expect(c.call('getRequest', { id: 'nope' })).rejects.toMatchObject({ code: 'remote', message: 'No request with id nope' });
    const req = ext.of('req')[0];
    expect(req).toMatchObject({ sessionId: 'sess-1', method: 'status' });
  });

  it('times out unanswered calls', async () => {
    const { hub } = await startHub(home);
    cleanups.push(() => hub.stop());
    const c = client({ requestTimeoutMs: 100 });
    c.start();
    const error = await c.call('listTabs', {}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: 'timeout' });
  });

  it('reports not-connected quickly when no hub runs', async () => {
    const c = client();
    c.start();
    const started = Date.now();
    await expect(c.call('status', {})).rejects.toMatchObject({ code: 'not-connected' });
    expect(Date.now() - started).toBeLessThan(1600);
    expect(c.status().state).toBe('disconnected');
    expect(c.status().lastErrorCode).toBe('ENOENT');
  });

  it('connects as soon as a hub starts, fails pending calls when it stops, and reconnects to the next hub', async () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const statuses: string[] = [];
    const c = client({ minBackoffMs: 5000, maxBackoffMs: 5000, onStatus: (s) => statuses.push(s.state) });
    c.start();
    await waitFor(() => c.status().state === 'disconnected', 2000, 'first attempt failed');
    // The backoff is 5 s: only the socket-file watcher can make this fast.
    const { hub, ext } = await startHub(home);
    await waitFor(() => c.status().state === 'connected', 2000, 'connected via watcher');
    const pending = c.call('getTypes', { id: 'h:0:1' });
    await ext.nth('req', 1);
    ext.disconnect();
    await expect(pending).rejects.toMatchObject({ code: 'remote', message: EXTENSION_GONE_ERROR });
    await hub.closed;
    await waitFor(() => c.status().state === 'disconnected', 2000, 'disconnected');
    const second = await startHub(home);
    cleanups.push(() => second.hub.stop());
    await waitFor(() => c.status().state === 'connected', 2000, 'reconnected');
    expect(statuses).toContain('connecting');
  });

  it('delivers pushes for this session or for everyone, not for others', async () => {
    const { hub, ext } = await startHub(home);
    cleanups.push(() => hub.stop());
    const got: string[] = [];
    const c = client({ onPush: (pushed) => got.push(pushed.id) });
    c.start();
    await c.ensureConnected(2000);
    const other = await RawSession.connect(hub.socketPath);
    cleanups.push(() => other.close());
    other.hello('other');
    await other.nth('hello', 1);
    ext.send({ t: 'push', item: item({ id: 'mine', sessionId: 'sess-1' }) });
    ext.send({ t: 'push', item: item({ id: 'theirs', sessionId: 'other' }) });
    ext.send({ t: 'push', item: item({ id: 'all', sessionId: null }) });
    await waitFor(() => got.length >= 2, 2000, 'pushes');
    await sleep(30);
    expect(got).toEqual(['mine', 'all']);
  });

  it('does not report connected to a peer that accepts but never says hello', async () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fakeHubServer(() => undefined);
    const c = client();
    c.start();
    await expect(c.ensureConnected(300)).resolves.toBe(false);
    expect(c.status().state).toBe('connecting');
  });

  it('ignores garbage from the hub', async () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fakeHubServer((socket) => {
      socket.write('garbage\n');
      socket.write(encodeLine({ t: 'res', id: '999', ok: true, result: 1 }));
      socket.write(encodeLine({ t: 'hello', v: 1, hostVersion: 'fake', extension: { connected: true } }));
    });
    const c = client();
    c.start();
    expect(await c.ensureConnected(2000)).toBe(true);
    expect(c.status().hostVersion).toBe('fake');
  });
});
