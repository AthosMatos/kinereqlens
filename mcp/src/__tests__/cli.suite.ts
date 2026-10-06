// The built CLI: argument handling, install / doctor / uninstall confined to temp dirs, and the real
// `native-host` process driven over its stdin/stdout like a browser would.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXTENSION_ID_UNPACKED } from '../../../src/shared/constants';
import { COMMANDS, UsageError, listValue, parseArgs, singleValue } from '../args';
import { HUB_BUSY_ERROR } from '../hub';
import { NativeMessageDecoder, encodeNativeMessage } from '../nm-framing';
import { hubLogPath, hubSocketPath } from '../paths';
import { RawSession, buildBundle, removeBundle, removeDir, tempDir, waitFor } from './helpers';

const ID = 'abcdefghijklmnopabcdefghijklmnop';


afterAll(() => removeBundle());

describe('argument parsing', () => {
  it('defaults to serve and reads repeatable / comma-separated flags', () => {
    expect(parseArgs([])).toMatchObject({ command: 'serve', help: false, version: false });
    const parsed = parseArgs(['install', '--extension-id', ID, '--extension-id=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '--browser', 'edge,chrome', '--home', '/tmp/x']);
    expect(parsed.command).toBe('install');
    expect(listValue(parsed, 'extension-id')).toEqual([ID, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
    expect(listValue(parsed, 'browser')).toEqual(['edge', 'chrome']);
    expect(singleValue(parsed, 'home')).toBe('/tmp/x');
    expect(parseArgs(['doctor', '-h']).help).toBe(true);
    expect(parseArgs(['--version']).version).toBe(true);
    expect(COMMANDS).toEqual(['serve', 'native-host', 'install', 'uninstall', 'doctor']);
  });

  it('lets native-host ignore what the browser appends', () => {
    expect(parseArgs(['native-host', `chrome-extension://${ID}/`, '--parent-window=0']).command).toBe('native-host');
  });

  it('rejects unknown commands, options and missing values', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(UsageError);
    expect(() => parseArgs(['install', '--force'])).toThrow(/Unknown option: --force/);
    expect(() => parseArgs(['install', '--home'])).toThrow(/--home needs a value/);
    expect(() => parseArgs(['install', '--home', '--browser', 'edge'])).toThrow(/--home needs a value/);
    expect(() => parseArgs(['install', 'extra'])).toThrow(/Unexpected argument: extra/);
  });
});

describe('reqlens-mcp CLI', () => {
  let bundle: string;
  let root: string;

  beforeAll(() => {
    bundle = buildBundle();
  }, 30_000);

  beforeEach(() => {
    root = tempDir();
  });

  afterEach(() => removeDir(root));

  /** Run the CLI with HOME pointing into the temp root (so nothing can reach real browser profiles). */
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [bundle, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(root, 'user'), REQLENS_HOME: path.join(root, 'envhome') },
    });

  it('prints help and version, fails on bad usage', () => {
    const help = run('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('reqlens-mcp install [--extension-id <id> ...]');
    expect(help.stdout).toContain('REQLENS_HOME');
    const version = run('--version');
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const bad = run('frobnicate');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('Unknown command: frobnicate');
    expect(bad.stdout).toBe('');
    expect(run('install', '--browser', 'netscape').stderr).toContain('Unknown browser "netscape"');
  });

  it('install / doctor / uninstall with --home and --manifest-dir', () => {
    const home = path.join(root, 'rl');
    const manifestDir = path.join(root, 'profile', 'NativeMessagingHosts');
    const manifestFile = path.join(manifestDir, 'com.reqlens.bridge.json');
    // No --extension-id: the unpacked build's fixed id.
    const byDefault = run('install', '--home', home, '--manifest-dir', manifestDir);
    expect(byDefault.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).allowed_origins).toEqual([`chrome-extension://${EXTENSION_ID_UNPACKED}/`]);
    const installed = run('install', '--home', home, '--manifest-dir', manifestDir, '--extension-id', ID);
    expect(installed.status).toBe(0);
    expect(installed.stdout).toContain('claude mcp add --scope user reqlens --');
    expect(installed.stdout).toContain(fs.realpathSync(bundle));
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    expect(manifest).toMatchObject({
      name: 'com.reqlens.bridge',
      path: path.join(home, 'native-host'),
      allowed_origins: [`chrome-extension://${EXTENSION_ID_UNPACKED}/`, `chrome-extension://${ID}/`],
    });
    const launcher = fs.readFileSync(path.join(home, 'native-host'), 'utf8');
    expect(launcher).toContain(`REQLENS_HOME="${home}"`);
    expect(launcher).toContain(`"${fs.realpathSync(bundle)}" native-host "$@"`);
    const doctor = run('doctor', '--home', home, '--manifest-dir', manifestDir);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('No problems found.');
    expect(doctor.stdout).toContain('[warn] Hub not running');
    expect(doctor.stdout).not.toContain('is not allowed');
    const removed = run('uninstall', '--home', home, '--manifest-dir', manifestDir);
    expect(removed.status).toBe(0);
    expect(fs.existsSync(path.join(manifestDir, 'com.reqlens.bridge.json'))).toBe(false);
    expect(run('doctor', '--home', home, '--manifest-dir', manifestDir).status).toBe(1);
    // Nothing was written under the (temp) user home.
    expect(fs.existsSync(path.join(root, 'user'))).toBe(false);
  });

  describe('native-host', () => {
    interface Host {
      child: ChildProcessWithoutNullStreams;
      frames: unknown[];
      decodeErrors: number;
      stdoutBytes: () => number;
      exit: Promise<number | null>;
    }

    const startHost = (home: string): Host => {
      const child = spawn(process.execPath, [bundle, 'native-host', `chrome-extension://${ID}/`], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(root, 'user'), REQLENS_HOME: home },
      });
      const host: Host = {
        child,
        frames: [],
        decodeErrors: 0,
        stdoutBytes: () => bytes,
        exit: new Promise((resolve) => child.on('exit', (code) => resolve(code))),
      };
      let bytes = 0;
      const decoder = new NativeMessageDecoder({
        onMessage: (message) => host.frames.push(message),
        onError: () => {
          host.decodeErrors += 1;
        },
      });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        decoder.push(chunk);
      });
      return host;
    };

    it('relays between the browser (stdin/stdout) and a session, logs to hub.log, exits when stdin closes', async () => {
      const home = path.join(root, 'rl');
      const host = startHost(home);
      await waitFor(() => host.frames.length >= 2, 5000, 'hello + sessions');
      expect(host.frames[0]).toMatchObject({ t: 'hello', v: 1 });
      expect(host.frames[1]).toEqual({ t: 'sessions', sessions: [] });
      host.child.stdin.write(encodeNativeMessage({ t: 'hello', v: 1, extensionVersion: '0.2.0', extensionId: ID, browser: 'Edge' }));
      const session = await RawSession.connect(hubSocketPath(home));
      session.hello('s1', 'proj');
      expect((await session.nth('hello', 1)).extension).toEqual({ connected: true, version: '0.2.0', browser: 'Edge' });
      session.send({ t: 'req', id: 'q1', method: 'listTabs', params: {} });
      const req = await waitFor(() => host.frames.find((f) => (f as { t?: string }).t === 'req') as { id: string; sessionId: string } | undefined);
      expect(req.sessionId).toBe('s1');
      const result = { tabs: [{ title: 'MARKER-captured-data' }] };
      host.child.stdin.write(encodeNativeMessage({ t: 'res', id: req.id, ok: true, result }));
      expect(await session.nth('res', 1)).toEqual({ t: 'res', id: 'q1', ok: true, result });
      host.child.stdin.end();
      expect(await host.exit).toBe(0);
      await waitFor(() => session.closed, 2000, 'session closed');
      expect(fs.existsSync(hubSocketPath(home))).toBe(false);
      // stdout carried nothing but complete native messaging frames.
      expect(host.decodeErrors).toBe(0);
      const frameBytes = host.frames.reduce<number>((sum, frame) => sum + encodeNativeMessage(frame).length, 0);
      expect(host.stdoutBytes()).toBe(frameBytes);
      const log = fs.readFileSync(hubLogPath(home), 'utf8');
      expect(log).toContain('native host');
      expect(log).toContain(`caller chrome-extension://${ID}/`);
      expect(log).toContain('session s1 connected');
      expect(log).not.toContain('MARKER-captured-data');
    });

    it('refuses a second browser while one is connected, and exits on SIGTERM', async () => {
      const home = path.join(root, 'rl');
      const first = startHost(home);
      await waitFor(() => first.frames.length >= 2, 5000, 'first hub up');
      const second = startHost(home);
      expect(await second.exit).toBe(1);
      expect(second.frames).toEqual([{ t: 'hello', v: 1, hostVersion: expect.any(String), error: HUB_BUSY_ERROR }]);
      expect(fs.existsSync(hubSocketPath(home))).toBe(true);
      first.child.kill('SIGTERM');
      expect(await first.exit).toBe(0);
      expect(fs.existsSync(hubSocketPath(home))).toBe(false);
    });
  });
});
