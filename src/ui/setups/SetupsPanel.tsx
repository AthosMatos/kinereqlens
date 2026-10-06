// Setups panel (inside the header popover): "Save current as…", the active setup bar, import / export, search,
// and the setups grouped by group (collapsible) with Apply and a ⋯ menu per setup.
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { MAX_SETUP_GROUP, MAX_SETUP_NAME, MAX_SETUPS, MAX_SETUP_SITES } from '../../shared/constants';
import type { Setup } from '../../shared/types';
import { Icon } from '../components/Icon';
import { MenuButton } from '../components/Menu';
import type { MenuItem } from '../components/Menu';
import { toast } from '../components/toast';
import { useBridge } from '../hooks';
import { replayModeName } from '../shellMode';
import {
  applySetup,
  deleteSetupAction,
  duplicateSetupAction,
  exportSetupsAction,
  importSetupsAction,
  moveSetupAction,
  renameSetupAction,
  saveCurrentAs,
  setSitesAction,
  updateWithCurrent,
} from './actions';
import {
  canonicalGroup,
  findByName,
  groupNames,
  groupSetups,
  importSetups,
  importSummary,
  normalizeHostPattern,
  pageHostOf,
  pageSite,
  parseSetupsFile,
  searchSetups,
  setupSummary,
  stateLanguage,
  uniqueName,
} from './model';
import type { ImportMode, ListConfigState } from './model';

/** Show the search box beyond this many setups. */
const SEARCH_THRESHOLD = 8;
/** Group suggestions shown under a group input. */
const MAX_SUGGESTIONS = 6;

/** Collapsed groups (per panel lifetime, survives reopening the popover). */
const collapsedGroups = new Set<string>();

export interface SetupsPanelProps {
  setups: Setup[];
  state: ListConfigState;
  active: Setup | null;
  modified: boolean;
  pageUrl: string;
  /** The import file chooser opens / closed (the popover ignores the window blur meanwhile). */
  onPicking(on: boolean): void;
}

type Editing = { id: string; kind: 'rename' | 'group' | 'sites' } | null;

interface PendingImport {
  fileName: string;
  setups: Setup[];
  invalid: number;
}

