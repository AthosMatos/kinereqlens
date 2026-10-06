/**
 * Settings for the content script (docs/ARCHITECTURE.md §4.2): `chrome.storage.local[SETTINGS_KEY]` merged
 * over DEFAULT_SETTINGS, followed through storage change events, written back by `update`.
 *
 * Pure: storage access comes through `SettingsStorage`, so the class is testable without chrome.*.
 * The current Settings object keeps its identity until a value actually changes (UI snapshot stability).
 */
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/constants';
import { sanitizeRecentDirs } from '../shared/pty';
import {
  listRulesEqual,
  listTypesEqual,
  sanitizeActiveSetupId,
  sanitizeListRules,
  sanitizeListTypes,
  sanitizeSetups,
  setupsEqual,
} from '../shared/setups';
import type { PromptTarget, TypeFormat } from '../shared/claude-protocol';
import { sanitizeRnPort } from '../shared/rn-protocol';
import { sanitizeSiteLanguages, siteLanguagesEqual } from '../shared/language';
import { projectFoldersEqual, sanitizeProjectFolders } from '../shared/errors-settings';
import { SHOT_PADDING_MAX } from '../shared/screenshot-protocol';
import type { DockMode, HookConfig, LayoutSettings, Settings, SettingsPatch, UrlDisplay } from '../shared/types';
import { isRecord } from './validate';

/** Storage backend of the settings object. */
export interface SettingsStorage {
  /** The raw stored value (undefined when missing or unreadable). */
  read(): Promise<unknown>;
  /** Persist the full settings object; resolves false when it could not be written. */
  write(settings: Settings): Promise<boolean>;
  /** Subscribe to external changes of the stored value. Returns an unsubscribe function. */
  watch(listener: (value: unknown) => void): () => void;
}

const THEMES: ReadonlyArray<Settings['theme']> = ['auto', 'light', 'dark'];
const MODES: ReadonlyArray<Settings['defaultMode']> = ['page', 'extension'];
const DOCKS: ReadonlyArray<DockMode> = ['float', 'right', 'left', 'bottom'];
/** Hard upper bound for any body cap (bytes), whatever storage says. */
const MAX_CAP = 512 * 1024 * 1024;

const EXPORT_FORMATS: ReadonlyArray<TypeFormat> = ['typescript', 'zod', 'json-schema'];
const PROMPT_TARGETS: ReadonlyArray<PromptTarget> = ['client', 'server', 'tests', 'explain'];
const URL_DISPLAYS: ReadonlyArray<UrlDisplay> = ['template', 'full'];

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: ReadonlyArray<T>, fallback: T): T {
  return typeof value === 'string' && (allowed as ReadonlyArray<string>).includes(value) ? (value as T) : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const bounded = Math.min(max, Math.max(min, value));
  return integer ? Math.round(bounded) : bounded;
}

function sanitizeLayout(value: unknown): LayoutSettings {
  const base = DEFAULT_SETTINGS.layout;
  const layout = isRecord(value) ? value : {};
  const coordinate = (v: unknown, fallback: number) => clampNumber(v, fallback, -1, 1_000_000);
  const size = (v: unknown, fallback: number) => clampNumber(v, fallback, 0, 1_000_000);
  return {
    dock: oneOf(layout.dock, DOCKS, base.dock),
    x: coordinate(layout.x, base.x),
    y: coordinate(layout.y, base.y),
    // -1 = automatic size (fits the viewport).
    w: coordinate(layout.w, base.w),
    h: coordinate(layout.h, base.h),
    dockSize: size(layout.dockSize, base.dockSize),
    listWidth: size(layout.listWidth, base.listWidth),
    split: clampNumber(layout.split, base.split, 0, 1),
    minimized: typeof layout.minimized === 'boolean' ? layout.minimized : base.minimized,
    terminalHeight: clampNumber(layout.terminalHeight, base.terminalHeight, 80, 100_000, true),
    railExpanded: typeof layout.railExpanded === 'boolean' ? layout.railExpanded : base.railExpanded,
  };
}

