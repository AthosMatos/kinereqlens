// OWNER: ui-list-menu agent. Items of a request row's context menu (pure: actions come in as callbacks).
import type { BridgeStatus, ClaudeSessionInfo, PromptTarget, TypeFormat } from '../../shared/claude-protocol';
import type { ListRule, RequestEntry } from '../../shared/types';
import type { ContextMenuEntry, ContextMenuItem } from '../components/ContextMenu';
import { sendAvailability } from '../export/claudeStatus';
import type { EndpointGroup } from './endpointLabel';
import { isTemplateKey, templateText } from './endpointLabel';
import { EXACT_SUFFIX, findRule, isStorablePattern, patternText, prefixText, ruleDescription } from './rules';
import type { PathPrefix } from './rules';

/** What the menu's items do. Each runs after the menu closed. */
export interface RowMenuActions {
  /** Create (or re-enable) a rule for a ladder item. */
  addRule(mode: ListRule['mode'], prefix: PathPrefix): void;
  /** Turn off the active rule a checked ladder item stands for. */
  disableRule(rule: ListRule): void;
  copyUrl(): void;
  copyCurl(): void;
  copyFetch(): void;
  copyTypes(): void;
  copyPrompt(): void;
  /** `sessionId` null = every connected session. */
  sendToClaude(sessionId: string | null): void;
  /** Open Settings → Claude Code (the bridge needs setting up). */
  openClaudeSetup(): void;
  resend(): void;
  duplicate(): void;
  /** Select the entry and open its Initiator tab (call stack + component). Absent = no such item. */
  showInitiator?(): void;
  revert(): void;
  remove(): void;
}

export interface RowMenuInput {
  entry: RequestEntry;
  /** pathPrefixes(entry.url) and how many entries each matches (same order). */
  prefixes: readonly PathPrefix[];
  counts: readonly number[];
  /** Current list rules (to mark the ladder items that are already active). */
  rules: readonly ListRule[];
  /** The entry has an edited draft. */
  modified: boolean;
  exportFormat: TypeFormat;
  promptTarget: PromptTarget;
  claude: BridgeStatus;
  actions: RowMenuActions;
}

const FORMAT_LABEL: Record<TypeFormat, string> = { typescript: 'TypeScript', zod: 'Zod', 'json-schema': 'JSON Schema' };
const TARGET_LABEL: Record<PromptTarget, string> = { client: 'client', server: 'server', tests: 'tests', explain: 'explain' };

/** Why "Send to Claude Code" is unavailable (same wording as the Export tab), or null when it can be used. */
export function claudeUnavailableReason(status: BridgeStatus): string | null {
  const availability = sendAvailability(status);
  return availability.ok ? null : availability.reason;
}

/** Only http(s) requests can be replayed. */
export function isSendableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

type LadderInput = Pick<RowMenuInput, 'prefixes' | 'counts' | 'rules'> & {
  actions: Pick<RowMenuActions, 'addRule' | 'disableRule'>;
};

function ruleItems(mode: ListRule['mode'], input: LadderInput): ContextMenuItem[] {
  const verb = mode === 'hide' ? 'Hide' : 'Show only';
  const key = mode === 'hide' ? 'hide' : 'only';
  return input.prefixes.map((prefix, i) => {
    const active = findRule(input.rules, { mode, pattern: prefix.pattern, exact: prefix.exact });
    const checked = active?.enabled === true;
    const storable = isStorablePattern(prefix.pattern);
    const scope = prefix.exact
      ? `to ${patternText(prefix.pattern, true)} ${EXACT_SUFFIX}`
      : `under ${patternText(prefix.pattern, true)}`;
    const item: ContextMenuItem = {
      id: `${key}-${i}`,
      label: prefixText(prefix),
      mono: true,
      hint: `· ${input.counts[i] ?? 0}`,
      checked,
      title: checked ? `${verb} requests ${scope} — active, choose to turn it off` : `${verb} requests ${scope}`,
      testId: `rl-ctx-${key}-option`,
      data: { pattern: prefix.pattern, exact: String(prefix.exact) },
      onSelect: () => (checked && active ? input.actions.disableRule(active) : input.actions.addRule(mode, prefix)),
    };
    if (prefix.exact) item.suffix = EXACT_SUFFIX;
    if (!storable) {
      item.disabled = true;
      item.description = 'Too long for a rule';
    }
    return item;
  });
}

function sessionItems(sessions: readonly ClaudeSessionInfo[], actions: RowMenuActions): ContextMenuEntry[] {
  return [
    {
      id: 'all',
      label: `All sessions (${sessions.length})`,
      testId: 'rl-ctx-send-claude-all',
      onSelect: () => actions.sendToClaude(null),
    },
    { type: 'separator', id: 'sep' },
    ...sessions.map(
      (s): ContextMenuItem => ({
        id: `s:${s.id}`,
        label: s.label || s.cwd || s.id,
        title: s.cwd,
        testId: 'rl-ctx-send-claude-session',
        data: { 'session-id': s.id },
        onSelect: () => actions.sendToClaude(s.id),
      }),
    ),
  ];
}

