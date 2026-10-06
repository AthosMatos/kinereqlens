// Detecting pages kineReqLens cannot run on, and injecting the content scripts on demand into tabs that were
// loaded before the extension was installed / reloaded.
import type { TabMessage } from '../shared/messages';
import { errorMessage, isRecord } from './util';

/** Schemes extensions can never script. */
const RESTRICTED_SCHEMES = new Set([
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'chrome-search:',
  'chrome-devtools:',
  'chrome-error:',
  'devtools:',
  'edge:',
  'extension:',
  'edge-devtools:',
  'view-source:',
  'about:',
  'data:',
  'javascript:',
  'blob:',
  'filesystem:',
  'opera:',
  'brave:',
  'vivaldi:',
]);

/** about: pages content scripts may still reach (match_about_blank). */
const SCRIPTABLE_ABOUT = new Set(['about:blank', 'about:srcdoc']);

/** Extension galleries refuse every content script. [host, path prefix] */
const GALLERIES: Array<[string, string]> = [
  ['chromewebstore.google.com', '/'],
  ['chrome.google.com', '/webstore'],
  ['microsoftedge.microsoft.com', '/addons'],
];

/**
 * True when kineReqLens cannot run on `url`: browser-internal schemes (edge://, chrome://, extension pages,
 * view-source:, devtools), extension galleries, and the built-in PDF viewer. Pages it does not know about
 * return false; injection failure is the final arbiter.
 */
export function isRestrictedUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme === 'about:') return !SCRIPTABLE_ABOUT.has(`about:${parsed.pathname}`.toLowerCase());
  if (RESTRICTED_SCHEMES.has(scheme)) return true;
  if (scheme !== 'http:' && scheme !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  return GALLERIES.some(([galleryHost, prefix]) => host === galleryHost && (prefix === '/' || path === prefix || path.startsWith(`${prefix}/`)));
}

export type ProbeResult = { ok: true } | { ok: false; reason: 'restricted' | 'pdf' | 'file-access'; detail?: string };

/**
 * Check that the top frame can be scripted and is not the PDF viewer (document.contentType). Fails for
 * restricted pages, error pages and file:// pages without "Allow access to file URLs".
 */
export async function probeTopFrame(tabId: number, url: string | undefined): Promise<ProbeResult> {
  try {
    const [first] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => document.contentType,
      injectImmediately: true,
    });
    if (first?.result === 'application/pdf') return { ok: false, reason: 'pdf' };
    return { ok: true };
  } catch (err) {
    const fileUrl = url?.toLowerCase().startsWith('file:') === true;
    return { ok: false, reason: fileUrl ? 'file-access' : 'restricted', detail: errorMessage(err) };
  }
}

/** True when content.js answers in the tab's top frame. */
export async function pingTopFrame(tabId: number): Promise<boolean> {
  try {
    const ping: TabMessage = { type: 'PING' };
    const reply: unknown = await chrome.tabs.sendMessage(tabId, ping, { frameId: 0 });
    return isRecord(reply) && reply.ok === true;
  } catch {
    return false;
  }
}

/**
 * Inject hook.js (MAIN world) and content.js (isolated world) into every frame of the tab. Both scripts
 * guard against double installation. Resolves false when the top frame cannot be scripted.
 */
export async function injectContentScripts(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['hook.js'],
      world: 'MAIN',
      injectImmediately: true,
    });
  } catch (err) {
    // Without the hook the overlay still works (webRequest capture, extension-mode replays).
    console.warn('[kineReqLens] hook injection failed', err);
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
      injectImmediately: true,
    });
    return true;
  } catch (err) {
    console.warn('[kineReqLens] content script injection failed', err);
    return false;
  }
}
