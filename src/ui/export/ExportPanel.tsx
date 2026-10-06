// OWNER: ui-export agent. The detail pane's "Export" tab (spec v0.2 §A.2): generated types (TypeScript / Zod /
// JSON Schema) and an agent prompt for the selected request, built from the edited draft, the captured
// response and every test run. Mounted only while the tab is visible; generation is memoized per input
// identity and debounced for heavy bodies so typing in the editor stays responsive.
import type { ComponentChildren } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';
import type { PromptTarget, TypeFormat } from '../../shared/claude-protocol';
import type { ReqlensBridge, RequestEntry, Settings } from '../../shared/types';
import type { EndpointSpec } from '../../lib/endpoint';
import { formatBytes } from '../../lib/format';
import { Icon } from '../components/Icon';
import { Tabs } from '../components/Tabs';
import { useEntryRecord } from '../detail/draftStore';
import { sendEntry } from '../detail/sendAction';
import { useBridge, useSettings } from '../hooks';
import { useBridgeStatus } from '../panel/claudeLink';
import { deliverPrompt } from './actions';
import { ClaudeSend } from './ClaudeSend';
import { CodeView } from './CodeView';
import { Check, CopyAction, RadioGroup } from './controls';
import type { RadioOption } from './controls';
import { highlightCode, highlightMarkdown } from './highlight';
import { useDebouncedValue, useDeferredValue, useExportSettingsBinding, usePersistedChoice } from './hooks';
import { openClaudeSettings } from './openSettings';
import {
  DEFER_WEIGHT,
  FORMAT_LABELS,
  TARGET_LABELS,
  compileNotes,
  exportWeight,
  lineCount,
  peekSpec,
  promptOutcome,
  responseHint,
  roleLabel,
  rolesPresent,
  sanitizeTypeName,
  specOutcome,
  suggestedName,
  titleOf,
  tokenEstimate,
  typesOutcome,
} from './pipeline';
import type { ResponseHint } from './pipeline';
import type { ExportPrefs } from './prefs';
import { getBaseNameOverride, setBaseNameOverride, setExportPrefs, toggleRole, useExportPrefs } from './prefs';

/** Debounce of regeneration for heavy inputs (typing in a big body, renaming). */
const HEAVY_DEBOUNCE_MS = 150;

const FORMAT_OPTIONS: ReadonlyArray<RadioOption<TypeFormat>> = [
  { id: 'typescript', label: 'TypeScript', title: 'TypeScript interfaces and types' },
  { id: 'zod', label: 'Zod', title: 'Zod schemas with inferred TypeScript types' },
  { id: 'json-schema', label: 'JSON Schema', title: 'JSON Schema (draft 2020-12) with $defs' },
];

const TARGET_OPTIONS: ReadonlyArray<RadioOption<PromptTarget>> = [
  { id: 'client', label: 'Client', title: 'Ask for a typed API client function following the repo conventions' },
  { id: 'server', label: 'Server', title: 'Ask for the endpoint implementation (route, handler, validation)' },
  { id: 'tests', label: 'Tests', title: 'Ask for contract / integration tests of the observed responses' },
  { id: 'explain', label: 'Explain', title: 'Ask for an explanation of the endpoint and how the page uses it' },
];

function validFormat(value: unknown): TypeFormat {
  return typeof value === 'string' && value in FORMAT_LABELS ? (value as TypeFormat) : 'typescript';
}

function validTarget(value: unknown): PromptTarget {
  return typeof value === 'string' && value in TARGET_LABELS ? (value as PromptTarget) : 'client';
}

export interface ExportPanelProps {
  entry: RequestEntry;
}

