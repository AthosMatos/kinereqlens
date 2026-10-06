// xterm.js glue of the embedded Claude Code terminal: one Terminal + FitAddon per session (created by the
// store, opened into the pane when shown), theme colours from our design tokens, clipboard keys.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { copyText } from '../components/clipboard';
import type { TermSink } from './store';

/** A session's terminal: the store writes into it, the view opens / fits / focuses it. */
export interface XtermSink extends TermSink {
  readonly terminal: Terminal;
  readonly fit: FitAddon;
}

const ANSI = {
  light: {
    black: '#1f1f1f',
    brightBlack: '#666666',
    cyan: '#0b7a85',
    brightCyan: '#1497a3',
    white: '#8f8f8f',
    brightWhite: '#4d4d4f',
    brightRed: '#e5483d',
    brightGreen: '#1ba84b',
    brightYellow: '#c98500',
    brightBlue: '#2f56d6',
    brightMagenta: '#8a5ef0',
  },
  dark: {
    black: '#25262c',
    brightBlack: '#6b6d72',
    cyan: '#4fd1d9',
    brightCyan: '#7fe6ec',
    white: '#c6c8cb',
    brightWhite: '#ffffff',
    brightRed: '#ff8f87',
    brightGreen: '#6ee59a',
    brightYellow: '#ffd479',
    brightBlue: '#a3b5ef',
    brightMagenta: '#d2bdff',
  },
} as const;

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return value || fallback;
}

/** `#rrggbb` + alpha as `#rrggbbaa` (xterm parses it); other colour syntaxes are returned unchanged. */
function withAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  return `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}

/** xterm theme for the current kineReqLens theme, read from the tokens on `.rl-root` (fallbacks: tokens.css). */
export function terminalTheme(root: Element | null, mode: 'light' | 'dark'): ITheme {
  const style = root ? getComputedStyle(root) : null;
  const t = (name: string, fallback: string) => (style ? token(style, name, fallback) : fallback);
  const p = ANSI[mode];
  const dark = mode === 'dark';
  const accent = t('--rl-accent', dark ? '#7891de' : '#0230bb');
  return {
    background: t('--rl-bg-sunken', dark ? '#17181c' : '#f8f8f8'),
    foreground: t('--rl-text', dark ? '#dcdedf' : '#1f1f1f'),
    cursor: accent,
    cursorAccent: t('--rl-bg-sunken', dark ? '#17181c' : '#f8f8f8'),
    selectionBackground: withAlpha(accent, dark ? 0.34 : 0.2),
    black: p.black,
    red: t('--rl-danger', dark ? '#f0838e' : '#c42a3b'),
    green: t('--rl-ok', dark ? '#72cf89' : '#257a37'),
    yellow: t('--rl-warn', dark ? '#e9b44c' : '#8a5700'),
    blue: accent,
    magenta: t('--rl-m-patch', dark ? '#c3a6ef' : '#592594'),
    cyan: p.cyan,
    white: p.white,
    brightBlack: p.brightBlack,
    brightRed: p.brightRed,
    brightGreen: p.brightGreen,
    brightYellow: p.brightYellow,
    brightBlue: p.brightBlue,
    brightMagenta: p.brightMagenta,
    brightCyan: p.brightCyan,
    brightWhite: p.brightWhite,
  };
}

/** Monospace stack from the tokens. */
export function terminalFont(root: Element | null): string {
  const value = root ? getComputedStyle(root).getPropertyValue('--rl-font-mono').trim() : '';
  return value || "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
}

const isMac = (() => {
  try {
    return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  } catch {
    return false;
  }
})();

/**
 * Copy / paste keys: Cmd+C / Cmd+V on macOS, Ctrl+Shift+C / Ctrl+Shift+V elsewhere (Ctrl+C stays the
 * terminal's interrupt). Pastes are left to the browser, whose paste event xterm turns into input.
 */
function clipboardKeys(terminal: Terminal): (event: KeyboardEvent) => boolean {
  return (event) => {
    if (event.type !== 'keydown') return true;
    const key = event.key.toLowerCase();
    const combo = isMac ? event.metaKey && !event.ctrlKey && !event.altKey : event.ctrlKey && event.shiftKey && !event.altKey;
    if (!combo) return true;
    if (key === 'c') {
      if (terminal.hasSelection()) {
        event.preventDefault();
        void copyText(terminal.getSelection(), 'Copied from the terminal');
      }
      return false;
    }
    // Let the browser paste (xterm's paste handler sends it, bracketed when the app asked for it).
    if (key === 'v') return false;
    return true;
  };
}

/** A new xterm Terminal for a session (not opened yet: the pane opens it when it is shown). */
export function createXtermSink(onData: (data: string) => void): XtermSink {
  const terminal = new Terminal({
    allowProposedApi: false,
    cursorBlink: true,
    fontSize: 12,
    lineHeight: 1.12,
    scrollback: 5000,
    macOptionIsMeta: false,
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    // Claude Code draws with truecolor and box characters; keep its output as-is.
    convertEol: false,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.attachCustomKeyEventHandler(clipboardKeys(terminal));
  terminal.onData(onData);
  return {
    terminal,
    fit,
    write: (data) => terminal.write(data),
    reset: () => terminal.reset(),
    dispose: () => terminal.dispose(),
  };
}
