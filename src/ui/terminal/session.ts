// The panel's terminal store singleton and the pane's open state (module state: survives re-renders and
// hiding the pane). `startTerminals()` runs at panel startup (src/ui/panel/main.tsx) so terminals the worker
// hands back after a panel reload (`pty-attached`) are picked up even before the pane is shown.
import { useEffect, useState } from 'preact/hooks';
import { postPty, subscribePty } from '../panel/claudeLink';
import { TerminalStore } from './store';
import { createXtermSink } from './xterm';

let store: TerminalStore | null = null;
let paneOpen = false;
const paneListeners = new Set<(open: boolean) => void>();
let startedHandler: ((typedCwd: string) => void) | null = null;

/** The panel's terminal sessions. */
export function terminalStore(): TerminalStore {
  if (!store) {
    const created: TerminalStore = new TerminalStore({
      post: postPty,
      subscribe: (fn) =>
        subscribePty((event) => {
          fn(event);
          // A terminal that outlived a panel reload: show it again.
          if (event.t === 'pty-attached') setTerminalPaneOpen(true);
        }),
      createTerm: ({ key }) => createXtermSink((data) => created.input(key, data)),
      onStarted: (dir) => startedHandler?.(dir),
    });
    store = created;
  }
  return store;
}

/** Create the store now (panel startup). */
export function startTerminals(): void {
  terminalStore();
}

/** Called with the typed working directory whenever a session starts running (recent directories). */
export function onTerminalStarted(fn: ((typedCwd: string) => void) | null): void {
  startedHandler = fn;
}

export function isTerminalPaneOpen(): boolean {
  return paneOpen;
}

export function setTerminalPaneOpen(open: boolean): void {
  if (open === paneOpen) return;
  paneOpen = open;
  for (const fn of [...paneListeners]) fn(open);
}

/** [open, setOpen] of the terminal pane. */
export function useTerminalPane(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(paneOpen);
  useEffect(() => {
    setOpen(paneOpen);
    paneListeners.add(setOpen);
    return () => {
      paneListeners.delete(setOpen);
    };
  }, []);
  return [open, setTerminalPaneOpen];
}

/** Re-render on every store change; returns the store. */
export function useTerminalStore(): TerminalStore {
  const s = terminalStore();
  const [, setRevision] = useState(s.revision);
  useEffect(() => {
    setRevision(s.revision);
    return s.subscribe(() => setRevision(s.revision));
  }, [s]);
  return s;
}