export function SetupsPanel({ setups, state, active, modified, pageUrl, onPicking }: SetupsPanelProps) {
  const bridge = useBridge();
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(collapsedGroups));
  const fileRef = useRef<HTMLInputElement>(null);
  const site = pageSite(pageUrl);
  const host = pageHostOf(pageUrl)?.display ?? null;

  const searching = setups.length > SEARCH_THRESHOLD && query.trim() !== '';
  const shown = useMemo(() => (searching ? searchSetups(setups, query) : setups), [setups, query, searching]);
  const groups = useMemo(() => groupSetups(shown), [shown]);

  const toggleGroup = (group: string) => {
    if (collapsedGroups.has(group)) collapsedGroups.delete(group);
    else collapsedGroups.add(group);
    setCollapsed(new Set(collapsedGroups));
  };

  const pickFile = () => {
    onPicking(true);
    fileRef.current?.click();
  };

  const onFile = async (e: JSX.TargetedEvent<HTMLInputElement, Event>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    onPicking(false);
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      toast(`Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return;
    }
    const parsed = parseSetupsFile(text);
    if (!parsed.ok) {
      toast(`Could not import ${file.name}: ${parsed.error}`, 'error');
      return;
    }
    if (!parsed.setups.length) {
      toast(`${file.name} has no valid setups`, 'warn');
      return;
    }
    setSaving(false);
    setPendingImport({ fileName: file.name, setups: parsed.setups, invalid: parsed.invalid });
  };

  return (
    <div class="rl-setups">
      <div class="rl-setups__head">
        <span class="rl-setups__title">Setups</span>
        {setups.length ? <span class="rl-setups__count">{setups.length}</span> : null}
        <span class="rl-spacer" />
        <button
          type="button"
          class="rl-btn rl-btn--ghost rl-btn--sm"
          title="Import setups from a JSON file"
          data-testid="rl-setups-import"
          onClick={pickFile}
        >
          <Icon name="upload" size={12} />
          Import
        </button>
        <button
          type="button"
          class="rl-btn rl-btn--ghost rl-btn--sm"
          title="Export every setup to a JSON file"
          data-testid="rl-setups-export-all"
          disabled={!setups.length}
          onClick={() => exportSetupsAction(setups)}
        >
          <Icon name="download" size={12} />
          Export all
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="rl-setups-import-file"
          onChange={onFile}
          onCancel={() => onPicking(false)}
        />
      </div>

      {active ? (
        <div class={`rl-setups__active${modified ? ' rl-setups__active--modified' : ''}`} data-testid="rl-setups-active">
          <div class="rl-setups__active-line">
            <span class="rl-setups__active-label">{modified ? 'Modified' : 'Active'}</span>
            <span class="rl-setups__active-name rl-truncate" title={active.name}>
              {active.name}
            </span>
          </div>
          {modified ? (
            <div class="rl-setups__active-actions">
              <button
                type="button"
                class="rl-btn rl-btn--sm rl-btn--primary rl-setups__update"
                data-testid="rl-setups-update-active"
                title="Store the current types, rules and mode in this setup"
                onClick={() => updateWithCurrent(bridge, active)}
              >
                <span class="rl-truncate">Update '{active.name}' with current</span>
              </button>
              <button
                type="button"
                class="rl-btn rl-btn--sm rl-btn--ghost"
                data-testid="rl-setups-revert"
                title="Discard the changes: apply the setup again"
                onClick={() => applySetup(bridge, active)}
              >
                <Icon name="revert" size={12} />
                Revert
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {pendingImport ? (
        <ImportConfirm
          pending={pendingImport}
          setups={setups}
          onCancel={() => setPendingImport(null)}
          onImport={(mode) => {
            importSetupsAction(bridge, pendingImport.setups, mode);
            setPendingImport(null);
          }}
        />
      ) : saving ? (
        <SaveForm
          setups={setups}
          site={site}
          host={host}
          defaultMode={state.defaultMode}
          language={stateLanguage(state)}
          onCancel={() => setSaving(false)}
          onSave={(req) => {
            if (saveCurrentAs(bridge, req)) setSaving(false);
          }}
        />
      ) : (
        <button
          type="button"
          class="rl-setups__save-open"
          data-testid="rl-setups-save-open"
          disabled={setups.length >= MAX_SETUPS}
          title={setups.length >= MAX_SETUPS ? `At most ${MAX_SETUPS} setups — delete some first` : 'Save the current types, rules and mode as a setup'}
          onClick={() => {
            setEditing(null);
            setSaving(true);
          }}
        >
          <Icon name="plus" size={12} />
          Save current as…
        </button>
      )}

      {setups.length > SEARCH_THRESHOLD ? (
        <div class="rl-search rl-setups__search">
          <Icon name="search" size={12} class="rl-search__icon" />
          <input
            type="text"
            class="rl-input rl-search__input"
            placeholder="Search setups"
            aria-label="Search setups by name, group or site"
            spellcheck={false}
            autocomplete="off"
            value={query}
            data-testid="rl-setups-search"
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault();
                setQuery('');
              }
            }}
          />
        </div>
      ) : null}

      {setups.length === 0 ? (
        <div class="rl-setups__empty">
          <Icon name="layers" size={18} class="rl-setups__empty-icon" />
          <div>
            Save the current request types, list rules and replay mode as a setup to switch back to them in one click —
            or apply one automatically on a site.
          </div>
        </div>
      ) : shown.length === 0 ? (
        <div class="rl-setups__empty rl-setups__empty--search">No setup matches “{query.trim()}”</div>
      ) : (
        <div class="rl-setups__list" role="list" aria-label="Setups">
          {groups.map(({ group, setups: list }) => {
            const isCollapsed = !searching && group !== '' && collapsed.has(group);
            return (
              <div key={`g:${group}`} class="rl-setups__groupbox" role="presentation">
                {group ? (
                  <button
                    type="button"
                    class="rl-setups__group"
                    aria-expanded={isCollapsed ? 'false' : 'true'}
                    data-testid="rl-setups-group"
                    data-group={group}
                    onClick={() => toggleGroup(group)}
                  >
                    <Icon name="chevron-right" size={11} class={`rl-setups__chevron${isCollapsed ? '' : ' rl-setups__chevron--open'}`} />
                    <span class="rl-setups__group-name rl-truncate">{group}</span>
                    <span class="rl-setups__group-count">{list.length}</span>
                  </button>
                ) : null}
                {isCollapsed
                  ? null
                  : list.map((setup) => (
                      <SetupRow
                        key={setup.id}
                        setup={setup}
                        setups={setups}
                        isActive={setup.id === state.activeSetupId}
                        modified={setup.id === state.activeSetupId && modified}
                        editing={editing?.id === setup.id ? editing.kind : null}
                        site={site}
                        onEdit={(kind) => setEditing(kind ? { id: setup.id, kind } : null)}
                      />
                    ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- save form

interface SaveFormProps {
  setups: Setup[];
  site: string | null;
  host: string | null;
  defaultMode: ListConfigState['defaultMode'];
  /** The page's site language (offered for the setup), or null. */
  language: string | null;
  onSave(req: { name: string; group: string; sites: string[]; includeMode: boolean; includeLanguage: boolean }): void;
  onCancel(): void;
}

function SaveForm({ setups, site, host, defaultMode, language, onSave, onCancel }: SaveFormProps) {
  const [name, setName] = useState(() => (host ? uniqueName(setups, host, '') : ''));
  const [group, setGroup] = useState('');
  const [auto, setAuto] = useState(false);
  const [includeMode, setIncludeMode] = useState(true);
  const [includeLanguage, setIncludeLanguage] = useState(true);
  const [error, setError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus({ preventScroll: true });
    nameRef.current?.select();
  }, []);

  const submit = (e: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    e.preventDefault();
    const finalGroup = canonicalGroup(setups, group);
    if (!name.trim()) {
      setError('Enter a name');
      nameRef.current?.focus();
      return;
    }
    if (findByName(setups, name, finalGroup)) {
      setError(`A setup named '${name.trim()}' already exists${finalGroup ? ` in ${finalGroup}` : ''}`);
      nameRef.current?.focus();
      return;
    }
    onSave({ name, group: finalGroup, sites: auto && site ? [site] : [], includeMode, includeLanguage: includeLanguage && !!language });
  };

  return (
    <form class="rl-setups__form" data-testid="rl-setups-save-form" onSubmit={submit}>
      <label class="rl-setups__field">
        <span class="rl-setups__label">Name</span>
        <input
          ref={nameRef}
          type="text"
          class="rl-input rl-input--sm"
          maxLength={MAX_SETUP_NAME}
          value={name}
          spellcheck={false}
          autocomplete="off"
          aria-invalid={error ? 'true' : undefined}
          data-testid="rl-setup-name"
          onInput={(e) => {
            setName(e.currentTarget.value);
            setError('');
          }}
          onKeyDown={(e) => escapeTo(e, onCancel)}
        />
      </label>
      <GroupInput setups={setups} value={group} onInput={(v) => (setGroup(v), setError(''))} onEscape={onCancel} testId="rl-setup-group" />
      {site ? (
        <label class="rl-setups__check">
          <input type="checkbox" class="rl-checkbox" checked={auto} data-testid="rl-setup-auto" onChange={(e) => setAuto(e.currentTarget.checked)} />
          <span>
            Auto-apply on <span class="rl-mono">{host}</span>
          </span>
        </label>
      ) : null}
      <label class="rl-setups__check">
        <input
          type="checkbox"
          class="rl-checkbox"
          checked={includeMode}
          data-testid="rl-setup-include-mode"
          onChange={(e) => setIncludeMode(e.currentTarget.checked)}
        />
        <span>Include replay mode ({replayModeName(defaultMode === 'extension' ? 'extension' : 'page')})</span>
      </label>
      {language ? (
        <label class="rl-setups__check">
          <input
            type="checkbox"
            class="rl-checkbox"
            checked={includeLanguage}
            data-testid="rl-setup-include-language"
            onChange={(e) => setIncludeLanguage(e.currentTarget.checked)}
          />
          <span>
            Include site language (<span class="rl-mono">{language}</span>)
          </span>
        </label>
      ) : null}
      {error ? (
        <div class="rl-setups__error" role="alert">
          {error}
        </div>
      ) : null}
      <div class="rl-setups__form-actions">
        <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" class="rl-btn rl-btn--sm rl-btn--primary" data-testid="rl-setup-save">
          Save
        </button>
      </div>
    </form>
  );
}

function escapeTo(e: JSX.TargetedKeyboardEvent<HTMLElement>, fn: () => void): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  fn();
}

interface GroupInputProps {
  setups: Setup[];
  value: string;
  onInput(value: string): void;
  onEscape(): void;
  onEnter?(): void;
  testId: string;
  autoFocus?: boolean;
  label?: string;
}

/** Group input with clickable suggestions from the existing groups. */
function GroupInput({ setups, value, onInput, onEscape, onEnter, testId, autoFocus, label = 'Group' }: GroupInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus({ preventScroll: true });
      ref.current?.select();
    }
  }, []);
  const typed = value.trim().toLocaleLowerCase();
  const suggestions = groupNames(setups)
    .filter((g) => g.toLocaleLowerCase() !== typed && (!typed || g.toLocaleLowerCase().includes(typed)))
    .slice(0, MAX_SUGGESTIONS);
  return (
    <div class="rl-setups__field">
      <label class="rl-setups__label" for={`${testId}-input`}>
        {label}
      </label>
      <input
        ref={ref}
        id={`${testId}-input`}
        type="text"
        class="rl-input rl-input--sm"
        placeholder="Ungrouped"
        maxLength={MAX_SETUP_GROUP}
        value={value}
        spellcheck={false}
        autocomplete="off"
        data-testid={testId}
        onInput={(e) => onInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          } else escapeTo(e, onEscape);
        }}
      />
      {suggestions.length ? (
        <div class="rl-setups__suggestions" role="group" aria-label="Existing groups">
          {suggestions.map((g) => (
            <button key={g} type="button" class="rl-setups__suggestion" data-testid="rl-setup-group-suggestion" onClick={() => onInput(g)}>
              {g}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- import

function ImportConfirm({
  pending,
  setups,
  onImport,
  onCancel,
}: {
  pending: PendingImport;
  setups: Setup[];
  onImport(mode: ImportMode): void;
  onCancel(): void;
}) {
  const [mode, setMode] = useState<ImportMode>('merge');
  const preview = (m: ImportMode) => importSetups(setups, pending.setups, m, { now: Date.now(), newId: () => 'preview' });
  const merge = useMemo(() => preview('merge'), [setups, pending]);
  const replace = useMemo(() => preview('replace'), [setups, pending]);
  const n = pending.setups.length;
  return (
    <div class="rl-setups__import" data-testid="rl-setups-import-confirm" role="group" aria-label="Import setups">
      <div class="rl-setups__import-title">
        <Icon name="upload" size={12} />
        <span class="rl-truncate" title={pending.fileName}>
          {pending.fileName}
        </span>
      </div>
      <div class="rl-setups__import-text">
        {n} setup{n === 1 ? '' : 's'} in the file
        {pending.invalid ? ` · ${pending.invalid} invalid skipped` : ''}
      </div>
      {setups.length ? (
        <div class="rl-setups__choices" role="radiogroup" aria-label="How to import">
          <label class="rl-setups__choice">
            <input type="radio" name="rl-import-mode" checked={mode === 'merge'} data-testid="rl-setups-import-merge" onChange={() => setMode('merge')} />
            <span>
              <strong>Merge</strong>
              <span class="rl-setups__choice-note">{importSummary(merge)}</span>
            </span>
          </label>
          <label class="rl-setups__choice">
            <input
              type="radio"
              name="rl-import-mode"
              checked={mode === 'replace'}
              data-testid="rl-setups-import-replace"
              onChange={() => setMode('replace')}
            />
            <span>
              <strong>Replace all</strong>
              <span class="rl-setups__choice-note">
                {setups.length} current setup{setups.length === 1 ? '' : 's'} removed · {replace.added} imported
              </span>
            </span>
          </label>
        </div>
      ) : (
        <div class="rl-setups__import-text">{importSummary(merge)}</div>
      )}
      <div class="rl-setups__form-actions">
        <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" class="rl-btn rl-btn--sm rl-btn--primary" data-testid="rl-setups-import-apply" onClick={() => onImport(mode)}>
          Import
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------- rows

interface SetupRowProps {
  setup: Setup;
  setups: Setup[];
  isActive: boolean;
  modified: boolean;
  editing: 'rename' | 'group' | 'sites' | null;
  site: string | null;
  onEdit(kind: 'rename' | 'group' | 'sites' | null): void;
}

function SetupRow({ setup, setups, isActive, modified, editing, site, onEdit }: SetupRowProps) {
  const bridge = useBridge();
  const summary = setupSummary(setup);
  const items: MenuItem[] = [
    { label: 'Rename', testId: 'rl-setup-rename', onSelect: () => onEdit('rename') },
    { label: 'Move to group…', testId: 'rl-setup-move', onSelect: () => onEdit('group') },
    { label: 'Edit sites…', testId: 'rl-setup-sites', hint: setup.sites.length ? String(setup.sites.length) : undefined, onSelect: () => onEdit('sites') },
    { label: 'Duplicate', testId: 'rl-setup-duplicate', onSelect: () => duplicateSetupAction(bridge, setup) },
    { label: 'Update with current', testId: 'rl-setup-update', onSelect: () => updateWithCurrent(bridge, setup) },
    { label: 'Export', testId: 'rl-setup-export', onSelect: () => exportSetupsAction([setup]) },
    { label: 'Delete', danger: true, testId: 'rl-setup-delete', onSelect: () => deleteSetupAction(bridge, setup) },
  ];
  return (
    <div
      class={`rl-setup${isActive ? ' rl-setup--active' : ''}${modified ? ' rl-setup--modified' : ''}`}
      role="listitem"
      data-testid="rl-setup-row"
      data-setup-id={setup.id}
      data-name={setup.name}
      data-active={isActive ? 'true' : 'false'}
    >
      <div class="rl-setup__top">
        <span class="rl-setup__marker" aria-hidden="true">
          {isActive ? <Icon name="check" size={12} /> : null}
        </span>
        <div class="rl-setup__main">
          {editing === 'rename' ? (
            <InlineText
              value={setup.name}
              label={`Rename ${setup.name}`}
              maxLength={MAX_SETUP_NAME}
              testId="rl-setup-rename-input"
              validate={(v) => (findByName(setups, v, setup.group, setup.id) ? 'That name is taken in this group' : '')}
              onCommit={(v) => {
                if (v.trim()) renameSetupAction(bridge, setup, v);
                onEdit(null);
              }}
              onCancel={() => onEdit(null)}
            />
          ) : (
            <span class="rl-setup__name rl-truncate" title={setup.name}>
              {setup.name}
              {isActive ? <span class="rl-sr-only">{modified ? ' (active, modified)' : ' (active)'}</span> : null}
            </span>
          )}
          <span class="rl-setup__summary rl-truncate" title={summary} data-testid="rl-setup-summary">
            {summary}
          </span>
        </div>
        <button
          type="button"
          class={`rl-btn rl-btn--sm${isActive && !modified ? ' rl-btn--ghost' : ''} rl-setup__apply`}
          aria-label={`Apply setup ${setup.name}`}
          title={isActive && !modified ? 'Active — apply again' : 'Apply this setup to the request list'}
          data-testid="rl-setup-apply"
          onClick={() => applySetup(bridge, setup)}
        >
          Apply
        </button>
        <MenuButton title={`More actions for ${setup.name}`} icon="more" items={items} align="end" testId="rl-setup-menu" class="rl-icon-btn--sm" />
      </div>
      {editing === 'group' ? (
        <GroupEditor setup={setup} setups={setups} onDone={() => onEdit(null)} />
      ) : editing === 'sites' ? (
        <SitesEditor setup={setup} site={site} onDone={() => onEdit(null)} />
      ) : null}
    </div>
  );
}

interface InlineTextProps {
  value: string;
  label: string;
  maxLength: number;
  testId: string;
  validate?(value: string): string;
  onCommit(value: string): void;
  onCancel(): void;
}

/** A text input that commits on Enter / blur and cancels on Escape. */
function InlineText({ value, label, maxLength, testId, validate, onCommit, onCancel }: InlineTextProps) {
  const [text, setText] = useState(value);
  const [error, setError] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const commit = () => {
    if (done.current) return;
    const problem = validate?.(text) ?? '';
    if (problem) {
      setError(problem);
      return;
    }
    done.current = true;
    onCommit(text);
  };
  return (
    <span class="rl-setup__inline">
      <input
        ref={ref}
        type="text"
        class="rl-input rl-input--sm"
        aria-label={label}
        aria-invalid={error ? 'true' : undefined}
        maxLength={maxLength}
        value={text}
        spellcheck={false}
        autocomplete="off"
        data-testid={testId}
        onInput={(e) => {
          setText(e.currentTarget.value);
          setError('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            done.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          if (!done.current && !validate?.(text)) commit();
        }}
      />
      {error ? (
        <span class="rl-setups__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function GroupEditor({ setup, setups, onDone }: { setup: Setup; setups: Setup[]; onDone(): void }) {
  const bridge = useBridge();
  const [group, setGroup] = useState(setup.group);
  const save = (value: string) => {
    moveSetupAction(bridge, setup, value);
    onDone();
  };
  return (
    <div class="rl-setup__editor" data-testid="rl-setup-group-editor">
      <GroupInput
        setups={setups}
        value={group}
        label="Move to group"
        autoFocus
        testId="rl-setup-group-input"
        onInput={setGroup}
        onEscape={onDone}
        onEnter={() => save(group)}
      />
      <div class="rl-setups__form-actions">
        {setup.group ? (
          <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" onClick={() => save('')}>
            Ungroup
          </button>
        ) : null}
        <span class="rl-spacer" />
        <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="button" class="rl-btn rl-btn--sm rl-btn--primary" data-testid="rl-setup-group-save" onClick={() => save(group)}>
          Move
        </button>
      </div>
    </div>
  );
}

/** Inline list editor of a setup's auto-apply sites (changes are saved at once). */
function SitesEditor({ setup, site, onDone }: { setup: Setup; site: string | null; onDone(): void }) {
  const bridge = useBridge();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const full = setup.sites.length >= MAX_SETUP_SITES;

  const add = (value: string) => {
    const pattern = normalizeHostPattern(value);
    if (!pattern) {
      setError('Not a host pattern — e.g. api.example.com, *.example.com or localhost:3000');
      return;
    }
    if (setup.sites.includes(pattern)) {
      setError(`${pattern} is already listed`);
      return;
    }
    if (full) {
      setError(`At most ${MAX_SETUP_SITES} sites`);
      return;
    }
    setSitesAction(bridge, setup, [...setup.sites, pattern]);
    setText('');
    setError('');
    ref.current?.focus({ preventScroll: true });
  };

  return (
    <div class="rl-setup__editor" data-testid="rl-setup-sites-editor">
      <div class="rl-setups__label">Auto-apply on</div>
      {setup.sites.length ? (
        <ul class="rl-setup__sites">
          {setup.sites.map((s) => (
            <li key={s} class="rl-setup__site" data-testid="rl-setup-site" data-site={s}>
              <span class="rl-mono rl-truncate">{s}</span>
              <button
                type="button"
                class="rl-icon-btn rl-icon-btn--sm"
                title={`Remove ${s}`}
                aria-label={`Remove site ${s}`}
                data-testid="rl-setup-site-remove"
                onClick={() => setSitesAction(bridge, setup, setup.sites.filter((x) => x !== s))}
              >
                <Icon name="close" size={10} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div class="rl-setups__hint">No sites — this setup is only applied by hand.</div>
      )}
      <form
        class="rl-setup__site-add"
        onSubmit={(e) => {
          e.preventDefault();
          add(text);
        }}
      >
        <input
          ref={ref}
          type="text"
          class="rl-input rl-input--sm rl-input--mono"
          placeholder="*.example.com or host:port"
          aria-label="Add a site (host pattern)"
          aria-invalid={error ? 'true' : undefined}
          value={text}
          spellcheck={false}
          autocomplete="off"
          disabled={full}
          data-testid="rl-setup-site-input"
          onInput={(e) => {
            setText(e.currentTarget.value);
            setError('');
          }}
          onKeyDown={(e) => escapeTo(e, onDone)}
        />
        <button type="submit" class="rl-btn rl-btn--sm" disabled={full || !text.trim()} data-testid="rl-setup-site-add">
          Add
        </button>
      </form>
      {error ? (
        <div class="rl-setups__error" role="alert">
          {error}
        </div>
      ) : null}
      <div class="rl-setups__form-actions">
        {site && !setup.sites.includes(site) && !full ? (
          <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost rl-setups__add-host" data-testid="rl-setup-site-add-current" onClick={() => add(site)}>
            <Icon name="plus" size={11} />
            <span class="rl-truncate">{site}</span>
          </button>
        ) : null}
        <span class="rl-spacer" />
        <button type="button" class="rl-btn rl-btn--sm" data-testid="rl-setup-sites-done" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
