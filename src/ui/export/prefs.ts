// OWNER: ui-export agent. Export-tab preferences that are not Settings (format and target live in Settings):
// sub-view, annotate / include-examples toggles, excluded roles, chosen Claude session (remembered in the
// panel's own localStorage, shared by every tab's overlay) and per-entry base names (page lifetime only).
// The one-shot actions (copy from the context menu) honour the same choices as the tab.
import { useEffect, useState } from 'preact/hooks';
import type { TypeRole } from './pipeline';
import { TYPE_ROLES } from './pipeline';

export type ExportView = 'types' | 'prompt';

export interface ExportPrefs {
  view: ExportView;
  annotate: boolean;
  includeExamples: boolean;
  exclude: ReadonlySet<TypeRole>;
  /** Claude Code session the prompt goes to; null = every connected session. */
  sessionId: string | null;
}

const STORAGE_KEY = 'reqlens:export-prefs';

const DEFAULT_PREFS: ExportPrefs = {
  view: 'types',
  annotate: true,
  includeExamples: true,
  exclude: new Set(),
  sessionId: null,
};

let prefs: ExportPrefs = load();
const listeners = new Set<() => void>();

/** The panel page's localStorage (null outside a window, e.g. unit tests under Node). */
function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function load(): ExportPrefs {
  try {
    const raw = storage()?.getItem(STORAGE_KEY) ?? null;
    if (!raw) return DEFAULT_PREFS;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const exclude = Array.isArray(v.exclude) ? v.exclude.filter((r): r is TypeRole => TYPE_ROLES.includes(r as TypeRole)) : [];
    return {
      view: v.view === 'prompt' ? 'prompt' : 'types',
      annotate: v.annotate !== false,
      includeExamples: v.includeExamples !== false,
      exclude: new Set(exclude),
      sessionId: typeof v.sessionId === 'string' ? v.sessionId : null,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function save(): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ ...prefs, exclude: [...prefs.exclude] }));
  } catch {
    /* storage full / disabled: keep the in-memory value */
  }
}

export function getExportPrefs(): ExportPrefs {
  return prefs;
}

export function setExportPrefs(patch: Partial<ExportPrefs>): void {
  prefs = { ...prefs, ...patch };
  save();
  for (const fn of [...listeners]) fn();
}

/** Toggle one role in or out of the generated types. */
export function toggleRole(role: TypeRole, included: boolean): void {
  const exclude = new Set(prefs.exclude);
  if (included) exclude.delete(role);
  else exclude.add(role);
  setExportPrefs({ exclude });
}

/** Preact hook over the prefs. */
export function useExportPrefs(): ExportPrefs {
  const [value, setValue] = useState(prefs);
  useEffect(() => {
    const update = () => setValue(prefs);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return value;
}

// --------------------------------------------------------------------------------------------- base names

const BASE_NAMES_MAX = 500;
/** Base name typed by the user per entry id (absent = the suggestion). */
const baseNames = new Map<string, string>();

export function getBaseNameOverride(entryId: string): string | undefined {
  return baseNames.get(entryId);
}

/** Remember (or with null forget) the base name typed for an entry. */
export function setBaseNameOverride(entryId: string, text: string | null): void {
  baseNames.delete(entryId);
  if (text === null) return;
  if (baseNames.size >= BASE_NAMES_MAX) baseNames.delete(baseNames.keys().next().value as string);
  baseNames.set(entryId, text);
}
