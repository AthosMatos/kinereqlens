// Hands the panel's resumable state (drafts, runs, selection) to the frame host, and restores it when this
// panel is a reload (the host re-created the iframe: the page removed it, or a dialog it was moved into).
import type { PanelUiStatePatch } from '../../shared/panel-protocol';
import { exportRecord, exportRuns, importRecords, subscribeRecords } from '../detail/draftStore';
import { getShellState, restoreShellState, subscribeShellState } from '../shellState';
import type { RemoteBridge } from './remote';

const SAVE_DELAY_MS = 400;

export function startUiStateHandoff(bridge: RemoteBridge): () => void {
  const saved = bridge.getUiState();
  if (saved) {
    importRecords(Object.values(saved.records ?? {}), saved.runs ?? {});
    restoreShellState(saved.shell);
  }
  const dirty = new Set<string>();
  /** Runs last handed over per entry (by identity: runs only travel again when they changed). */
  const sentRuns = new Map<string, unknown>();
  let shellDirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const patch: PanelUiStatePatch = {};
    if (dirty.size) {
      const records: Record<string, unknown | null> = {};
      const runs: Record<string, unknown | null> = {};
      for (const id of dirty) {
        records[id] = exportRecord(id);
        const list = exportRuns(id);
        if ((sentRuns.get(id) ?? null) !== list) {
          runs[id] = list;
          if (list) sentRuns.set(id, list);
          else sentRuns.delete(id);
        }
      }
      dirty.clear();
      patch.records = records;
      if (Object.keys(runs).length) patch.runs = runs;
    }
    if (shellDirty) {
      shellDirty = false;
      patch.shell = { ...getShellState() };
    }
    bridge.saveUiState(patch);
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, SAVE_DELAY_MS);
  };
  const offRecords = subscribeRecords((id) => {
    dirty.add(id);
    schedule();
  });
  const offShell = subscribeShellState(() => {
    shellDirty = true;
    schedule();
  });
  // Save right before the frame goes away (navigation of the page, host removed).
  const onHide = () => {
    if (timer) {
      clearTimeout(timer);
      flush();
    }
  };
  window.addEventListener('pagehide', onHide);
  return () => {
    offRecords();
    offShell();
    window.removeEventListener('pagehide', onHide);
    if (timer) clearTimeout(timer);
  };
}
