// Setups: user actions (persist through the list-config state + toasts with Undo). Pure decisions live in
// model.ts; this module only talks to the bridge, the toasts and the DOM (file download).
import { uid } from '../../lib/ids';
import type { ReqlensBridge, Setup } from '../../shared/types';
import { toast } from '../components/toast';
import { getUiRoot } from '../components/root';
import { currentListConfig, persistListConfig } from '../list/listState';
import {
  applySetupPatch,
  captureConfig,
  createSetup,
  duplicateSetup,
  exportFileName,
  exportSetups,
  importSetups,
  importSummary,
  moveSetupToGroup,
  removeSetup,
  renameSetup,
  restorePatch,
  restoreSetup,
  setSetupSites,
  updateSetupConfig,
} from './model';
import type { ImportMode, ListConfigState } from './model';
import { primaryLanguage, siteKeyOf } from '../../shared/language';

/** Toast group: a newer setups toast replaces the previous one (only the latest change can be undone). */
const SETUP_TOASTS = 'setups';

/** The list configuration as shown right now (pending local edits included). */
export function listConfigState(bridge: ReqlensBridge): ListConfigState {
  const config = currentListConfig(bridge);
  const settings = bridge.getSettings();
  return {
    listTypes: config.listTypes,
    listRules: config.listRules,
    defaultMode: settings.defaultMode,
    activeSetupId: config.activeSetupId,
    pageHost: siteKeyOf(bridge.getCaptureInfo().pageUrl),
    siteLanguages: settings.siteLanguages,
  };
}

function currentSetups(bridge: ReqlensBridge): Setup[] {
  return currentListConfig(bridge).setups;
}

/** Persist a new setups list (plus an optional active id). Nothing is written when the list is unchanged. */
function saveSetups(bridge: ReqlensBridge, setups: Setup[], activeSetupId?: string | null): void {
  const unchanged = setups === currentSetups(bridge);
  if (unchanged && activeSetupId === undefined) return;
  void persistListConfig(
    bridge,
    { ...(unchanged ? {} : { setups }), ...(activeSetupId !== undefined ? { activeSetupId } : {}) },
    'setups',
  );
}

/** Restores the setups list and the active id as they are now (for Undo). */
function setupsUndo(bridge: ReqlensBridge): () => void {
  const setups = currentSetups(bridge);
  const activeSetupId = currentListConfig(bridge).activeSetupId;
  return () => void persistListConfig(bridge, { setups, activeSetupId }, 'setups');
}

function quoted(setup: Pick<Setup, 'name'>): string {
  return `'${setup.name}'`;
}

/** Apply a setup; toasts with Undo (restores types, rules, mode and the active setup). */
export function applySetup(bridge: ReqlensBridge, setup: Setup, auto?: { host: string }): void {
  const before = listConfigState(bridge);
  const patch = applySetupPatch(setup, {
    now: Date.now(),
    newId: () => uid('r'),
    pageHost: before.pageHost ?? null,
    ...(before.siteLanguages ? { siteLanguages: before.siteLanguages } : {}),
  });
  void persistListConfig(bridge, patch, 'the setup');
  // A new site language reaches requests and the page's language APIs at once; the loaded page needs a reload.
  const language = patch.siteLanguages && setup.config.language ? ` — language ${primaryLanguage(setup.config.language)}, reload to apply fully` : '';
  const text = auto ? `Applied setup ${quoted(setup)} for ${auto.host}` : `Applied setup ${quoted(setup)}`;
  toast(`${text}${language}`, 'info', {
    replace: SETUP_TOASTS,
    action: { label: 'Undo', onClick: () => void persistListConfig(bridge, restorePatch(before), 'the setup') },
  });
}

/** A setup matches the page, but the active setup has unsaved changes: offer it instead of applying it. */
export function offerSetup(bridge: ReqlensBridge, setup: Setup, host: string): void {
  toast(`Setup ${quoted(setup)} matches ${host} — not applied over your unsaved changes`, 'info', {
    replace: SETUP_TOASTS,
    durationMs: 10_000,
    action: { label: 'Apply', onClick: () => applySetup(bridge, setup) },
  });
}

export interface SaveRequest {
  name: string;
  group: string;
  sites: string[];
  includeMode: boolean;
  /** Store the page's site language (when it has one). Default true. */
  includeLanguage?: boolean;
}

