// OWNER: ui-editor agent. Editor pane: request line, Params / Headers / Body sections, warnings and send bar.
import type { JSX } from 'preact';
import { useCallback, useMemo, useRef } from 'preact/hooks';
import type { BodyType, DraftSection, HeaderPair, KVRow, ReqlensBridge, RequestEntry, Settings } from '../../shared/types';
import { toCurl, toFetchSnippet } from '../../lib/curl';
import { revertRowIn, setBodyType, type DraftWarning } from '../../lib/draft';
import { createRow } from '../../lib/kv';
import { copyText } from '../components/clipboard';
import { Icon } from '../components/Icon';
import { toast } from '../components/toast';
import { BodyEditor, BodyToolbar, bodySummary } from './BodyEditor';
import { manualInitOf } from './duplicate';
import { blockingErrorsOf, indexWarnings, isModifiedCached, sectionsOf, urlOf, warningsOf } from './derived';
import {
  buildRequestFor,
  getRecord,
  rawApplies,
  resolveSendOptions,
  revertAll,
  revertDraftSection,
  setBodyView,
  updateDraft,
  type BodyView,
  type DraftUpdater,
  type EntryRecord,
} from './draftStore';
import { KVTable } from './KVTable';
import { RequestLine } from './RequestLine';
import { Section } from './Section';
import { SendBar } from './SendBar';
import { sendEntry } from './sendAction';
import { errorMessage, isSendShortcut, safely, usePersistentToggle } from './util';

export interface EditorPaneProps {
  bridge: ReqlensBridge;
  entry: RequestEntry;
  /** Record of `entry` with a non-null draft. */
  record: EntryRecord;
  settings: Settings;
  /** Select another entry (the duplicate). */
  onSelectEntry?(entryId: string): void;
}

const NO_EDITOR_WARNINGS: DraftWarning[] = [];


