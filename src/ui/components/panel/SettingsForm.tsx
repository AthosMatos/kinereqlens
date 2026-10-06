// OWNER: ui-shell agent. Content of the settings popover in the panel header.
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ReplayMode, Settings, SettingsPatch, UrlDisplay } from '../../../shared/types';
import { ClaudeSettings } from '../../export/ClaudeSettings';
import { openClaudeSettings } from '../../export/openSettings';
import { RnSettings } from '../../rn/RnSettings';
import { isStandaloneShell } from '../../shellMode';
import { SHOT_PADDING_MAX } from '../../../shared/screenshot-protocol';
import { Icon } from '../Icon';
import type { IconName } from '../Icon';

export interface SettingsFormProps {
  settings: Settings;
  /** Live opacity (may be ahead of `settings.opacity` while the slider is being dragged). */
  opacity: number;
  onOpacityInput(value: number): void;
  onChange(patch: SettingsPatch): void;
  onResetLayout(): void;
  version: string;
}

export const MIN_OPACITY = 0.3;
export const MAX_ENTRIES_MIN = 50;
export const MAX_ENTRIES_MAX = 10_000;
/** Body capture caps editable here, in MB (captured bodies travel over messaging and live in memory). */
export const BODY_CAP_MIN_MB = 0.01;
export const BODY_CAP_MAX_MB = 64;
const MB = 1024 * 1024;

const THEMES: ReadonlyArray<{ id: Settings['theme']; label: string; icon?: IconName }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
];

const URL_DISPLAYS: ReadonlyArray<{ id: UrlDisplay; label: string; title: string }> = [
  { id: 'template', label: 'Template', title: 'Endpoint templates: ids as chips ({id}, {uuid} …), long paths shortened, query names only' },
  { id: 'full', label: 'Full path', title: 'The raw path and query string of every request' },
];

/** Clamp a typed max-entries value; null when it is not a number at all. */
export function parseMaxEntries(text: string): number | null {
  const n = Math.round(Number(text.trim()));
  if (!text.trim() || !Number.isFinite(n)) return null;
  return Math.min(Math.max(n, MAX_ENTRIES_MIN), MAX_ENTRIES_MAX);
}

/** Clamp a typed body cap in MB; returns bytes, or null when it is not a number at all. */
export function parseCapMb(text: string): number | null {
  const n = Number(text.trim());
  if (!text.trim() || !Number.isFinite(n)) return null;
  return Math.round(Math.min(Math.max(n, BODY_CAP_MIN_MB), BODY_CAP_MAX_MB) * MB);
}

/** Bytes as an MB value for the input (at most two decimals). */
export function formatCapMb(bytes: number): string {
  return String(Math.round((bytes / MB) * 100) / 100);
}

interface CapFieldProps {
  label: string;
  bytes: number;
  onCommit(bytes: number): void;
}

/** Number input in MB, committed on blur / Enter (invalid text snaps back to the stored value). */
function CapField({ label, bytes, onCommit }: CapFieldProps) {
  const [text, setText] = useState(formatCapMb(bytes));
  useEffect(() => setText(formatCapMb(bytes)), [bytes]);
  const commit = () => {
    const next = parseCapMb(text);
    if (next === null) {
      setText(formatCapMb(bytes));
      return;
    }
    setText(formatCapMb(next));
    if (next !== bytes) onCommit(next);
  };
  return (
    <label class="rl-settings__field rl-settings__field--inline">
      <span class="rl-settings__label">{label}</span>
      <input
        type="number"
        class="rl-input rl-settings__number"
        min={BODY_CAP_MIN_MB}
        max={BODY_CAP_MAX_MB}
        step={0.5}
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
    </label>
  );
}

