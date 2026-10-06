// OWNER: ui-editor agent. Editable key/value table for query params, headers and urlencoded form fields.
import type { JSX } from 'preact';
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { KVRow, ReplayMode } from '../../shared/types';
import { isForbiddenRequestHeader, isUnsafeToOverride } from '../../lib/headers';
import { createRow, parseBulk, removeRow, toBulk, updateRow } from '../../lib/kv';
import { Icon } from '../components/Icon';
import { isStandaloneShell } from '../shellMode';
import { mergeBulkRows } from './align';
import { rowDiffOf, type WarningIndex } from './derived';
import { AutoTextarea, ValueInput } from './inputs';
import { cx, isPlainEnter, memo, pluralize, safely } from './util';

export type KVKind = 'query' | 'headers' | 'form';

export interface KVTableProps {
  kind: KVKind;
  rows: KVRow[];
  /** Rows of the captured request (diff/revert baseline). */
  original: KVRow[];
  /** Stable: applies an immutable rows edit to the latest draft. */
  onRows(fn: (rows: KVRow[]) => KVRow[]): void;
  /** Stable: revert / restore one row by id. */
  onRevertRow(id: string): void;
  /** Replay mode, for header lock hints. */
  mode?: ReplayMode;
  warnings?: WarningIndex['byTarget'];
}

const COMMON_HEADERS = [
  'Accept',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Content-Type',
  'Cookie',
  'If-Match',
  'If-Modified-Since',
  'If-None-Match',
  'Origin',
  'Pragma',
  'Range',
  'Referer',
  'User-Agent',
  'X-Api-Key',
  'X-CSRF-Token',
  'X-Request-Id',
  'X-Requested-With',
];

const LABELS: Record<KVKind, { key: string; value: string; add: string; empty: string; sep: ':' | '=' }> = {
  query: { key: 'name', value: 'value', add: 'Add parameter', empty: 'No query parameters.', sep: '=' },
  headers: { key: 'Header', value: 'value', add: 'Add header', empty: 'No request headers.', sep: ':' },
  form: { key: 'field', value: 'value', add: 'Add field', empty: 'No form fields.', sep: '=' },
};

type Field = 'key' | 'value';

interface RowActions {
  update(id: string, patch: Partial<Omit<KVRow, 'id'>>): void;
  remove(id: string): void;
  revert(id: string): void;
  keyEnter(id: string): void;
  valueEnter(id: string): void;
  register(id: string, field: Field, el: HTMLElement | null): void;
}

type LockState = { tone: 'warn' | 'info' | 'danger'; title: string } | null;

function lockFor(kind: KVKind, name: string, mode: ReplayMode | undefined): LockState {
  if (kind !== 'headers' || !name.trim()) return null;
  const forbidden = safely(() => isForbiddenRequestHeader(name), false);
  if (!forbidden) return null;
  if (mode === 'extension') {
    return safely(() => isUnsafeToOverride(name), false)
      ? { tone: 'danger', title: 'Framing header — cannot be overridden, even in Extension mode.' }
      : { tone: 'info', title: 'Browser-controlled header — applied in Extension mode via a temporary request rule.' };
  }
  // App mode (standalone React Native tab): the app sends every header itself.
  if (isStandaloneShell()) return null;
  return {
    tone: 'warn',
    title: 'Controlled by the browser — ignored in Page mode. Switch to Extension mode to send it.',
  };
}