export function EditorPane({ bridge, entry, record, settings, onSelectEntry }: EditorPaneProps) {
  const draft = record.draft!;
  const entryId = entry.id;
  const rootRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ bridge, entry, settings, onSelectEntry });
  latest.current = { bridge, entry, settings, onSelectEntry };

  const update = useCallback<DraftUpdater>((fn) => updateDraft(entryId, fn), [entryId]);
  const resolved = resolveSendOptions(record.options, settings, entry);
  const sections = sectionsOf(draft);
  const rawError = rawApplies(record) ? record.raw.error : null;

  const draftIssues = warningsOf(draft, resolved.mode);
  const warnings = useMemo<DraftWarning[]>(() => {
    if (!rawError) return draftIssues.length ? draftIssues : NO_EDITOR_WARNINGS;
    return [{ level: 'error', section: 'body', message: `Raw body: ${rawError}` }, ...draftIssues];
  }, [draftIssues, rawError]);
  const index = indexWarnings(draftIssues);
  const errorCount = blockingErrorsOf(draft, resolved.mode) + (rawError ? 1 : 0);
  const running = record.runs.some((r) => r.state === 'running');
  const fullUrl = urlOf(draft);
  const urlIssue = draftIssues.find((w) => w.section === 'url' && w.level === 'error');

  // ------------------------------------------------------------------ actions (stable per entry)

  const send = useCallback(() => {
    const { bridge: b, entry: e, settings: s } = latest.current;
    sendEntry(b, e, s);
  }, []);

  const copySnippet = useCallback((kind: 'curl' | 'fetch') => {
    const { entry: e, settings: s } = latest.current;
    const rec = getRecord(e.id);
    if (!rec?.draft) return;
    try {
      const { request } = buildRequestFor(rec.draft, e, resolveSendOptions(rec.options, s, e), s, 'copy');
      const snippet = { method: request.method, url: request.url, headers: request.headers, body: request.body };
      void copyText(kind === 'curl' ? toCurl(snippet) : toFetchSnippet(snippet), kind === 'curl' ? 'cURL copied' : 'fetch copied');
    } catch (err) {
      toast(`Could not build the snippet: ${errorMessage(err)}`, 'error');
    }
  }, []);

  /** Fork the request as it would be sent now (edits included) into a new manual entry, and select it. */
  const duplicate = useCallback(() => {
    const { bridge: b, entry: e, settings: s, onSelectEntry: selectEntry } = latest.current;
    const rec = getRecord(e.id);
    if (!rec?.draft) return;
    try {
      const { request } = buildRequestFor(rec.draft, e, resolveSendOptions(rec.options, s, e), s, 'duplicate');
      const copy = b.addManualEntry(manualInitOf(request));
      selectEntry?.(copy.id);
      toast('Duplicated as a new request', 'info');
    } catch (err) {
      toast(`Could not duplicate: ${errorMessage(err)}`, 'error');
    }
  }, []);

  const onRevertAll = useCallback(() => revertAll(entryId), [entryId]);
  const revert = useCallback((section: DraftSection) => revertDraftSection(entryId, section), [entryId]);
  const onRevertMethod = useCallback(() => revert('method'), [revert]);
  const onRevertUrl = useCallback(
    (withQuery: boolean) => {
      revert('url');
      if (withQuery) revert('query');
    },
    [revert],
  );

  const onQueryRows = useCallback(
    (fn: (rows: KVRow[]) => KVRow[]) =>
      update((d) => {
        const query = fn(d.query);
        return query === d.query ? d : { ...d, query };
      }),
    [update],
  );
  const onHeaderRows = useCallback(
    (fn: (rows: KVRow[]) => KVRow[]) =>
      update((d) => {
        const headers = fn(d.headers);
        return headers === d.headers ? d : { ...d, headers };
      }),
    [update],
  );
  const onRevertQueryRow = useCallback((id: string) => update((d) => revertRowIn(d, 'query', id)), [update]);
  const onRevertHeaderRow = useCallback((id: string) => update((d) => revertRowIn(d, 'headers', id)), [update]);

  const onBodyType = useCallback(
    (type: BodyType) => update((d) => (d.body.type === type ? d : safely(() => setBodyType(d, type), d))),
    [update],
  );
  const onBodyView = useCallback((view: BodyView) => setBodyView(entryId, view), [entryId]);

  const addWireHeader = useCallback(
    (h: HeaderPair) => {
      update((d) => ({ ...d, headers: [...d.headers, createRow(h.name, h.value)] }));
      toast(`Added ${h.name} to the request headers`, 'success');
    },
    [update],
  );

  const reveal = useCallback((targetId: string) => {
    const root = rootRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-target-id="${CSS.escape(targetId)}"]`);
    if (!el) {
      toast('That field is inside a collapsed group', 'info');
      return;
    }
    el.scrollIntoView({ block: 'nearest' });
    el.querySelector<HTMLElement>('input:not([type="checkbox"]), textarea, select')?.focus();
  }, []);

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (isSendShortcut(e)) {
      e.preventDefault();
      send();
    }
  };

  const wireHeaders = entry.wire?.requestHeaders;
  const enabledHeaders = draft.headers.filter((r) => r.enabled).length;

  return (
    <div class="rl-ed" ref={rootRef} onKeyDown={onKeyDown}>
      <RequestLine
        method={draft.method}
        base={draft.base}
        hash={draft.hash}
        fullUrl={fullUrl}
        update={update}
        entryUrl={entry.url}
        methodModified={sections.method}
        urlModified={sections.url}
        queryModified={sections.query}
        urlError={urlIssue?.message}
        onRevertMethod={onRevertMethod}
        onRevertUrl={onRevertUrl}
      />
      <div class="rl-ed__scroll rl-scroll">
        <Section
          id="query"
          title="Params"
          count={draft.query.length || 'none'}
          empty={draft.query.length === 0}
          modified={sections.query}
          onRevert={() => revert('query')}
          issues={index.bySection.get('query')}
        >
          <KVTable
            kind="query"
            rows={draft.query}
            original={draft.original.query}
            onRows={onQueryRows}
            onRevertRow={onRevertQueryRow}
            warnings={index.byTarget}
          />
        </Section>
        <Section
          id="headers"
          title="Headers"
          count={draft.headers.length ? `${enabledHeaders}/${draft.headers.length}` : undefined}
          modified={sections.headers}
          onRevert={() => revert('headers')}
          issues={index.bySection.get('headers')}
        >
          <KVTable
            kind="headers"
            rows={draft.headers}
            original={draft.original.headers}
            onRows={onHeaderRows}
            onRevertRow={onRevertHeaderRow}
            mode={resolved.mode}
            warnings={index.byTarget}
          />
          {wireHeaders && wireHeaders.length > 0 && <BrowserHeaders headers={wireHeaders} onUse={addWireHeader} />}
        </Section>
        <Section
          id="body"
          title="Body"
          count={bodySummary(draft.body) || undefined}
          // Raw text that does not parse is an edit too (the model keeps the previous body): it can be reverted.
          modified={sections.body || !!rawError}
          onRevert={() => revert('body')}
          issues={rawError ? { errors: 1, warns: 0 } : index.bySection.get('body')}
          actions={
            <BodyToolbar
              body={draft.body}
              view={record.bodyView}
              rawError={!!rawError}
              onType={onBodyType}
              onView={onBodyView}
            />
          }
        >
          <BodyEditor
            entryId={entryId}
            body={draft.body}
            originalBody={draft.original.body}
            view={record.bodyView}
            raw={record.raw}
            update={update}
          />
        </Section>
      </div>
      <SendBar
        entryId={entryId}
        resolved={resolved}
        defaultTimeoutMs={settings.replayTimeoutMs}
        warnings={warnings}
        running={running}
        errorCount={errorCount}
        modified={isModifiedCached(draft) || !!rawError}
        onSend={send}
        onCopy={copySnippet}
        onDuplicate={duplicate}
        onRevertAll={onRevertAll}
        onReveal={reveal}
      />
    </div>
  );
}

interface BrowserHeadersProps {
  headers: HeaderPair[];
  onUse(header: HeaderPair): void;
}

/** Read-only list of the headers the browser actually sent (from webRequest). */
function BrowserHeaders({ headers, onUse }: BrowserHeadersProps) {
  const [open, setOpen] = usePersistentToggle('wire-headers', false);
  return (
    <div class="rl-ed-wire">
      <button type="button" class="rl-ed-wire__toggle" aria-expanded={open} onClick={() => setOpen()}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        <Icon name="lock" size={11} />
        <span>Headers sent by the browser</span>
        <span class="rl-faint">({headers.length})</span>
      </button>
      {open && (
        <div class="rl-ed-wire__list" data-testid="rl-wire-headers" role="table" aria-label="Headers sent by the browser">
          {headers.map((h, i) => (
            <div key={`${h.name}:${i}`} class="rl-ed-wire__row" role="row">
              <span class="rl-mono rl-ed-wire__name" role="cell">
                {h.name}
              </span>
              <span class="rl-mono rl-ed-wire__value" role="cell" title={h.value}>
                {h.value}
              </span>
              <button
                type="button"
                class="rl-icon-btn rl-icon-btn--sm"
                title={`Add ${h.name} to the editable request headers`}
                aria-label={`Use ${h.name}`}
                onClick={() => onUse(h)}
              >
                <Icon name="plus" size={12} />
              </button>
            </div>
          ))}
          <div class="rl-faint rl-ed-wire__note">
            Read-only: what the network stack sent, including cookies and browser-controlled headers.
          </div>
        </div>
      )}
    </div>
  );
}