/** Workspace folder for the Initiator tab's "Open in VS Code" links, committed on blur / Enter. */
function EditorRootField({ value, onCommit }: { value: string; onCommit(value: string): void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const next = text.trim();
    setText(next);
    if (next !== value) onCommit(next);
  };
  return (
    <label class="rl-settings__field">
      <span class="rl-settings__label">Editor workspace root</span>
      <input
        type="text"
        class="rl-input rl-input--mono"
        data-testid="rl-settings-editor-root"
        placeholder="/Users/me/projects/my-app"
        spellcheck={false}
        autocomplete="off"
        value={text}
        title="Folder that relative source-map paths (webpack://app/./src/…, /src/…) are resolved against for the Initiator tab's Open in VS Code links"
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
    </label>
  );
}

/** Default padding of element / region screenshots (px), committed on blur / Enter (invalid text snaps back). */
function ShotPaddingField({ padding, onCommit }: { padding: number; onCommit(padding: number): void }) {
  // What was typed, for the value it was typed over (a stored change replaces it).
  const [edit, setEdit] = useState<{ text: string; over: number } | null>(null);
  const text = edit && edit.over === padding ? edit.text : String(padding);
  const commit = () => {
    setEdit(null);
    const n = Math.round(Number(text.trim()));
    if (!text.trim() || !Number.isFinite(n)) return;
    const next = Math.min(Math.max(n, 0), SHOT_PADDING_MAX);
    if (next !== padding) onCommit(next);
  };
  return (
    <label
      class="rl-settings__field rl-settings__field--inline"
      title="Space kept around an element or region screenshot (element pick, a response value's camera button, Claude's screenshots); each capture's padding can be changed afterwards"
    >
      <span class="rl-settings__label">Screenshot padding (px)</span>
      <input
        type="number"
        class="rl-input rl-settings__number"
        min={0}
        max={SHOT_PADDING_MAX}
        step={10}
        value={text}
        data-testid="rl-settings-shot-padding"
        onInput={(e) => setEdit({ text: e.currentTarget.value, over: padding })}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
    </label>
  );
}

