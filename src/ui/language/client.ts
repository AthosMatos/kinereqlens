// "Site language" (docs/ARCHITECTURE.md §11), overlay side: the tab override lives in the service worker (asked
// with LANGUAGE_STATE / set with LANGUAGE_SET_TAB from this panel page), the site overrides in settings.siteLanguages
// (written through the bridge like every other setting). `useLanguageStatus` combines both for the page's host.
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { LanguageScope, LanguageStatus } from '../../shared/language';
import { effectiveLanguage, normalizeLanguageValue, sanitizeLanguageStatus, siteKeyOf, withSiteLanguage } from '../../shared/language';
import type { ReqlensBridge } from '../../shared/types';
import { useCaptureInfo, useSettings } from '../hooks';

/** The tab override as last reported by the worker (undefined: not asked yet). */
let tabValue: string | null | undefined;
let asking: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* one subscriber must not starve the others */
    }
  }
}

function canMessage(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id && typeof chrome.runtime.sendMessage === 'function';
  } catch {
    return false;
  }
}

async function ask(message: { type: 'LANGUAGE_STATE'; refresh?: boolean } | { type: 'LANGUAGE_SET_TAB'; value: string | null }): Promise<LanguageStatus | null> {
  if (!canMessage()) return null;
  try {
    const answer: unknown = await chrome.runtime.sendMessage(message);
    const status = sanitizeLanguageStatus(answer);
    if (status) {
      tabValue = status.tab;
      emit();
    }
    return status;
  } catch {
    return null;
  }
}

/** Ask the worker for this tab's state (once per panel unless `force`). `refresh` re-reads the stored settings. */
export function loadLanguageStatus(options: { force?: boolean; refresh?: boolean } = {}): Promise<void> {
  if (!options.force && !options.refresh && (tabValue !== undefined || asking)) return asking ?? Promise.resolve();
  const run: Promise<void> = ask({ type: 'LANGUAGE_STATE', ...(options.refresh ? { refresh: true } : {}) }).then(() => {
    if (asking === run) asking = null;
  });
  asking = run;
  return run;
}

/** This tab's override as last reported by the worker (null: none or not asked yet). For non-hook readers. */
export function tabLanguageOverride(): string | null {
  return tabValue ?? null;
}

/** Set (null: clear) this tab's own override; resolves once the worker's rules are in place. */
export async function setTabLanguage(value: string | null): Promise<LanguageStatus | null> {
  return ask({ type: 'LANGUAGE_SET_TAB', value });
}

/** Re-render on changes of the worker-side tab override. */
function useTabValue(): string | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    void loadLanguageStatus();
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return tabValue ?? null;
}

/** The page's language state: this tab's override, else the site's (settings.siteLanguages of the page host). */
export function useLanguageStatus(): LanguageStatus {
  const settings = useSettings();
  const capture = useCaptureInfo();
  const tab = useTabValue();
  const host = siteKeyOf(capture.pageUrl);
  return useMemo(() => effectiveLanguage(tab, settings.siteLanguages, host), [tab, settings.siteLanguages, host]);
}

export interface ApplyLanguageRequest {
  value: string;
  scope: LanguageScope;
  /** The page host (required for the site scope). */
  host: string | null;
}

/**
 * Apply an override. Tab scope: the worker keeps it until the tab closes (any site override stays, the tab's wins).
 * Site scope: saved in settings.siteLanguages for the host; a tab override of this tab is dropped so the site's
 * applies. Resolves once the worker's rules are in place (so a reload right after carries the header). Returns an
 * error message, or null.
 */
export async function applyLanguage(bridge: ReqlensBridge, req: ApplyLanguageRequest): Promise<string | null> {
  const value = normalizeLanguageValue(req.value);
  if (!value) return 'Enter a valid language';
  if (req.scope === 'tab') {
    const status = await setTabLanguage(value);
    return status?.tab === value ? null : 'The language could not be applied';
  }
  if (!req.host) return 'This page has no site to save a language for';
  const current = bridge.getSettings().siteLanguages;
  const next = withSiteLanguage(current, req.host, value);
  if (next[req.host] !== value) return 'Too many sites with a language — reset some first';
  await bridge.updateSettings({ siteLanguages: next });
  if (tabValue) await setTabLanguage(null);
  await loadLanguageStatus({ refresh: true });
  return null;
}

/** Back to the browser's languages on this page: drops this tab's override and the host's site override. */
export async function resetLanguage(bridge: ReqlensBridge, host: string | null): Promise<void> {
  if (tabValue) await setTabLanguage(null);
  const current = bridge.getSettings().siteLanguages;
  if (host && Object.prototype.hasOwnProperty.call(current, host)) {
    await bridge.updateSettings({ siteLanguages: withSiteLanguage(current, host, null) });
    await loadLanguageStatus({ refresh: true });
  }
}
