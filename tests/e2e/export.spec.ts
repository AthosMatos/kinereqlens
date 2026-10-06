/**
 * v0.2 §A.2 — Export tab: Types (TypeScript / Zod / JSON Schema, persisted format, editable base name, Copy) and
 * Agent prompt (target, preview, Copy prompt, Send to Claude Code disabled with a reason while the bridge is off),
 * built from the captured request, the response and the test runs.
 */
import type { Frame, Page } from '@playwright/test';
import { expect, test, tid } from './fixtures';
import type { kineReqLens } from './fixtures';

const PATH = '/api/echo/json';

function panelFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().startsWith('chrome-extension://') && f.url().includes('/panel.html'));
  if (!frame) throw new Error('panel frame not found');
  return frame;
}

/** Record what the panel copies (navigator.clipboard.writeText) instead of touching the system clipboard. */
async function stubClipboard(page: Page): Promise<() => Promise<string[]>> {
  const frame = panelFrame(page);
  await frame.evaluate(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void w.__copied.push(text) },
    });
  });
  return () => frame.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
}

async function storedSettings(rl: kineReqLens): Promise<Record<string, unknown>> {
  const sw = await rl.sw();
  return sw.evaluate(async () => ((await chrome.storage.local.get('reqlens:settings'))['reqlens:settings'] ?? {}) as Record<string, unknown>);
}

test.describe('export tab', () => {
  test('types in three formats from the captured JSON request and response, persisted format, rename, copy', async ({ rl, page }) => {
    await rl.openApp();
    await rl.clickApp('json');
    await rl.select(PATH);
    const copied = await stubClipboard(page);

    await rl.ui.locator(tid('rl-export-tab')).click();
    const exportPane = rl.ui.locator(tid('rl-export'));
    await expect(exportPane).toBeVisible();
    const code = rl.ui.locator(tid('rl-export-code'));
    await expect(code).toContainText('export interface');
    // Request body (nested object hoisted, big integer flagged) and the echo response.
    await expect(code).toContainText('RequestBody');
    await expect(code).toContainText('Address');
    await expect(code).toContainText('exceeds 2^53');
    await expect(code).toContainText('Response');
    const format = rl.ui.locator(tid('rl-export-format'));
    await expect(format).toHaveAttribute('data-value', 'typescript');
    await expect(rl.ui.locator(tid('rl-export-notes'))).toContainText('Only one response sample');

    // Zod, persisted to settings.exportFormat.
    await format.locator('[data-value="zod"]').click();
    await expect(format).toHaveAttribute('data-value', 'zod');
    await expect(code).toContainText("import { z } from 'zod'");
    await expect(code).toContainText('z.object(');
    await expect.poll(async () => (await storedSettings(rl)).exportFormat).toBe('zod');

    // JSON Schema.
    await format.locator('[data-value="json-schema"]').click();
    await expect(code).toContainText('"$schema"');

    // Base name.
    await format.locator('[data-value="typescript"]').click();
    const name = rl.ui.locator(tid('rl-export-name'));
    await name.fill('CreateUser');
    await expect(code).toContainText('CreateUserRequestBody');
    await expect(code).toContainText('CreateUserResponse');

    await rl.ui.locator(tid('rl-export-copy')).click();
    await expect.poll(async () => (await copied()).length).toBe(1);
    const text = (await copied())[0]!;
    expect(text).toContain('export interface CreateUserRequestBody');
    expect(text).not.toMatch(/^\s*1\s/); // the line-number gutter is not copied

    // A test run refines the types without leaving the Export tab (a second sample: no "one sample" note).
    await rl.ui.locator(tid('rl-send')).click();
    await expect(exportPane).toBeVisible();
    await expect(rl.ui.locator(tid('rl-export-notes'))).not.toContainText('Only one response sample', { timeout: 15_000 });
  });

  test('agent prompt: targets, preview, copy, and Send to Claude Code disabled while the bridge is off', async ({ rl, page }) => {
    await rl.openApp();
    await rl.clickApp('json');
    await rl.select(PATH);
    const copied = await stubClipboard(page);
    await rl.ui.locator(tid('rl-export-tab')).click();
    await rl.ui.locator(tid('rl-export-prompt-tab')).click();

    const preview = rl.ui.locator(tid('rl-prompt-preview'));
    await expect(preview).toContainText('## Task');
    await expect(preview).toContainText('## Types');
    await expect(preview).toContainText('Add a typed API client function');
    const target = rl.ui.locator(tid('rl-prompt-target'));
    await target.locator('[data-value="server"]').click();
    await expect(preview).toContainText('Implement');
    await expect.poll(async () => (await storedSettings(rl)).promptTarget).toBe('server');

    await rl.ui.locator(tid('rl-prompt-copy')).click();
    await expect.poll(async () => (await copied()).length).toBe(1);
    const prompt = (await copied())[0]!;
    expect(prompt).toMatch(/^<!-- Generated by kineReqLens from http:\/\/127\.0\.0\.1:\d+ at /);
    expect(prompt).toContain('## Acceptance checklist');

    const send = rl.ui.locator(tid('rl-send-claude'));
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    await expect(rl.ui.locator(tid('rl-send-claude-reason'))).toContainText(/off/i);
    // "Set up" opens Settings at the Claude Code section.
    await rl.ui.locator(tid('rl-send-claude-setup')).click();
    await expect(rl.ui.locator(tid('rl-claude-section'))).toBeVisible();
    await expect(rl.ui.locator(tid('rl-claude-status'))).toContainText('Off');
    await expect(rl.ui.locator(tid('rl-claude-extension-id'))).toHaveText(new URL((await rl.sw()).url()).host);
  });

  test('secrets are redacted in exported types and prompts unless shared', async ({ rl, page }) => {
    await rl.gotoApp();
    await rl.openOverlay();
    await page.evaluate(() =>
      fetch('/api/echo/secret?api_key=sk_' + 'live_abcdefghijklmnopqrstuvwx', { headers: { Authorization: 'Bearer e2e-secret-token-1234567890' } }).then((r) => r.text()),
    );
    await rl.select('/api/echo/secret');
    const copied = await stubClipboard(page);
    await rl.ui.locator(tid('rl-export-tab')).click();
    await rl.ui.locator(tid('rl-export-prompt-tab')).click();
    await expect(rl.ui.locator(tid('rl-export-redact'))).toContainText(/redact/i);
    await rl.ui.locator(tid('rl-prompt-copy')).click();
    await expect.poll(async () => (await copied()).length).toBe(1);
    const prompt = (await copied())[0]!;
    expect(prompt).toContain('<redacted>');
    expect(prompt).not.toContain('e2e-secret-token-1234567890');
    expect(prompt).not.toContain('sk_' + 'live_abcdefghijklmnopqrstuvwx');

    // "Share secrets with Claude" turns redaction off for exports too.
    await rl.patchSettings({ claudeShareSecrets: true });
    await expect(rl.ui.locator(tid('rl-export-redact'))).toContainText(/included|shared/i);
    await rl.ui.locator(tid('rl-prompt-copy')).click();
    await expect.poll(async () => (await copied()).length).toBe(2);
    expect((await copied())[1]).toContain('e2e-secret-token-1234567890');
  });
});