/** Theme, opacity, default send mode, body capture (on/off, caps), list size, Claude Code bridge, layout reset. */
export function SettingsForm({ settings, opacity, onOpacityInput, onChange, onResetLayout, version }: SettingsFormProps) {
  const [maxText, setMaxText] = useState(String(settings.maxEntries));
  useEffect(() => setMaxText(String(settings.maxEntries)), [settings.maxEntries]);

  const commitMax = () => {
    const n = parseMaxEntries(maxText);
    if (n === null) {
      setMaxText(String(settings.maxEntries));
      return;
    }
    setMaxText(String(n));
    if (n !== settings.maxEntries) onChange({ maxEntries: n });
  };

  const percent = Math.round(opacity * 100);
  // Filled part of the slider track (CSS custom property read by .rl-range).
  const fill = `${Math.round(((percent - MIN_OPACITY * 100) / (100 - MIN_OPACITY * 100)) * 100)}%`;
  const rangeStyle = { '--rl-range-fill': fill } as JSX.CSSProperties;

  return (
    <div class="rl-settings">
      <div class="rl-settings__head">
        <div class="rl-settings__title">Settings</div>
        <button
          type="button"
          class="rl-chip rl-settings__jump"
          title="Jump to Settings → Claude Code"
          data-testid="rl-settings-claude"
          onClick={openClaudeSettings}
        >
          <Icon name="terminal" size={11} />
          Claude Code
        </button>
      </div>

      <div class="rl-settings__field">
        <span class="rl-settings__label" id="rl-set-theme">
          Theme
        </span>
        <div class="rl-segmented" role="radiogroup" aria-labelledby="rl-set-theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              class="rl-segmented__item"
              aria-checked={settings.theme === t.id ? 'true' : 'false'}
              onClick={() => settings.theme !== t.id && onChange({ theme: t.id })}
            >
              {t.icon ? <Icon name={t.icon} size={12} /> : null}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div class="rl-settings__field">
        <span class="rl-settings__label" id="rl-set-url-display">
          URL display
        </span>
        <div class="rl-segmented" role="radiogroup" aria-labelledby="rl-set-url-display" data-testid="rl-url-display">
          {URL_DISPLAYS.map((d) => (
            <button
              key={d.id}
              type="button"
              role="radio"
              class="rl-segmented__item"
              title={d.title}
              data-value={d.id}
              aria-checked={(settings.urlDisplay ?? 'template') === d.id ? 'true' : 'false'}
              onClick={() => settings.urlDisplay !== d.id && onChange({ urlDisplay: d.id })}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <label class="rl-settings__field">
        <span class="rl-settings__label">
          Opacity <span class="rl-settings__value">{percent}%</span>
        </span>
        <input
          type="range"
          class="rl-range"
          min={MIN_OPACITY * 100}
          max={100}
          step={5}
          value={percent}
          style={rangeStyle}
          aria-valuetext={`${percent}%`}
          onInput={(e) => onOpacityInput(Number(e.currentTarget.value) / 100)}
        />
      </label>

      <label class="rl-settings__field">
        <span class="rl-settings__label">Default send mode</span>
        <select
          class="rl-select"
          value={settings.defaultMode}
          onChange={(e) => onChange({ defaultMode: e.currentTarget.value as ReplayMode })}
        >
          <option value="page">
            {isStandaloneShell() ? 'App — inside the React Native app (its own fetch)' : 'Page — same cookies, origin & CORS as the app'}
          </option>
          <option value="extension">Extension — bypasses CORS, can set Cookie/Origin</option>
        </select>
      </label>

      <label class="rl-settings__check">
        <input
          type="checkbox"
          class="rl-checkbox"
          checked={settings.captureResponseBodies}
          onChange={(e) => onChange({ captureResponseBodies: e.currentTarget.checked })}
        />
        <span>Capture response bodies</span>
      </label>

      {/* Find in page (docs/ARCHITECTURE.md §13): the standalone React Native tab has no page to look at. */}
      {isStandaloneShell() ? null : (
        <label class="rl-settings__check" title="Locate icons next to response values that the page shows; click one to see it on the page">
          <input
            type="checkbox"
            class="rl-checkbox"
            checked={settings.findInPage}
            data-testid="rl-settings-find-in-page"
            onChange={(e) => onChange({ findInPage: e.currentTarget.checked })}
          />
          <span>Find response values on the page</span>
        </label>
      )}

      {/* Screenshots of an element / region keep this much page around it (changed per capture afterwards). */}
      {isStandaloneShell() ? null : <ShotPaddingField padding={settings.shotPadding} onCommit={(shotPadding) => onChange({ shotPadding })} />}

      <CapField
        label="Request body cap (MB)"
        bytes={settings.requestBodyCap}
        onCommit={(requestBodyCap) => onChange({ requestBodyCap })}
      />
      <CapField
        label="Response body cap (MB)"
        bytes={settings.responseBodyCap}
        onCommit={(responseBodyCap) => onChange({ responseBodyCap })}
      />

      <label class="rl-settings__field rl-settings__field--inline">
        <span class="rl-settings__label">Max requests kept</span>
        <input
          type="number"
          class="rl-input rl-settings__number"
          min={MAX_ENTRIES_MIN}
          max={MAX_ENTRIES_MAX}
          step={50}
          value={maxText}
          onInput={(e) => setMaxText(e.currentTarget.value)}
          onBlur={commitMax}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitMax();
            }
          }}
        />
      </label>

      <EditorRootField value={settings.editorRoot} onCommit={(editorRoot) => onChange({ editorRoot })} />

      {/* The standalone React Native tab shows its own section first. */}
      {isStandaloneShell() ? <RnSettings settings={settings} onChange={onChange} /> : null}

      <ClaudeSettings settings={settings} onChange={onChange} />

      {isStandaloneShell() ? null : <RnSettings settings={settings} onChange={onChange} />}

      <div class="rl-settings__footer">
        <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" onClick={onResetLayout}>
          <Icon name="revert" size={12} />
          Reset layout
        </button>
        <span class="rl-spacer" />
        <span class="rl-faint">
          <span class="rl-kbd">Alt</span>+<span class="rl-kbd">Shift</span>+<span class="rl-kbd">L</span> · v{version}
        </span>
      </div>
    </div>
  );
}
