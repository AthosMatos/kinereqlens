// Which settings Claude may change through the control tools (MCP `settings`), and how (docs/CLAUDE_INTEGRATION.md
// "Control tools → Safety"). Never: the Claude Code / security settings, nor anything that widens what Claude or the
// network can reach, or that starts Claude runs on its own. Capture-scope settings may only be narrowed. Pure.
import type { LayoutSettings, Settings, SettingsPatch } from '../../../shared/types';

/** Settings Claude can never change (the user's own decisions about Claude, the network and the local machine). */
export const BLOCKED_SETTINGS: Readonly<Record<string, string>> = {
  claudeBridge: 'it turns the Claude Code bridge itself on or off',
  claudeAllowSend: 'it decides whether Claude may send requests',
  claudeShareSecrets: 'it decides whether secrets are redacted for Claude',
  claudeAllowControl: 'it decides whether Claude may control kineReqLens',
  errorsFullMode: 'it lets Claude runs edit files and git / gh publish',
  autoAnalyzeErrors: 'it starts Claude runs on its own',
  rnEnabled: 'it opens the React Native receiver to apps',
  rnListenLan: 'it exposes the React Native receiver to the local network',
  rnPort: 'it moves the React Native receiver',
  projectFolders: 'it decides which folders Claude runs in',
  editorRoot: 'it maps sources to a folder on this machine',
  claudeRecentDirs: 'it belongs to the embedded terminal',
};

/** Settings changed by their own tools (they keep their own validation, ids and side effects). */
export const OTHER_TOOL_SETTINGS: Readonly<Record<string, string>> = {
  listRules: 'list_config (add_rule / toggle_rule / delete_rule / clear_rules)',
  listTypes: 'list_config types',
  setups: 'the setups tool',
  activeSetupId: 'setups apply',
  siteLanguages: 'the language tool',
};

/** Settings that may only be narrowed (they bound what kineReqLens captures, hence what Claude can read). */
export const NARROW_ONLY: Readonly<Record<string, 'off' | 'lower'>> = {
  captureResponseBodies: 'off',
  captureErrorScreens: 'off',
  maxEntries: 'lower',
  requestBodyCap: 'lower',
  responseBodyCap: 'lower',
  replayResponseCap: 'lower',
};

/** Settings Claude may set freely (validated / clamped by the settings sanitizer). */
export const FREE_SETTINGS: ReadonlySet<string> = new Set([
  'theme',
  'opacity',
  'defaultMode',
  'replayTimeoutMs',
  'exportFormat',
  'promptTarget',
  'listGroup',
  'urlDisplay',
  'findInPage',
  'shotPadding',
  'layout',
]);

const LAYOUT_KEYS: ReadonlySet<keyof LayoutSettings> = new Set(['dock', 'x', 'y', 'w', 'h', 'dockSize', 'listWidth', 'split', 'minimized', 'terminalHeight', 'railExpanded']);

/** Whether Claude may change `key` at all (some only narrowed). */
export function settingVerdict(key: string): 'free' | 'narrow' | 'blocked' | 'other-tool' | 'unknown' {
  if (Object.prototype.hasOwnProperty.call(BLOCKED_SETTINGS, key)) return 'blocked';
  if (Object.prototype.hasOwnProperty.call(OTHER_TOOL_SETTINGS, key)) return 'other-tool';
  if (Object.prototype.hasOwnProperty.call(NARROW_ONLY, key)) return 'narrow';
  if (FREE_SETTINGS.has(key)) return 'free';
  return 'unknown';
}

export type SettingsPlan = { ok: true; patch: SettingsPatch; changed: string[] } | { ok: false; errors: string[] };

/**
 * The patch for `values` (what Claude asked) against the current settings, or why it is refused — atomically: one
 * refused key refuses everything. `layout: "default"` resets the layout.
 */
export function planSettingsPatch(values: Record<string, unknown>, current: Settings): SettingsPlan {
  const errors: string[] = [];
  const patch: SettingsPatch = {};
  const out = patch as Record<string, unknown>;
  const changed: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    switch (settingVerdict(key)) {
      case 'blocked':
        errors.push(`${key}: Claude cannot change it (${BLOCKED_SETTINGS[key]}) — only the user can, in kineReqLens Settings`);
        continue;
      case 'other-tool':
        errors.push(`${key}: change it with ${OTHER_TOOL_SETTINGS[key]}`);
        continue;
      case 'unknown':
        errors.push(`${key}: unknown setting (see inspect settings)`);
        continue;
      case 'narrow': {
        const rule = NARROW_ONLY[key];
        const now = (current as unknown as Record<string, unknown>)[key];
        if (rule === 'off') {
          if (value !== false && value !== now) {
            errors.push(`${key}: Claude may only turn it off (turning it on captures more of the page)`);
            continue;
          }
        } else if (typeof value !== 'number' || !Number.isFinite(value) || typeof now !== 'number' || value > now) {
          errors.push(`${key}: Claude may only lower it (currently ${String(now)}); raising it captures more of the page`);
          continue;
        }
        out[key] = value;
        changed.push(key);
        continue;
      }
      case 'free':
        if (key === 'layout') {
          if (value === 'default') {
            out.layout = 'default';
            changed.push('layout (reset)');
            continue;
          }
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            errors.push('layout: an object of layout fields, or "default"');
            continue;
          }
          const layout: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (!LAYOUT_KEYS.has(k as keyof LayoutSettings)) errors.push(`layout.${k}: unknown layout field`);
            else layout[k] = v;
          }
          out.layout = layout;
          changed.push(...Object.keys(layout).map((k) => `layout.${k}`));
          continue;
        }
        out[key] = value;
        changed.push(key);
        continue;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, patch, changed };
}

/** Settings shown to Claude: every key with its value (long lists summarized) and whether Claude may change it. */
export function settingsView(settings: Settings): Array<{ key: string; value: string; claude: string }> {
  const rows: Array<{ key: string; value: string; claude: string }> = [];
  for (const [key, value] of Object.entries(settings)) {
    const verdict = settingVerdict(key);
    const claude =
      verdict === 'free' ? 'yes' : verdict === 'narrow' ? (NARROW_ONLY[key] === 'off' ? 'turn off only' : 'lower only') : verdict === 'other-tool' ? `via ${OTHER_TOOL_SETTINGS[key]}` : 'no (user only)';
    let shown: string;
    if (Array.isArray(value)) shown = key === 'claudeRecentDirs' ? `${value.length} folder(s)` : `${value.length} item(s)`;
    else if (value && typeof value === 'object') shown = key === 'layout' ? JSON.stringify(value) : `${Object.keys(value).length} entr${Object.keys(value).length === 1 ? 'y' : 'ies'}`;
    else shown = JSON.stringify(value);
    rows.push({ key, value: shown, claude });
  }
  return rows;
}