/** Key/value table with add, per-row revert/delete, removed-row restore and bulk edit. */
export const KVTable = memo(function KVTable(props: KVTableProps) {
  const { kind, rows, original, onRows, onRevertRow, mode, warnings } = props;
  const labels = LABELS[kind];
  const diff = rowDiffOf(original, rows);
  const [bulk, setBulk] = useState(false);
  const datalistId = `rl-hdr-${useId()}`;

  const els = useRef(new Map<string, Partial<Record<Field, HTMLElement>>>());
  const pendingFocus = useRef<{ id: string; field: Field } | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const focus = useCallback((id: string, field: Field) => {
    const el = els.current.get(id)?.[field];
    if (el) el.focus();
    else pendingFocus.current = { id, field };
  }, []);

  useLayoutEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    const el = els.current.get(p.id)?.[p.field];
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  });

  const addRow = useCallback(() => {
    const row = createRow();
    onRows((rs) => [...rs, row]);
    pendingFocus.current = { id: row.id, field: 'key' };
  }, [onRows]);

  const actions = useMemo<RowActions>(
    () => ({
      update: (id, patch) => onRows((rs) => updateRow(rs, id, patch)),
      remove: (id) => {
        const list = rowsRef.current;
        const i = list.findIndex((r) => r.id === id);
        const next = list[i + 1] ?? list[i - 1];
        onRows((rs) => removeRow(rs, id));
        if (next) focus(next.id, 'key');
      },
      revert: (id) => onRevertRow(id),
      keyEnter: (id) => focus(id, 'value'),
      valueEnter: (id) => {
        const list = rowsRef.current;
        const next = list[list.findIndex((r) => r.id === id) + 1];
        if (next) focus(next.id, 'key');
        else addRow();
      },
      register: (id, field, el) => {
        const entry = els.current.get(id) ?? {};
        if (el) entry[field] = el;
        else delete entry[field];
        if (entry.key || entry.value) els.current.set(id, entry);
        else els.current.delete(id);
      },
    }),
    [onRows, onRevertRow, focus, addRow],
  );

  const enabledCount = rows.reduce((n, r) => n + (r.enabled ? 1 : 0), 0);

  return (
    <div class={cx('rl-kv', `rl-kv--${kind}`)}>
      {bulk ? (
        <KVBulk rows={rows} original={original} sep={labels.sep} onRows={onRows} kind={kind} />
      ) : rows.length === 0 ? (
        <div class="rl-kv-empty rl-faint">{labels.empty}</div>
      ) : (
        <div class="rl-kv-table" role="table" aria-label={`${kind} rows`}>
          {rows.map((row) => {
            const w = warnings?.get(row.id);
            return (
              <KVRowView
                key={row.id}
                row={row}
                kind={kind}
                modified={diff.changed.has(row.id) || diff.added.has(row.id)}
                added={diff.added.has(row.id)}
                lock={lockFor(kind, row.key, mode)}
                warning={w?.message}
                warningLevel={w?.level}
                keyPlaceholder={labels.key}
                valuePlaceholder={labels.value}
                datalistId={kind === 'headers' ? datalistId : undefined}
                actions={actions}
              />
            );
          })}
        </div>
      )}
      {!bulk && diff.removed.length > 0 && (
        <div class="rl-kv-removed">
          <span class="rl-faint">Removed:</span>
          {diff.removed.map((r) => (
            <button
              key={r.id}
              type="button"
              class="rl-chip rl-kv-removed__item"
              data-testid="rl-kv-restore"
              title={`Restore ${r.key || '(empty)'}`}
              onClick={() => onRevertRow(r.id)}
            >
              <Icon name="revert" size={11} />
              <span class="rl-mono">{r.key || '(empty)'}</span>
            </button>
          ))}
        </div>
      )}
      <div class="rl-kv-footer">
        {!bulk && (
          <button type="button" class="rl-btn rl-btn--ghost rl-btn--sm" data-testid="rl-kv-add" onClick={addRow}>
            <Icon name="plus" size={12} />
            {labels.add}
          </button>
        )}
        {rows.length > 0 && !bulk && (
          <span class="rl-faint rl-kv-footer__count">
            {enabledCount === rows.length ? pluralize(rows.length, 'row') : `${enabledCount} of ${rows.length} enabled`}
          </span>
        )}
        <span class="rl-spacer" />
        <button
          type="button"
          class="rl-btn rl-btn--ghost rl-btn--sm"
          data-testid="rl-kv-bulk"
          aria-pressed={bulk}
          title={bulk ? 'Back to the table' : `Edit as text (one "key${labels.sep === ':' ? ': ' : '='}value" per line, # disables)`}
          onClick={() => setBulk((b) => !b)}
        >
          <Icon name={bulk ? 'check' : 'code'} size={12} />
          {bulk ? 'Done' : 'Bulk edit'}
        </button>
      </div>
      {kind === 'headers' && (
        <datalist id={datalistId}>
          {COMMON_HEADERS.map((h) => (
            <option key={h} value={h} />
          ))}
        </datalist>
      )}
    </div>
  );
}, sameTableProps);

