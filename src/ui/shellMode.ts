// Which shell hosts the UI: the in-page overlay (panel.html in the page's iframe) or the standalone React Native
// tab (app.html, src/ui/standalone/). Set once by the entry point before the first render; read by the pieces
// that word or hide page-only things (replay mode "Page" is "App" in the standalone tab, no page reload, no
// preserve log).
import type { ReplayMode } from '../shared/types';

export type ShellMode = 'overlay' | 'standalone';

let mode: ShellMode = 'overlay';

export function setShellMode(next: ShellMode): void {
  mode = next;
}

export function getShellMode(): ShellMode {
  return mode;
}

/** The standalone React Native tab. */
export function isStandaloneShell(): boolean {
  return mode === 'standalone';
}

/** Display name of a replay mode: 'page' runs inside the page — or inside the app in the standalone tab. */
export function replayModeName(replayMode: ReplayMode): string {
  if (replayMode === 'extension') return 'Extension';
  return mode === 'standalone' ? 'App' : 'Page';
}