/** Workspace folder for editor links: a trimmed string ≤ 4096 characters without control characters, else ''. */
export function sanitizeEditorRoot(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  return text.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(text) ? text : '';
}

/** A complete, well-typed Settings object from anything (stored value, merged patch). */
export function sanitizeSettings(value: unknown): Settings {
  const merged = mergeSettings(DEFAULT_SETTINGS, isRecord(value) ? (value as SettingsPatch) : null);
  const d = DEFAULT_SETTINGS;
  const setups = sanitizeSetups(merged.setups);
  return {
    theme: oneOf(merged.theme, THEMES, d.theme),
    opacity: clampNumber(merged.opacity, d.opacity, 0.3, 1),
    defaultMode: oneOf(merged.defaultMode, MODES, d.defaultMode),
    maxEntries: clampNumber(merged.maxEntries, d.maxEntries, 1, 100_000, true),
    captureResponseBodies:
      typeof merged.captureResponseBodies === 'boolean' ? merged.captureResponseBodies : d.captureResponseBodies,
    requestBodyCap: clampNumber(merged.requestBodyCap, d.requestBodyCap, 0, MAX_CAP, true),
    responseBodyCap: clampNumber(merged.responseBodyCap, d.responseBodyCap, 0, MAX_CAP, true),
    replayResponseCap: clampNumber(merged.replayResponseCap, d.replayResponseCap, 0, MAX_CAP, true),
    replayTimeoutMs: clampNumber(merged.replayTimeoutMs, d.replayTimeoutMs, 1, 3_600_000, true),
    claudeBridge: bool(merged.claudeBridge, d.claudeBridge),
    claudeAllowSend: bool(merged.claudeAllowSend, d.claudeAllowSend),
    claudeShareSecrets: bool(merged.claudeShareSecrets, d.claudeShareSecrets),
    claudeAllowControl: bool(merged.claudeAllowControl, d.claudeAllowControl),
    exportFormat: oneOf(merged.exportFormat, EXPORT_FORMATS, d.exportFormat),
    promptTarget: oneOf(merged.promptTarget, PROMPT_TARGETS, d.promptTarget),
    listRules: sanitizeListRules(merged.listRules),
    listTypes: sanitizeListTypes(merged.listTypes, d.listTypes),
    listGroup: bool(merged.listGroup, d.listGroup),
    urlDisplay: oneOf(merged.urlDisplay, URL_DISPLAYS, d.urlDisplay),
    setups,
    activeSetupId: sanitizeActiveSetupId(merged.activeSetupId, setups),
    claudeRecentDirs: sanitizeRecentDirs(merged.claudeRecentDirs),
    rnEnabled: bool(merged.rnEnabled, d.rnEnabled),
    rnListenLan: bool(merged.rnListenLan, d.rnListenLan),
    rnPort: sanitizeRnPort(merged.rnPort),
    editorRoot: sanitizeEditorRoot(merged.editorRoot),
    siteLanguages: sanitizeSiteLanguages(merged.siteLanguages),
    projectFolders: sanitizeProjectFolders(merged.projectFolders),
    autoAnalyzeErrors: bool(merged.autoAnalyzeErrors, d.autoAnalyzeErrors),
    errorsFullMode: bool(merged.errorsFullMode, d.errorsFullMode),
    captureErrorScreens: bool(merged.captureErrorScreens, d.captureErrorScreens),
    findInPage: bool(merged.findInPage, d.findInPage),
    shotPadding: clampNumber(merged.shotPadding, d.shotPadding, 0, SHOT_PADDING_MAX, true),
    layout: sanitizeLayout(merged.layout),
  };
}