/** Warnings maps are rebuilt on every draft change; only entries for this table's rows matter. */
function sameTableProps(a: Readonly<KVTableProps>, b: Readonly<KVTableProps>): boolean {
  if (
    a.kind !== b.kind ||
    a.rows !== b.rows ||
    a.original !== b.original ||
    a.onRows !== b.onRows ||
    a.onRevertRow !== b.onRevertRow ||
    a.mode !== b.mode
  ) {
    return false;
  }
  if (a.warnings === b.warnings) return true;
  for (const r of b.rows) {
    const x = a.warnings?.get(r.id);
    const y = b.warnings?.get(r.id);
    if (x?.message !== y?.message || x?.level !== y?.level) return false;
  }
  return true;
}

interface KVRowViewProps {
  row: KVRow;
  kind: KVKind;
  modified: boolean;
  added: boolean;
  lock: LockState;
  warning?: string;
  warningLevel?: 'error' | 'warn' | 'info';
  keyPlaceholder: string;
  valuePlaceholder: string;
  datalistId?: string;
  actions: RowActions;
}

function sameLock(a: LockState, b: LockState): boolean {
  return a === b || (!!a && !!b && a.tone === b.tone && a.title === b.title);
}

const KVRowView = memo(
  function KVRowView(props: KVRowViewProps) {
    const { row, actions, lock } = props;
    const id = row.id;
    const regKey = useCallback((el: HTMLElement | null) => actions.register(id, 'key', el), [actions, id]);
    const regValue = useCallback((el: HTMLElement | null) => actions.register(id, 'value', el), [actions, id]);
    const onValue = useCallback((value: string) => actions.update(id, { value }), [actions, id]);
    const onValueEnter = useCallback(() => actions.valueEnter(id), [actions, id]);

    const onKeyKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
      if (isPlainEnter(e)) {
        e.preventDefault();
        actions.keyEnter(id);
      }
    };

    return (
      <div
        class={cx(
          'rl-kv-row',
          !row.enabled && 'rl-kv-row--disabled',
          props.modified && 'rl-kv-row--modified',
          lock && `rl-kv-row--lock-${lock.tone}`,
        )}
        role="row"
        data-testid="rl-kv-row"
        data-key={row.key}
        data-modified={String(props.modified)}
        data-target-id={id}
      >
        <span class="rl-kv-cell rl-kv-cell--check" role="cell">
          <input
            type="checkbox"
            class="rl-checkbox"
            data-testid="rl-kv-enabled"
            aria-label={`Send ${row.key || 'row'}`}
            title={row.enabled ? 'Enabled — uncheck to leave it out' : 'Disabled — not sent'}
            checked={row.enabled}
            onChange={(e) => actions.update(id, { enabled: e.currentTarget.checked })}
          />
        </span>
        <span class="rl-kv-cell rl-kv-cell--key" role="cell">
          {lock && (
            <span class={cx('rl-kv-lock', `rl-kv-lock--${lock.tone}`)} title={lock.title}>
              <Icon name="lock" size={11} />
            </span>
          )}
          <input
            ref={regKey}
            type="text"
            class="rl-input rl-input--mono rl-kv-input rl-kv-input--key"
            data-testid="rl-kv-key"
            aria-label={`Name of ${row.key || 'new row'}`}
            placeholder={props.keyPlaceholder}
            spellcheck={false}
            autocomplete="off"
            list={props.datalistId}
            value={row.key}
            onInput={(e) => actions.update(id, { key: e.currentTarget.value })}
            onKeyDown={onKeyKeyDown}
          />
        </span>
        <span class="rl-kv-cell rl-kv-cell--value" role="cell">
          <ValueInput
            value={row.value}
            onValue={onValue}
            ariaLabel={`Value of ${row.key || 'row'}`}
            testId="rl-kv-value"
            placeholder={props.valuePlaceholder}
            class="rl-kv-input rl-kv-input--value"
            allowNewlines={props.kind !== 'headers'}
            longThreshold={props.kind === 'headers' ? 120 : 80}
            onEnter={onValueEnter}
            elRef={regValue}
          />
        </span>
        <span class="rl-kv-cell rl-kv-cell--status" role="cell">
          {props.warning && (
            <span
              class={cx('rl-kv-warn', props.warningLevel === 'error' && 'rl-kv-warn--error')}
              title={props.warning}
              aria-label={props.warning}
            >
              <Icon name="warning" size={12} />
            </span>
          )}
          {props.modified && <span class="rl-modified-dot" title={props.added ? 'Added' : 'Modified'} />}
        </span>
        <span class="rl-kv-cell rl-kv-cell--actions" role="cell">
          {props.modified && (
            <button
              type="button"
              class="rl-icon-btn rl-icon-btn--sm"
              data-testid="rl-kv-revert"
              title={props.added ? 'Remove added row' : 'Revert to captured value'}
              aria-label={`Revert ${row.key || 'row'}`}
              onClick={() => actions.revert(id)}
            >
              <Icon name="revert" size={12} />
            </button>
          )}
          <button
            type="button"
            class="rl-icon-btn rl-icon-btn--sm rl-kv-delete"
            data-testid="rl-kv-delete"
            title="Delete row"
            aria-label={`Delete ${row.key || 'row'}`}
            onClick={() => actions.remove(id)}
          >
            <Icon name="trash" size={12} />
          </button>
        </span>
      </div>
    );
  },
  (a, b) =>
    a.row === b.row &&
    a.modified === b.modified &&
    a.added === b.added &&
    sameLock(a.lock, b.lock) &&
    a.warning === b.warning &&
    a.warningLevel === b.warningLevel &&
    a.actions === b.actions &&
    a.kind === b.kind &&
    a.datalistId === b.datalistId &&
    a.keyPlaceholder === b.keyPlaceholder,
);