/** "Save current as…": a new setup with the current configuration, made the active one. */
export function saveCurrentAs(bridge: ReqlensBridge, req: SaveRequest): Setup | null {
  const config = captureConfig(listConfigState(bridge), { includeMode: req.includeMode, includeLanguage: req.includeLanguage ?? true });
  const setup = createSetup({ name: req.name, group: req.group, sites: req.sites, config }, { id: uid('s'), now: Date.now() });
  if (!setup) return null;
  const undo = setupsUndo(bridge);
  saveSetups(bridge, [...currentSetups(bridge), setup], setup.id);
  toast(`Saved setup ${quoted(setup)}`, 'success', { replace: SETUP_TOASTS, action: { label: 'Undo', onClick: undo } });
  return setup;
}

/** Store the current configuration in `setup` (keeps whether it stores a replay mode) and make it active. */
export function updateWithCurrent(bridge: ReqlensBridge, setup: Setup): void {
  const config = captureConfig(listConfigState(bridge), {
    includeMode: setup.config.defaultMode !== undefined,
    includeLanguage: setup.config.language !== undefined,
  });
  const undo = setupsUndo(bridge);
  saveSetups(bridge, updateSetupConfig(currentSetups(bridge), setup.id, config, Date.now()), setup.id);
  toast(`Updated setup ${quoted(setup)}`, 'success', { replace: SETUP_TOASTS, action: { label: 'Undo', onClick: undo } });
}

export function renameSetupAction(bridge: ReqlensBridge, setup: Setup, name: string): void {
  saveSetups(bridge, renameSetup(currentSetups(bridge), setup.id, name, Date.now()));
}

export function moveSetupAction(bridge: ReqlensBridge, setup: Setup, group: string): void {
  saveSetups(bridge, moveSetupToGroup(currentSetups(bridge), setup.id, group, Date.now()));
}

export function setSitesAction(bridge: ReqlensBridge, setup: Setup, sites: string[]): void {
  saveSetups(bridge, setSetupSites(currentSetups(bridge), setup.id, sites, Date.now()));
}

export function duplicateSetupAction(bridge: ReqlensBridge, setup: Setup): Setup | null {
  const done = duplicateSetup(currentSetups(bridge), setup.id, { id: uid('s'), now: Date.now() });
  if (!done.copy) {
    toast('Could not duplicate: too many setups', 'warn');
    return null;
  }
  const undo = setupsUndo(bridge);
  saveSetups(bridge, done.setups);
  toast(`Duplicated as ${quoted(done.copy)}${setup.sites.length ? ' (without its sites)' : ''}`, 'info', {
    replace: SETUP_TOASTS,
    action: { label: 'Undo', onClick: undo },
  });
  return done.copy;
}

/** Delete; toasts with Undo (puts it back where it was, active again if it was). */
export function deleteSetupAction(bridge: ReqlensBridge, setup: Setup): void {
  const wasActive = currentListConfig(bridge).activeSetupId === setup.id;
  const done = removeSetup(currentSetups(bridge), setup.id);
  if (!done.removed) return;
  const removed = done.removed;
  saveSetups(bridge, done.setups, wasActive ? null : undefined);
  toast(`Deleted setup ${quoted(removed)}`, 'info', {
    replace: SETUP_TOASTS,
    action: {
      label: 'Undo',
      onClick: () => saveSetups(bridge, restoreSetup(currentSetups(bridge), removed, done.index), wasActive ? removed.id : undefined),
    },
  });
}

/** Import parsed setups (merge or replace); toasts the outcome with Undo. */
export function importSetupsAction(bridge: ReqlensBridge, incoming: Setup[], mode: ImportMode): void {
  const undo = setupsUndo(bridge);
  const result = importSetups(currentSetups(bridge), incoming, mode, { now: Date.now(), newId: () => uid('s') });
  const active = currentListConfig(bridge).activeSetupId;
  const keepActive = active !== null && result.setups.some((s) => s.id === active);
  saveSetups(bridge, result.setups, keepActive ? undefined : null);
  toast(`${mode === 'replace' ? 'Replaced setups' : 'Imported setups'}: ${importSummary(result)}`, 'success', {
    replace: SETUP_TOASTS,
    action: { label: 'Undo', onClick: undo },
  });
}

/** Save `text` as a file (panel document; a blob URL clicked from a user gesture). */
export function downloadText(fileName: string, text: string, mime = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  (getUiRoot() ?? document.body).appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/** Export setups as a JSON file. */
export function exportSetupsAction(setups: readonly Setup[]): void {
  if (!setups.length) return;
  try {
    downloadText(exportFileName(setups, new Date()), exportSetups(setups));
    toast(setups.length === 1 ? `Exported setup ${quoted(setups[0]!)}` : `Exported ${setups.length} setups`, 'success');
  } catch (err) {
    toast(`Could not export: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}
