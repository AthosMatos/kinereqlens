import type { HookConfig, ListTypeId, Settings, SettingsPatch, TabState } from './types';

export const APP_NAME = 'kineReqLens';

/**
 * Extension id of the unpacked build (dist/), the same on every machine: Chromium derives it from the public key in
 * static/manifest.json "key" (sha256 of the DER key, first 32 hex digits mapped 0-f → a-p) instead of the folder path.
 * The matching private key is not needed and is not kept anywhere. Store packages (`npm run zip`) ship without "key"
 * and get the store's id. The native messaging host allows this id by default (mcp/src/install.ts).
 */
export const EXTENSION_ID_UNPACKED = 'edijjpphloiddgmdemojcllinhcllppp';

/** chrome.storage.local key for Settings. */
export const SETTINGS_KEY = 'reqlens:settings';
/** chrome.storage.session key for TabState of a tab. */
export const tabStateKey = (tabId: number) => `reqlens:tab:${tabId}`;
/** chrome.storage.session key for the preserved log of a tab. */
export const preservedLogKey = (tabId: number) => `reqlens:log:${tabId}`;

/** Custom element name of the overlay host attached to <html>. */
export const OVERLAY_HOST_TAG = 'reqlens-overlay';

export const DEFAULT_TAB_STATE: TabState = { open: false, recording: true, preserveLog: false };

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  opacity: 1,
  defaultMode: 'page',
  maxEntries: 1000,
  captureResponseBodies: true,
  requestBodyCap: 1024 * 1024,
  responseBodyCap: 2 * 1024 * 1024,
  replayResponseCap: 10 * 1024 * 1024,
  replayTimeoutMs: 30_000,
  claudeBridge: false,
  claudeAllowSend: false,
  claudeShareSecrets: false,
  claudeAllowControl: false,
  exportFormat: 'typescript',
  promptTarget: 'client',
  listRules: [],
  listTypes: ['fetch'],
  listGroup: false,
  urlDisplay: 'template',
  setups: [],
  activeSetupId: null,
  claudeRecentDirs: [],
  rnEnabled: false,
  rnListenLan: false,
  rnPort: 8790,
  editorRoot: '',
  siteLanguages: {},
  projectFolders: {},
  autoAnalyzeErrors: false,
  errorsFullMode: false,
  captureErrorScreens: true,
  findInPage: true,
  shotPadding: 50,
  layout: {
    dock: 'float',
    x: -1,
    y: -1,
    // -1: sized to the viewport (see AUTO_FLOAT_* in src/ui/components/panel/geometry.ts).
    w: -1,
    h: -1,
    dockSize: 640,
    listWidth: 340,
    split: 0.55,
    minimized: false,
    terminalHeight: 300,
    railExpanded: false,
  },
};

/** Max recent working directories of the Claude Code terminal kept in settings. */
export const MAX_RECENT_DIRS = 10;

/** Hook config used while the hook buffers page-load requests before the content script answers. */
export const DEFAULT_HOOK_CONFIG: HookConfig = {
  captureResponseBodies: DEFAULT_SETTINGS.captureResponseBodies,
  requestBodyCap: DEFAULT_SETTINGS.requestBodyCap,
  responseBodyCap: DEFAULT_SETTINGS.responseBodyCap,
};

/** Hook startup buffer: max entries kept, and how long to keep buffering before giving up (ms). */
export const HOOK_BUFFER_MAX = 200;
export const HOOK_BUFFER_TIMEOUT_MS = 15_000;

/**
 * Body cap of manual entries ("+ New", "Duplicate as new request"): they come from the overlay, not from the
 * page, and a duplicate must keep the body as it would be sent now (same limit as an extension-mode replay).
 */
export const MANUAL_BODY_CAP = 50 * 1024 * 1024;

/** Max file content captured per FormData file entry. */
export const FILE_CAPTURE_CAP = 5 * 1024 * 1024;

/** Max entries a preserved log keeps, and per-body cap applied when persisting it. */
export const PRESERVED_LOG_MAX = 300;
export const PRESERVED_BODY_CAP = 64 * 1024;

/** Max list rules kept in settings, and max pattern length. */
export const MAX_LIST_RULES = 200;
export const MAX_LIST_RULE_PATTERN = 2048;

/** Request-list type ids, in menu order. */
export const LIST_TYPE_IDS: readonly ListTypeId[] = ['fetch', 'doc', 'js', 'css', 'img', 'media', 'font', 'other'];

/** Setups ("Setups" rail item): max kept, max sites each, name / group lengths. */
export const MAX_SETUPS = 200;
export const MAX_SETUP_SITES = 20;
export const MAX_SETUP_NAME = 80;
export const MAX_SETUP_GROUP = 60;

/** Max test runs kept per entry. */
export const MAX_RUNS_PER_ENTRY = 20;

/** Window (ms) within which a webRequest event may be matched to a hook capture. */
export const WR_MATCH_WINDOW_MS = 3000;

/** chrome.storage.session key of the tab-scope language overrides (tab id → value), worker only. */
export const TAB_LANGUAGES_KEY = 'reqlens:tab-languages';

/**
 * First declarativeNetRequest session-rule id of the "Site language" rules; extension-mode replay rules use the ids
 * below it (src/background/dnr.ts counts up from 1).
 */
export const LANGUAGE_RULE_ID_BASE = 1_000_000;

/** Merge a settings patch over full settings (layout is merged one level deep). */
export function mergeSettings(base: Settings, patch: SettingsPatch | undefined | null): Settings {
  if (!patch) return { ...base, layout: { ...base.layout } };
  const { layout, ...rest } = patch;
  return { ...base, ...rest, layout: { ...base.layout, ...(layout ?? {}) } };
}