interface KVBulkProps {
  kind: KVKind;
  rows: KVRow[];
  original: KVRow[];
  sep: ':' | '=';
  onRows(fn: (rows: KVRow[]) => KVRow[]): void;
}

/** Bulk editor: textarea of "key=value" / "Key: value" lines; rows keep their ids where lines still match. */
function KVBulk({ kind, rows, original, sep, onRows }: KVBulkProps) {
  const [state, setState] = useState(() => ({ text: safely(() => toBulk(rows, sep), ''), rows }));
  // When rows change from elsewhere (revert, URL paste), show their text instead of the stale draft.
  const text = state.rows === rows ? state.text : safely(() => toBulk(rows, sep), '');

  const onValue = (next: string) => {
    const parsed = safely(() => parseBulk(next, sep), null);
    if (!parsed) {
      setState({ text: next, rows });
      return;
    }
    const merged = mergeBulkRows(rows, original, parsed);
    onRows(() => merged);
    setState({ text: next, rows: merged });
  };

  return (
    <div class="rl-kv-bulk">
      <AutoTextarea
        value={text}
        onValue={onValue}
        class="rl-textarea--mono rl-kv-bulk__text"
        testId="rl-kv-bulk-text"
        ariaLabel={`${kind} as text`}
        placeholder={sep === ':' ? 'Accept: application/json\n# X-Disabled: value' : 'page=1\n# disabled=true'}
        minRows={4}
        maxHeight={360}
      />
    </div>
  );
}
