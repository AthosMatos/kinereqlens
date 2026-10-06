// Test helpers for the bridge suites (node-only; run through tests/unit/mcp-*.test.ts): temp homes, a fake
// extension speaking native messaging over in-memory streams, a raw socket session, and polling waits.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { HostToExtension, HubToMcp } from '../../../src/shared/claude-protocol';
import { Hub, type HubOptions } from '../hub';
import { LineDecoder, encodeLine } from '../line-protocol';
import { NativeMessageDecoder, encodeNativeMessage } from '../nm-framing';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** A fresh temp directory (short path: Unix socket paths are limited to ~104 bytes). */
export function tempDir(prefix = 'rl-mcp-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Poll `check` until it returns a non-undefined value (or throw after `timeoutMs`). */
export async function waitFor<T>(check: () => T | undefined | false, timeoutMs = 3000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Responder = (req: Extract<HostToExtension, { t: 'req' }>) => { ok: true; result: unknown } | { ok: false; error: string } | null;

/** The browser side of native messaging, in memory. */
export class FakeExtension {
  /** Hub stdin. */
  readonly input = new PassThrough();
  /** Hub stdout. */
  readonly output = new PassThrough();
  readonly received: unknown[] = [];
  /** Answer `req` messages automatically (null = leave unanswered). */
  responder: Responder | null = null;

  constructor() {
    const decoder = new NativeMessageDecoder({
      onMessage: (message) => {
        this.received.push(message);
        const req = message as HostToExtension;
        if (req.t === 'req' && this.responder) {
          const answer = this.responder(req);
          if (answer) this.send({ t: 'res', id: req.id, ...answer });
        }
      },
    });
    this.output.on('data', (chunk: Buffer) => decoder.push(chunk));
  }

  send(message: unknown): void {
    this.input.write(encodeNativeMessage(message));
  }

  sendHello(): void {
    this.send({ t: 'hello', v: 1, extensionVersion: '0.2.0', extensionId: 'abcdefghijklmnopabcdefghijklmnop', browser: 'Edge 141' });
  }

  /** Messages of one type, in arrival order. */
  of<T extends HostToExtension['t']>(type: T): Array<Extract<HostToExtension, { t: T }>> {
    return this.received.filter((m) => (m as { t?: string }).t === type) as Array<Extract<HostToExtension, { t: T }>>;
  }

  /** Wait for the n-th (1-based) message of a type. */
  nth<T extends HostToExtension['t']>(type: T, n: number, timeoutMs = 3000): Promise<Extract<HostToExtension, { t: T }>> {
    return waitFor(() => this.of(type)[n - 1], timeoutMs, `extension message #${n} of type ${type}`);
  }

  /** The browser closes the native messaging port. */
  disconnect(): void {
    this.input.end();
  }
}

/** Start a hub on `home` with a fake extension. */
export async function startHub(home: string, extra: Partial<HubOptions> = {}): Promise<{ hub: Hub; ext: FakeExtension }> {
  const ext = new FakeExtension();
  const hub = new Hub({ home, input: ext.input, output: ext.output, version: 'test-hub', ...extra });
  const result = await hub.start();
  if (result.status !== 'listening') throw new Error(`hub did not start: ${result.status} ${'reason' in result ? result.reason : ''}`);
  return { hub, ext };
}

/** A raw NDJSON client of the hub socket (an MCP server without the MCP part). */
export class RawSession {
  readonly received: HubToMcp[] = [];
  closed = false;
  private constructor(readonly socket: net.Socket) {
    const decoder = new LineDecoder({ onMessage: (message) => this.received.push(message as HubToMcp) });
    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => undefined);
  }

  static connect(socketPath: string): Promise<RawSession> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once('connect', () => resolve(new RawSession(socket)));
      socket.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.socket.write(encodeLine(message));
  }

  hello(id: string, label = id, cwd = `/work/${id}`): void {
    this.send({ t: 'hello', v: 1, session: { id, label, cwd, pid: 4242 } });
  }

  of<T extends HubToMcp['t']>(type: T): Array<Extract<HubToMcp, { t: T }>> {
    return this.received.filter((m) => m.t === type) as Array<Extract<HubToMcp, { t: T }>>;
  }

  nth<T extends HubToMcp['t']>(type: T, n: number, timeoutMs = 3000): Promise<Extract<HubToMcp, { t: T }>> {
    return waitFor(() => this.of(type)[n - 1], timeoutMs, `hub message #${n} of type ${type}`);
  }

  close(): void {
    this.socket.destroy();
  }
}

let bundle: string | null = null;

/** Remove the bundle buildBundle() made (call from a file-level afterAll, so test runs leave no temp dirs). */
export function removeBundle(): void {
  if (!bundle) return;
  removeDir(path.dirname(bundle));
  bundle = null;
}

/** Build mcp/dist/reqlens-mcp.mjs into a temp dir once per test file (never touches mcp/dist). */
export function buildBundle(): string {
  if (bundle) return bundle;
  const out = path.join(tempDir('rl-mcp-bundle-'), 'reqlens-mcp.mjs');
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/build-mcp.mjs'), '--outfile', out], { cwd: REPO_ROOT, stdio: 'pipe' });
  bundle = out;
  return out;
}

/** Leaves a socket file nobody listens on (a hub killed with SIGKILL). */
export function makeStaleSocket(socketPath: string): void {
  const script = `const s=require('net').createServer().listen(${JSON.stringify(socketPath)},()=>process.kill(process.pid,'SIGKILL'))`;
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' });
  } catch {
    // Killed by design.
  }
  if (!fs.existsSync(socketPath)) throw new Error('stale socket was not left behind');
}