/** "Send to Claude Code" (disabled with the reason when unavailable), plus "Set up…" when Settings can fix it. */
function claudeItems(input: RowMenuInput): ContextMenuItem[] {
  const availability = sendAvailability(input.claude);
  const item: ContextMenuItem = {
    id: 'send-claude',
    label: 'Send to Claude Code',
    icon: 'external',
    testId: 'rl-ctx-send-claude',
    title: availability.ok ? 'Send the agent prompt for this request to Claude Code' : availability.reason,
  };
  if (!availability.ok) {
    item.disabled = true;
    item.description = availability.reason;
    if (!availability.setup) return [item];
    return [
      item,
      {
        id: 'claude-setup',
        label: 'Set up Claude Code…',
        icon: 'settings',
        testId: 'rl-ctx-claude-setup',
        onSelect: input.actions.openClaudeSetup,
      },
    ];
  }
  if (availability.sessions.length > 1) item.submenu = sessionItems(availability.sessions, input.actions);
  else item.onSelect = () => input.actions.sendToClaude(null);
  return [item];
}

/** "Show initiator / component": the call stack that made the request and the UI component behind it. */
function initiatorItems(input: RowMenuInput): ContextMenuItem[] {
  const show = input.actions.showInitiator;
  if (!show) return [];
  const item: ContextMenuItem = {
    id: 'initiator',
    label: 'Show initiator / component',
    icon: 'code',
    testId: 'rl-ctx-initiator',
    title: 'Which code and which UI component made this request (call stack, source maps)',
    onSelect: show,
  };
  if (typeof input.entry.initiatorStack !== 'string' || !input.entry.initiatorStack) {
    item.hint = 'no stack';
  }
  return [item];
}

/** The whole menu for a row (spec §C). */
export function buildRowMenu(input: RowMenuInput): ContextMenuEntry[] {
  const { entry, actions, modified } = input;
  const sendable = isSendableUrl(entry.url);
  const editedHint = modified ? 'edited' : undefined;
  const copy: ContextMenuEntry[] = [
    { id: 'url', label: 'URL', testId: 'rl-ctx-copy-url', title: entry.url, onSelect: actions.copyUrl },
    {
      id: 'curl',
      label: 'as cURL',
      testId: 'rl-ctx-copy-curl',
      hint: editedHint,
      title: modified ? 'The request as it would be sent now (with your edits)' : 'The request as it would be sent now',
      onSelect: actions.copyCurl,
    },
    {
      id: 'fetch',
      label: 'as fetch',
      testId: 'rl-ctx-copy-fetch',
      hint: editedHint,
      title: modified ? 'The request as it would be sent now (with your edits)' : 'The request as it would be sent now',
      onSelect: actions.copyFetch,
    },
    { type: 'separator', id: 'sep' },
    {
      id: 'types',
      label: `Types (${FORMAT_LABEL[input.exportFormat] ?? input.exportFormat})`,
      testId: 'rl-ctx-copy-types',
      onSelect: actions.copyTypes,
    },
    {
      id: 'prompt',
      label: `Agent prompt (${TARGET_LABEL[input.promptTarget] ?? input.promptTarget})`,
      testId: 'rl-ctx-copy-prompt',
      onSelect: actions.copyPrompt,
    },
  ];

  const resend: ContextMenuItem = {
    id: 'resend',
    label: 'Resend unchanged',
    icon: 'reload',
    testId: 'rl-ctx-resend',
    title: 'Send the captured request as-is (your edits are not applied)',
    onSelect: actions.resend,
  };
  if (!sendable) {
    resend.disabled = true;
    resend.description = 'Only http(s) requests can be sent';
    resend.title = undefined;
  }

  const menu: ContextMenuEntry[] = [
    { id: 'hide', label: 'Hide requests under', icon: 'filter', testId: 'rl-ctx-hide', submenu: ruleItems('hide', input) },
    { id: 'only', label: 'Show only requests under', icon: 'eye', testId: 'rl-ctx-only', submenu: ruleItems('only', input) },
    { type: 'separator', id: 'sep-rules' },
    { id: 'copy', label: 'Copy', icon: 'copy', testId: 'rl-ctx-copy', submenu: copy },
    ...claudeItems(input),
    ...initiatorItems(input),
    { type: 'separator', id: 'sep-actions' },
    resend,
    {
      id: 'duplicate',
      label: 'Duplicate as new request',
      icon: 'plus',
      testId: 'rl-ctx-duplicate',
      title: 'A new request, as it would be sent now (edits included)',
      onSelect: actions.duplicate,
    },
  ];
  if (modified) {
    menu.push({ id: 'revert', label: 'Revert edits', icon: 'revert', testId: 'rl-ctx-revert', onSelect: actions.revert });
  }
  menu.push(
    { type: 'separator', id: 'sep-remove' },
    {
      id: 'remove',
      label: 'Remove from list',
      icon: 'close',
      testId: 'rl-ctx-remove',
      title: 'Hide this request from the list (until the list is cleared or it is shown again)',
      onSelect: actions.remove,
    },
  );
  return menu;
}

