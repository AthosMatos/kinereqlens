/**
 * Prerendered navigations (speculation rules; Edge / Chrome also prerender from the address bar).
 *
 * Playwright's own page sessions disable prerendering (DevTools attached to the page), so this spec launches
 * Chromium itself and only attaches DevTools to the extension's service worker: probes and clicks go through
 * chrome.scripting from there.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { EXTENSION_DIR, expect, test } from './fixtures';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal CDP client over the browser's DevTools WebSocket. */
class Cdp {
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: unknown };
      const waiter = msg.id !== undefined ? this.waiting.get(msg.id) : undefined;
      if (!waiter || msg.id === undefined) return;
      this.waiting.delete(msg.id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    });
  }

  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    return new Cdp(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async evaluate<T = unknown>(sessionId: string, expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }

  close(): void {
    this.ws.close();
  }
}

interface Probe {
  url: string;
  overlay: boolean;
  wasPrerendering: boolean | null;
  hasUi: boolean;
  open: boolean | null;
  entries: string[];
  badge: string;
}

test.describe('prerender', () => {
  test('a prerendered page shows the overlay once it is activated', async ({ server }) => {
    test.setTimeout(90_000);
    const profile = mkdtempSync(path.join(os.tmpdir(), 'reqlens-e2e-prerender-'));
    let proc: ChildProcess | null = null;
    let cdp: Cdp | null = null;
    try {
      proc = spawn(
        chromium.executablePath(),
        [
          '--headless=new',
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          `--disable-extensions-except=${EXTENSION_DIR}`,
          `--load-extension=${EXTENSION_DIR}`,
          '--remote-debugging-port=0',
          'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let wsUrl: string | null = null;
      proc.stderr?.on('data', (d: Buffer) => {
        const m = /DevTools listening on (ws:\S+)/.exec(String(d));
        if (m) wsUrl = m[1]!;
      });
      for (let i = 0; i < 200 && !wsUrl; i++) await sleep(50);
      expect(wsUrl, 'DevTools endpoint').toBeTruthy();
      cdp = await Cdp.open(wsUrl!);

      // Attach to the kineReqLens service worker only (never to the page: that would disable prerendering).
      let sw: string | null = null;
      for (let i = 0; i < 100 && !sw; i++) {
        const { targetInfos } = await cdp.send<{ targetInfos: Array<{ type: string; url: string; targetId: string }> }>('Target.getTargets');
        for (const t of targetInfos.filter((x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'))) {
          const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.targetId, flatten: true });
          if ((await cdp.evaluate(sessionId, 'typeof globalThis.__reqlensToggle').catch(() => '')) === 'function') {
            sw = sessionId;
            break;
          }
        }
        if (!sw) await sleep(100);
      }
      expect(sw, 'kineReqLens service worker').toBeTruthy();
      const evalSw = <T,>(expr: string) => cdp!.evaluate<T>(sw!, expr);

      const probe = () =>
        evalSw<Probe>(`(async () => {
          const [tab] = await chrome.tabs.query({});
          const main = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: () => ({
            url: location.href, overlay: !!document.querySelector('reqlens-overlay'), wasPrerendering: window.__wasPrerendering ?? null }) });
          const iso = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({
            hasUi: !!globalThis.__reqlensUi, open: globalThis.__reqlens?.getTabState?.().open ?? null,
            entries: (globalThis.__reqlens?.getEntries?.() ?? []).map((e) => e.url.replace(location.origin, '')) }) });
          const badge = await chrome.action.getBadgeText({ tabId: tab.id });
          return { ...main[0].result, ...iso[0].result, badge };
        })()`);

      const A = `${server.origin}/prerender-a`;
      await evalSw(`(async () => { const [t] = await chrome.tabs.query({}); await chrome.tabs.update(t.id, { url: ${JSON.stringify(A)} }); })()`);
      await sleep(1000);
      // Open the overlay on A, then reload A: the prerender of B starts while the overlay is open.
      await evalSw(`(async () => { const [t] = await chrome.tabs.query({}); await __reqlensToggle(t); })()`);
      await sleep(800);
      await evalSw(`(async () => { const [t] = await chrome.tabs.query({}); await chrome.tabs.reload(t.id); })()`);
      await sleep(2500); // the prerender of B starts and finishes loading
      const onA = await probe();
      expect(onA.url).toBe(A);
      expect(onA.overlay).toBe(true);

      await evalSw(`(async () => { const [t] = await chrome.tabs.query({}); await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => document.getElementById('go').click() }); })()`);
      await expect
        .poll(async () => {
          const b = await probe().catch(() => null);
          return b && b.url.endsWith('/prerender-b') && b.overlay && b.hasUi;
        }, { timeout: 10_000 })
        .toBe(true);
      const onB = await probe();
      // B really was prerendered (otherwise this test proves nothing), and is now a normal open tab page.
      expect(onB.wasPrerendering).toBe(true);
      expect(onB.open).toBe(true);
      expect(onB.entries).toContain('/api/echo/b-load');
      await expect.poll(async () => (await probe()).badge, { timeout: 5000 }).not.toBe('');
    } finally {
      cdp?.close();
      proc?.kill();
      await sleep(300);
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