/** Value equality of two Settings objects (layout compared one level deep). */
export function settingsEqual(a: Settings, b: Settings): boolean {
  for (const key of Object.keys(a) as Array<keyof Settings>) {
    if (key === 'layout') continue;
    if (key === 'listRules') {
      if (!listRulesEqual(a.listRules, b.listRules)) return false;
      continue;
    }
    if (key === 'listTypes') {
      if (!listTypesEqual(a.listTypes, b.listTypes)) return false;
      continue;
    }
    if (key === 'setups') {
      if (!setupsEqual(a.setups, b.setups)) return false;
      continue;
    }
    if (key === 'siteLanguages') {
      if (!siteLanguagesEqual(a.siteLanguages, b.siteLanguages)) return false;
      continue;
    }
    if (key === 'projectFolders') {
      if (!projectFoldersEqual(a.projectFolders, b.projectFolders)) return false;
      continue;
    }
    if (key === 'claudeRecentDirs') {
      const x = a.claudeRecentDirs;
      const y = b.claudeRecentDirs;
      if (x !== y && (x.length !== y.length || x.some((d, i) => d !== y[i]))) return false;
      continue;
    }
    if (!Object.is(a[key], b[key])) return false;
  }
  for (const key of Object.keys(a.layout) as Array<keyof LayoutSettings>) {
    if (!Object.is(a.layout[key], b.layout[key])) return false;
  }
  return true;
}

/** The part of Settings the MAIN-world hook needs. */
export function hookConfigOf(settings: Settings): HookConfig {
  return {
    captureResponseBodies: settings.captureResponseBodies,
    requestBodyCap: settings.requestBodyCap,
    responseBodyCap: settings.responseBodyCap,
  };
}

/** Current Settings with change subscriptions, backed by SettingsStorage. */
export class SettingsStore {
  private current: Settings = sanitizeSettings(null);
  private readonly listeners = new Set<(settings: Settings) => void>();
  private unwatch: (() => void) | null = null;
  private loadedFlag = false;
  private disposed = false;
  /** Bumped by every local update, so a slow initial read cannot overwrite a newer local value. */
  private revision = 0;
  /** Local writes not yet acknowledged by storage. */
  private pendingWrites = 0;
  /** Resolves once the stored value was read (or the read failed). Never rejects. */
  readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;

  constructor(private readonly storage: SettingsStorage) {
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
  }

  /** True once the stored value was read. */
  get loaded(): boolean {
    return this.loadedFlag;
  }

  /** Start following storage and read the stored value. */
  start(): void {
    if (this.unwatch || this.disposed) return;
    this.unwatch = this.storage.watch((value) => {
      const next = sanitizeSettings(value);
      // The echo of an older local write must not briefly undo a newer local update.
      if (this.pendingWrites > 0 && !settingsEqual(next, this.current)) return;
      this.apply(next);
    });
    const revision = this.revision;
    this.storage
      .read()
      .then(
        (value) => {
          if (revision === this.revision) this.apply(sanitizeSettings(value));
        },
        () => undefined,
      )
      .finally(() => {
        this.loadedFlag = true;
        this.markReady();
      });
  }

  get(): Settings {
    return this.current;
  }

  /** Called after every change with the new settings. Returns an unsubscribe function. */
  subscribe(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Merge `patch`, apply it locally right away and persist it. Never rejects. */
  async update(patch: SettingsPatch): Promise<Settings> {
    if (this.disposed) return this.current;
    const next = sanitizeSettings(mergeSettings(this.current, isRecord(patch) ? patch : null));
    this.revision++;
    this.apply(next);
    this.pendingWrites++;
    try {
      await this.storage.write(this.current).catch(() => false);
    } finally {
      this.pendingWrites--;
    }
    return this.current;
  }

  dispose(): void {
    this.disposed = true;
    this.unwatch?.();
    this.unwatch = null;
    this.listeners.clear();
    this.markReady();
  }

  private apply(next: Settings): void {
    if (this.disposed || settingsEqual(this.current, next)) return;
    this.current = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        /* a failing subscriber must not starve the others */
      }
    }
  }
}