// ------------------------------------------------------------------------------------------- group rows

/** What a "Group by endpoint" row's menu items do. Each runs after the menu closed. */
export interface GroupMenuActions {
  addRule(mode: ListRule['mode'], prefix: PathPrefix): void;
  disableRule(rule: ListRule): void;
  /** Create (or re-enable) the endpoint-template rule of the group. */
  addTemplateRule(mode: ListRule['mode']): void;
  copyTemplate(): void;
  /** URL of the newest call. */
  copyUrl(): void;
  toggle(): void;
  /** Remove every call of the group from the list. */
  remove(): void;
}

export interface GroupMenuInput {
  group: EndpointGroup;
  expanded: boolean;
  /** templatePrefixes(newest url) and how many entries each matches (same order). */
  prefixes: readonly PathPrefix[];
  counts: readonly number[];
  /** How many entries the endpoint template matches (any method). */
  templateCount: number;
  rules: readonly ListRule[];
  actions: GroupMenuActions;
}

function templateItem(mode: ListRule['mode'], input: GroupMenuInput): ContextMenuItem {
  const template = input.group.template.key;
  const key = mode === 'hide' ? 'hide' : 'only';
  const spec = { mode, pattern: '', exact: true, template };
  const active = findRule(input.rules, spec);
  const checked = active?.enabled === true;
  const item: ContextMenuItem = {
    id: `${key}-template`,
    label: mode === 'hide' ? 'Hide this endpoint' : 'Show only this endpoint',
    icon: mode === 'hide' ? 'filter' : 'eye',
    hint: `· ${input.templateCount}`,
    checked,
    title: checked ? `${ruleDescription(spec)} — active, choose to turn it off` : ruleDescription(spec),
    testId: `rl-ctx-${key}-template`,
    data: { template },
    onSelect: () => (checked && active ? input.actions.disableRule(active) : input.actions.addTemplateRule(mode)),
  };
  if (!isTemplateKey(template) || !isStorablePattern(template)) {
    item.disabled = true;
    item.description = isTemplateKey(template) ? 'Too long for a rule' : 'Only http(s) endpoints';
    item.title = undefined;
  }
  return item;
}

/** The menu of a group row: endpoint-template rules, the template's URL-rule ladder, copy, expand, remove. */
export function buildGroupMenu(input: GroupMenuInput): ContextMenuEntry[] {
  const { group, actions } = input;
  const count = group.stats.count;
  const ladder: LadderInput = { prefixes: input.prefixes, counts: input.counts, rules: input.rules, actions };
  const menu: ContextMenuEntry[] = [templateItem('hide', input), templateItem('only', input)];
  if (input.prefixes.length) {
    menu.push(
      { id: 'hide', label: 'Hide requests under', icon: 'filter', testId: 'rl-ctx-hide', submenu: ruleItems('hide', ladder) },
      { id: 'only', label: 'Show only requests under', icon: 'eye', testId: 'rl-ctx-only', submenu: ruleItems('only', ladder) },
    );
  }
  menu.push(
    { type: 'separator', id: 'sep-rules' },
    {
      id: 'copy',
      label: 'Copy',
      icon: 'copy',
      testId: 'rl-ctx-copy',
      submenu: [
        {
          id: 'template',
          label: 'Endpoint template',
          testId: 'rl-ctx-copy-template',
          title: templateText(group.template, true),
          onSelect: actions.copyTemplate,
        },
        { id: 'url', label: 'URL of the newest call', testId: 'rl-ctx-copy-url', title: group.newest.url, onSelect: actions.copyUrl },
      ],
    },
    {
      id: 'expand',
      label: input.expanded ? 'Collapse calls' : `Expand ${count} calls`,
      icon: input.expanded ? 'chevron-down' : 'chevron-right',
      testId: 'rl-ctx-expand',
      onSelect: actions.toggle,
    },
    { type: 'separator', id: 'sep-remove' },
    {
      id: 'remove',
      label: `Remove ${count} calls from list`,
      icon: 'close',
      testId: 'rl-ctx-remove',
      title: 'Hide these requests from the list (until the list is cleared or they are shown again)',
      onSelect: actions.remove,
    },
  );
  return menu;
}