/** Export tab content: Types | Agent prompt. */
export function ExportPanel({ entry }: ExportPanelProps) {
  const bridge = useBridge();
  const settings = useSettings();
  useExportSettingsBinding(bridge);
  const record = useEntryRecord(entry);
  const prefs = useExportPrefs();
  const { draft, runs } = record;
  const redact = !settings.claudeShareSecrets;
  const heavy = useMemo(() => exportWeight(entry, runs) > DEFER_WEIGHT, [entry, runs]);
  const spec = useDeferredValue(
    () => specOutcome(entry, draft, runs, redact),
    () => peekSpec(entry, draft, runs, redact),
    [entry, draft, runs, redact],
    heavy,
    HEAVY_DEBOUNCE_MS,
  );
  const view = prefs.view;
  const current = spec.value;
  const redacted = current?.ok ? current.value.redacted : false;

  let content;
  if (!current) content = <Generating />;
  else if (!current.ok) content = <GenerationError error={current.error} />;
  else if (view === 'types') content = <TypesView bridge={bridge} settings={settings} entry={entry} spec={current.value} prefs={prefs} heavy={heavy} />;
  else content = <PromptView bridge={bridge} settings={settings} entry={entry} spec={current.value} prefs={prefs} />;

  return (
    <div class="rl-export" data-testid="rl-export" data-view={view} data-state={!current ? 'loading' : current.ok ? 'ready' : 'error'}>
      <Tabs
        size="sm"
        class="rl-export__tabs"
        active={view}
        onChange={(id) => setExportPrefs({ view: id === 'prompt' ? 'prompt' : 'types' })}
        tabs={[
          { id: 'types', label: 'Types', testId: 'rl-export-types-tab' },
          { id: 'prompt', label: 'Agent prompt', testId: 'rl-export-prompt-tab' },
        ]}
        actions={
          <>
            {spec.stale && current ? (
              <span class="rl-export__busy" role="status" aria-live="polite">
                <span class="rl-spinner rl-export__busy-spinner" aria-hidden="true" />
                Updating…
              </span>
            ) : null}
            <RedactionBadge redact={redact} redacted={redacted} />
          </>
        }
      />
      <div class="rl-export__body" role="tabpanel" aria-label={view === 'types' ? 'Types' : 'Agent prompt'}>
        {content}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- shared bits

function Generating() {
  return (
    <div class="rl-empty rl-export__state" data-testid="rl-export-loading">
      <span class="rl-spinner" aria-hidden="true" />
      <div>Analysing the request…</div>
    </div>
  );
}

function GenerationError({ error }: { error: string }) {
  return (
    <div class="rl-empty rl-export__state" role="alert" data-testid="rl-export-error">
      <Icon name="warning" size={20} class="rl-export__state-icon--error" />
      <div class="rl-empty__title">This request could not be analysed</div>
      <div class="rl-faint rl-mono rl-export__state-detail">{error}</div>
    </div>
  );
}

/** "Secrets redacted" / "Secrets included" indicator; opens Settings → Claude Code. */
function RedactionBadge({ redact, redacted }: { redact: boolean; redacted: boolean }) {
  const label = redact ? (redacted ? 'Secrets redacted' : 'Redaction on') : 'Secrets included';
  const title = redact
    ? `${redacted ? 'Secret values were replaced by <redacted>' : 'No secret values found'} (Authorization, cookies, tokens, passwords). Change in Settings → Claude Code.`
    : 'Secret values are included unredacted ("Share secrets with Claude" is on). Change in Settings → Claude Code.';
  return (
    <button
      type="button"
      class={`rl-export-redact rl-export-redact--${redact ? 'on' : 'off'}`}
      data-testid="rl-export-redact"
      data-redact={redact ? 'on' : 'off'}
      title={title}
      onClick={openClaudeSettings}
    >
      <Icon name={redact ? 'lock' : 'warning'} size={11} />
      <span>{label}</span>
    </button>
  );
}

interface FooterProps {
  meta: string;
  children: ComponentChildren;
}

function Footer({ meta, children }: FooterProps) {
  return (
    <div class="rl-export__footer">
      <span class="rl-export__meta rl-faint">{meta}</span>
      <span class="rl-spacer" />
      {children}
    </div>
  );
}

function sizeMeta(text: string, unit: 'lines' | 'tokens'): string {
  if (!text) return '';
  const size = formatBytes(new TextEncoder().encode(text).length);
  if (unit === 'tokens') return `${tokenEstimate(text)} · ${size}`;
  const n = lineCount(text);
  return `${n.toLocaleString()} line${n === 1 ? '' : 's'} · ${size}`;
}

// --------------------------------------------------------------------------------------------- types view

interface ViewProps {
  bridge: ReqlensBridge;
  settings: Settings;
  entry: RequestEntry;
  spec: EndpointSpec;
  prefs: ExportPrefs;
}

/** Base name typed for the entry (or the suggestion), shared by both views. */
function baseNameOf(spec: EndpointSpec, typed: string | null): { name: string; suggested: string } {
  const suggested = suggestedName(spec);
  return { name: sanitizeTypeName(typed ?? '') || suggested, suggested };
}

function TypesView({ bridge, settings, entry, spec, prefs, heavy }: ViewProps & { heavy: boolean }) {
  const [format, setFormat] = usePersistedChoice(bridge, validFormat(settings.exportFormat), 'exportFormat');
  const [typed, setTyped] = useState<string | null>(() => getBaseNameOverride(entry.id) ?? null);
  const { name, suggested } = baseNameOf(spec, typed);
  const baseName = useDebouncedValue(name, HEAVY_DEBOUNCE_MS, heavy);
  const graphql = spec.graphql !== null;
  const present = useMemo(() => rolesPresent(spec), [spec]);
  const types = useMemo(
    () => typesOutcome(spec, { format, baseName, annotate: prefs.annotate, exclude: prefs.exclude }),
    [spec, format, baseName, prefs.annotate, prefs.exclude],
  );
  const code = types.ok ? types.value.code : '';
  const lines = useMemo(() => highlightCode(code, format === 'json-schema' ? 'json' : 'ts'), [code, format]);
  const notes = useMemo(() => compileNotes(spec, types.ok ? types.value : null, prefs.exclude), [spec, types, prefs.exclude]);
  const hint = responseHint(spec, entry);
  const included = present.filter((r) => !prefs.exclude.has(r));
  const hasCode = code.trim().length > 0;

  const onName = (text: string) => {
    setTyped(text);
    setBaseNameOverride(entry.id, text);
  };
  const resetName = () => {
    setTyped(null);
    setBaseNameOverride(entry.id, null);
  };
  const nameInvalid = typed !== null && typed !== '' && sanitizeTypeName(typed) !== typed;
  const getCode = useCallback(() => code, [code]);
  const codeMeta = useMemo(() => (hasCode ? sizeMeta(code, 'lines') : ''), [code, hasCode]);

  return (
    <div class="rl-export__view" data-testid="rl-export-types">
      <div class="rl-export__toolbar">
        <RadioGroup<TypeFormat> label="Type format" testId="rl-export-format" options={FORMAT_OPTIONS} value={format} onChange={setFormat} />
        <label class="rl-export__name">
          <span class="rl-export__label">Name</span>
          <input
            type="text"
            class={`rl-input rl-input--mono rl-export__name-input${nameInvalid ? ' rl-input--invalid' : ''}`}
            data-testid="rl-export-name"
            value={typed ?? suggested}
            placeholder={suggested}
            spellcheck={false}
            autocomplete="off"
            aria-invalid={nameInvalid ? 'true' : undefined}
            title={nameInvalid ? `Only letters, digits, _ and $ are kept: ${sanitizeTypeName(typed ?? '') || suggested}` : 'Base name of the generated types'}
            onInput={(e) => onName(e.currentTarget.value)}
            onBlur={(e) => {
              if (!e.currentTarget.value.trim()) resetName();
            }}
          />
          {typed !== null && name !== suggested ? (
            <button type="button" class="rl-icon-btn rl-icon-btn--sm" title={`Reset to ${suggested}`} aria-label="Reset the name" onClick={resetName}>
              <Icon name="revert" size={11} />
            </button>
          ) : null}
        </label>
      </div>
      {present.length > 0 ? (
        <div class="rl-export__toolbar rl-export__toolbar--parts" role="group" aria-label="Parts to include">
          <span class="rl-export__label">Include</span>
          {present.map((role) => (
            <Check
              key={role}
              testId={`rl-export-role-${role}`}
              checked={!prefs.exclude.has(role)}
              onChange={(on) => toggleRole(role, on)}
            >
              {roleLabel(role, graphql)}
            </Check>
          ))}
          <Check
            class="rl-export__annotate"
            testId="rl-export-annotate"
            checked={prefs.annotate}
            onChange={(annotate) => setExportPrefs({ annotate })}
            title={format === 'json-schema' ? 'Add formats and example values' : 'Add example values, formats and precision warnings as comments'}
          >
            Annotate
          </Check>
        </div>
      ) : null}
      <ResponseHintNotice hint={hint} bridge={bridge} entry={entry} settings={settings} excluded={prefs.exclude.has('response')} />
      {!types.ok ? (
        <div class="rl-export__notice rl-error" role="alert" data-testid="rl-export-error">
          <Icon name="warning" size={13} />
          <span>Could not generate types: {types.error}</span>
        </div>
      ) : hasCode ? (
        <CodeView lines={lines} gutter label={`Generated ${FORMAT_LABELS[format]}`} testId="rl-export-code" kind={format} />
      ) : (
        <div class="rl-empty rl-export__state" data-testid="rl-export-empty">
          <Icon name="code" size={20} class="rl-empty__icon" />
          {present.length > 0 && included.length === 0 ? (
            <div class="rl-empty__text">Select at least one part above to generate types.</div>
          ) : (
            <>
              <div class="rl-empty__title">Nothing to type yet</div>
              <div class="rl-empty__text">This request has no path parameters, query, JSON body or JSON response.</div>
            </>
          )}
        </div>
      )}
      {notes.length > 0 ? <Notes notes={notes} /> : null}
      <Footer meta={codeMeta}>
        <CopyAction
          primary
          text={getCode}
          label="Copy"
          title={`Copy the ${FORMAT_LABELS[format]} code`}
          done={`${FORMAT_LABELS[format]} types copied`}
          testId="rl-export-copy"
          disabled={!hasCode}
        />
      </Footer>
    </div>
  );
}

interface HintProps {
  hint: ResponseHint;
  bridge: ReqlensBridge;
  entry: RequestEntry;
  settings: Settings;
  excluded: boolean;
}

/** Why there is no response type, and what to do about it. */
function ResponseHintNotice({ hint, bridge, entry, settings, excluded }: HintProps) {
  if (hint.kind === 'none' || excluded) return null;
  if (hint.kind === 'send') {
    return (
      <div class="rl-export__notice rl-export__notice--info" data-testid="rl-export-hint" data-hint="send">
        <Icon name="info" size={13} class="rl-export__notice-icon" />
        <span class="rl-export__notice-text">
          {hint.pending ? 'Waiting for the response… ' : 'No JSON response yet. '}
          Send a test request to infer the response type.
        </span>
        <button
          type="button"
          class="rl-btn rl-btn--sm"
          data-testid="rl-export-send"
          title="Send the request now (stays on this tab; the types refine when it finishes)"
          onClick={() => sendEntry(bridge, entry, settings)}
        >
          <Icon name="send" size={11} />
          <span>Send</span>
        </button>
      </div>
    );
  }
  const text =
    hint.kind === 'empty'
      ? 'The response has no body, so no response type is generated.'
      : `The response is ${hint.contentType ? hint.contentType.split(';')[0] : 'not JSON'}, so there is no response type to infer.`;
  return (
    <div class="rl-export__notice rl-export__notice--info" data-testid="rl-export-hint" data-hint={hint.kind}>
      <Icon name="info" size={13} class="rl-export__notice-icon" />
      <span class="rl-export__notice-text">{text}</span>
    </div>
  );
}

function Notes({ notes }: { notes: string[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div class={`rl-export__notes${open ? ' rl-export__notes--open' : ''}`} data-testid="rl-export-notes">
      <button type="button" class="rl-export__notes-toggle" aria-expanded={open ? 'true' : 'false'} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
        <span>Notes</span>
        <span class="rl-tab__badge">{notes.length}</span>
      </button>
      {open ? (
        <ul class="rl-export__notes-list rl-scroll">
          {notes.map((note, i) => (
            <li key={`${i}:${note}`} class="rl-export__note" data-testid="rl-export-note">
              {note}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- prompt view

function PromptView({ bridge, settings, entry, spec, prefs }: ViewProps) {
  const [target, setTarget] = usePersistedChoice(bridge, validTarget(settings.promptTarget), 'promptTarget');
  const status = useBridgeStatus();
  const { name } = baseNameOf(spec, getBaseNameOverride(entry.id) ?? null);
  const prompt = useMemo(
    () => promptOutcome(spec, { target, baseName: name, includeExamples: prefs.includeExamples }),
    [spec, target, name, prefs.includeExamples],
  );
  const text = prompt.ok ? prompt.value : '';
  const lines = useMemo(() => highlightMarkdown(text), [text]);
  const getText = useCallback(() => text, [text]);
  const textMeta = useMemo(() => sizeMeta(text, 'tokens'), [text]);
  const claudeReady = status.host === 'connected' && status.sessions.length > 0 && status.enabled && status.permission;
  const onSend = useCallback(
    (sessionId: string | null) => deliverPrompt({ entryId: entry.id, title: titleOf(spec), target, prompt: text, sessionId }),
    [entry.id, spec, target, text],
  );

  return (
    <div class="rl-export__view" data-testid="rl-export-prompt">
      <div class="rl-export__toolbar">
        <RadioGroup<PromptTarget> label="Prompt target" testId="rl-prompt-target" options={TARGET_OPTIONS} value={target} onChange={setTarget} />
        <Check
          testId="rl-prompt-examples"
          checked={prefs.includeExamples}
          onChange={(includeExamples) => setExportPrefs({ includeExamples })}
          title="Include request / response JSON examples (clipped)"
        >
          Include examples
        </Check>
      </div>
      {prompt.ok ? (
        <CodeView lines={lines} wrap label="Agent prompt preview" testId="rl-prompt-preview" kind="markdown" />
      ) : (
        <div class="rl-export__notice rl-error" role="alert" data-testid="rl-export-error">
          <Icon name="warning" size={13} />
          <span>Could not build the prompt: {prompt.error}</span>
        </div>
      )}
      <Footer meta={textMeta}>
        <CopyAction
          primary={!claudeReady}
          text={getText}
          label="Copy prompt"
          title="Copy the agent prompt (markdown)"
          done="Agent prompt copied"
          testId="rl-prompt-copy"
          disabled={!prompt.ok}
        />
        <ClaudeSend status={status} disabled={!prompt.ok} onSend={onSend} />
      </Footer>
    </div>
  );
}
