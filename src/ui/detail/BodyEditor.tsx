// OWNER: ui-editor agent. Body section: type select + Fields/Raw toggle (toolbar) and the per-type editors.
import type { JSX } from 'preact';
import { useCallback, useMemo, useRef } from 'preact/hooks';
import type { BodyModel, BodyType, JNode, KVRow, MultipartPart } from '../../shared/types';
import { bodyToRawText, bodyTypeLabel } from '../../lib/body';
import { revertJsonNode, revertRowIn, setBody, setBodyType } from '../../lib/draft';
import { base64ToBytes, tryDecodeUtf8 } from '../../lib/encoding';
import { formatBytes } from '../../lib/format';
import { setRowHeader } from '../../lib/headers';
import { Icon } from '../components/Icon';
import { toast } from '../components/toast';
import { originalFormRows, originalParts, originalTree } from './derived';
import { applyRawText, type BodyView, type DraftUpdater, type RawEdit } from './draftStore';
import { AutoTextarea, readFileAsBase64 } from './inputs';
import { JsonEditor } from './JsonEditor';
import { KVTable } from './KVTable';
import { MAX_PICKED_FILE_BYTES, MultipartEditor } from './MultipartEditor';
import { cx, errorMessage, memo, pluralize, safely } from './util';

const BODY_TYPES: Array<{ type: Exclude<BodyType, 'unavailable'>; label: string }> = [
  { type: 'none', label: 'None' },
  { type: 'json', label: 'JSON' },
  { type: 'form', label: 'Form (urlencoded)' },
  { type: 'multipart', label: 'Multipart' },
  { type: 'text', label: 'Text' },
  { type: 'binary', label: 'Binary' },
];

/** Body types that have a structured Fields view and a separate Raw view. */
export function hasRawView(body: BodyModel): boolean {
  return body.type === 'json' || body.type === 'form' || body.type === 'multipart';
}

/** Short summary shown next to the "Body" section title. */
export function bodySummary(body: BodyModel): string {
  switch (body.type) {
    case 'json': {
      const n = body.tree.children?.length ?? 0;
      if (body.flavor === 'graphql-batch') return pluralize(n, 'operation');
      if (body.tree.type === 'object') return pluralize(n, 'key');
      if (body.tree.type === 'array') return pluralize(n, 'item');
      return body.tree.type;
    }
    case 'form':
      return pluralize(body.rows.length, 'field');
    case 'multipart':
      return pluralize(body.parts.length, 'part');
    case 'text':
      return pluralize(body.text.length, 'char');
    case 'binary':
      return safely(() => formatBytes(body.size), `${body.size} B`);
    default:
      return '';
  }
}

// --------------------------------------------------------------------------------------------- toolbar

export interface BodyToolbarProps {
  body: BodyModel;
  view: BodyView;
  /** Raw text has a parse error: the Fields view would show stale data, so switching is disabled. */
  rawError: boolean;
  onType(type: BodyType): void;
  onView(view: BodyView): void;
}

/** Type select + Fields/Raw toggle rendered in the Body section header. */
export function BodyToolbar({ body, view, rawError, onType, onView }: BodyToolbarProps) {
  const label = safely(() => bodyTypeLabel(body), '');
  return (
    <div class="rl-ed-bodybar">
      {label === 'GraphQL' && <span class="rl-pill rl-ed-bodybar__flavor">GraphQL</span>}
      <select
        class="rl-select rl-ed-bodybar__type"
        data-testid="rl-body-type"
        aria-label="Body type"
        value={body.type}
        onChange={(e) => onType(e.currentTarget.value as BodyType)}
      >
        {body.type === 'unavailable' && (
          <option value="unavailable" disabled>
            Unavailable
          </option>
        )}
        {BODY_TYPES.map((t) => (
          <option key={t.type} value={t.type}>
            {t.label}
          </option>
        ))}
      </select>
      {hasRawView(body) && (
        <div class="rl-ed-seg" role="group" aria-label="Body view">
          <button
            type="button"
            class="rl-ed-seg__btn"
            data-testid="rl-body-view-fields"
            aria-pressed={view === 'fields'}
            disabled={rawError && view === 'raw'}
            title={rawError ? 'Fix the raw text parse error first (or revert the body)' : 'Edit field by field'}
            onClick={() => onView('fields')}
          >
            Fields
          </button>
          <button
            type="button"
            class="rl-ed-seg__btn"
            data-testid="rl-body-view-raw"
            aria-pressed={view === 'raw'}
            title="Edit the serialized body"
            onClick={() => onView('raw')}
          >
            Raw
          </button>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- editor

export interface BodyEditorProps {
  entryId: string;
  body: BodyModel;
  originalBody: BodyModel;
  view: BodyView;
  raw: RawEdit | null;
  /** Stable draft updater of the entry. */
  update: DraftUpdater;
}

/** Editor for the current body model (Fields view per type, or the Raw view). */
export const BodyEditor = memo(function BodyEditor(props: BodyEditorProps) {
  const { entryId, body, originalBody, view, raw, update } = props;

  const onTree = useCallback(
    (fn: (tree: JNode) => JNode) =>
      update((d) => {
        if (d.body.type !== 'json') return d;
        const tree = fn(d.body.tree);
        return tree === d.body.tree ? d : setBody(d, { ...d.body, tree });
      }),
    [update],
  );
  const onRevertNode = useCallback((id: string) => update((d) => revertJsonNode(d, id)), [update]);
  const onFormRows = useCallback(
    (fn: (rows: KVRow[]) => KVRow[]) =>
      update((d) => {
        if (d.body.type !== 'form') return d;
        const rows = fn(d.body.rows);
        return rows === d.body.rows ? d : setBody(d, { type: 'form', rows });
      }),
    [update],
  );
  const onRevertFormRow = useCallback((id: string) => update((d) => revertRowIn(d, 'form', id)), [update]);
  const onParts = useCallback(
    (fn: (parts: MultipartPart[]) => MultipartPart[]) =>
      update((d) => {
        if (d.body.type !== 'multipart') return d;
        const parts = fn(d.body.parts);
        return parts === d.body.parts ? d : setBody(d, { ...d.body, parts });
      }),
    [update],
  );
  const onRevertPart = useCallback((id: string) => update((d) => revertRowIn(d, 'multipart', id)), [update]);

  if (view === 'raw' && hasRawView(body)) {
    return <RawBody entryId={entryId} body={body} raw={raw} readOnly={body.type === 'multipart'} />;
  }

  switch (body.type) {
    case 'json':
      return (
        <JsonEditor
          tree={body.tree}
          originalTree={originalTree(originalBody)}
          flavor={body.flavor}
          onTree={onTree}
          onRevertNode={onRevertNode}
        />
      );
    case 'form':
      return (
        <KVTable
          kind="form"
          rows={body.rows}
          original={originalFormRows(originalBody)}
          onRows={onFormRows}
          onRevertRow={onRevertFormRow}
        />
      );
    case 'multipart':
      return (
        <MultipartEditor
          parts={body.parts}
          originalParts={originalParts(originalBody)}
          boundary={body.boundary}
          onParts={onParts}
          onRevertPart={onRevertPart}
        />
      );
    case 'text':
      return <TextBody text={body.text} update={update} />;
    case 'binary':
      return <BinaryBody body={body} update={update} />;
    case 'unavailable':
      return <NoBody reason={body.reason} update={update} />;
    default:
      return <NoBody update={update} />;
  }
});

// --------------------------------------------------------------------------------------------- raw

const rawTextCache = new WeakMap<BodyModel, string>();

function rawTextOf(body: BodyModel): string {
  let text = rawTextCache.get(body);
  if (text === undefined) {
    text = safely(() => bodyToRawText(body), '');
    rawTextCache.set(body, text);
  }
  return text;
}

interface RawBodyProps {
  entryId: string;
  body: BodyModel;
  raw: RawEdit | null;
  readOnly: boolean;
}

/** Raw view: serialized body; valid edits re-sync the model (ids aligned), invalid ones show the error. */
function RawBody({ entryId, body, raw, readOnly }: RawBodyProps) {
  const applies = !!raw && raw.body === body;
  const text = applies ? raw.text : rawTextOf(body);
  const error = applies ? raw.error : null;
  return (
    <div class="rl-ed-raw">
      <AutoTextarea
        value={text}
        onValue={(t) => applyRawText(entryId, t)}
        class="rl-textarea--mono rl-ed-raw__text"
        testId="rl-raw-body"
        ariaLabel="Raw body"
        readOnly={readOnly}
        invalid={!!error}
        minRows={6}
        maxHeight={560}
      />
      {error && (
        <div class="rl-error rl-ed-raw__error" data-testid="rl-raw-error" role="alert">
          <Icon name="warning" size={12} />
          <span>{error}</span>
        </div>
      )}
      {applies && raw.pending && <div class="rl-faint rl-ed-raw__note">Parsing…</div>}
      {readOnly && (
        <div class="rl-faint rl-ed-raw__note">Read-only for multipart bodies — edit the parts in the Fields view.</div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- text / binary / none

function TextBody({ text, update }: { text: string; update: DraftUpdater }) {
  const onValue = useCallback(
    (value: string) => update((d) => (d.body.type === 'text' && d.body.text !== value ? setBody(d, { type: 'text', text: value }) : d)),
    [update],
  );
  return (
    <AutoTextarea
      value={text}
      onValue={onValue}
      class="rl-textarea--mono rl-ed-raw__text"
      testId="rl-raw-body"
      ariaLabel="Text body"
      placeholder="Request body"
      minRows={6}
      maxHeight={560}
    />
  );
}

/** Decoding check is skipped above this size (the button then tries on click). */
const DECODE_CHECK_MAX_BASE64 = 4 * 1024 * 1024;

function decodeText(base64: string): string | null {
  return safely(() => tryDecodeUtf8(base64ToBytes(base64)), null);
}

function BinaryBody({ body, update }: { body: Extract<BodyModel, { type: 'binary' }>; update: DraftUpdater }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const decodable = useMemo(
    () => (body.base64.length <= DECODE_CHECK_MAX_BASE64 ? decodeText(body.base64) !== null : null),
    [body.base64],
  );

  const editAsText = () => {
    const text = decodeText(body.base64);
    if (text === null) {
      toast('The body is not valid UTF-8 text', 'warn');
      return;
    }
    update((d) => setBody(d, { type: 'text', text }));
  };

  const onPick = async (e: JSX.TargetedEvent<HTMLInputElement, Event>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const base64 = await readFileAsBase64(file, MAX_PICKED_FILE_BYTES);
      const mime = file.type || undefined;
      update((d) => {
        const next = setBody(d, { type: 'binary', base64, size: file.size, mime });
        return mime ? { ...next, headers: setRowHeader(next.headers, 'Content-Type', mime) } : next;
      });
      if (mime) toast(`Body replaced — Content-Type set to ${mime}`, 'success');
    } catch (err) {
      toast(`Could not read ${file.name}: ${errorMessage(err)}`, 'error');
    }
  };

  return (
    <div class="rl-ed-binary" data-testid="rl-binary-body">
      <Icon name="code" size={18} />
      <div class="rl-ed-binary__info">
        <div>
          <strong>{safely(() => formatBytes(body.size), `${body.size} B`)}</strong> binary
        </div>
        <div class="rl-mono rl-faint">{body.mime || 'application/octet-stream'}</div>
      </div>
      <span class="rl-spacer" />
      {decodable !== false && (
        <button type="button" class="rl-btn rl-btn--sm" data-testid="rl-binary-as-text" onClick={editAsText}>
          <Icon name="code" size={12} />
          Edit as text
        </button>
      )}
      <button
        type="button"
        class="rl-btn rl-btn--sm"
        data-testid="rl-binary-replace"
        onClick={() => fileInput.current?.click()}
      >
        <Icon name="upload" size={12} />
        Replace with file…
      </button>
      <input ref={fileInput} type="file" hidden data-testid="rl-binary-file" onChange={onPick} />
    </div>
  );
}

const QUICK_TYPES: Array<{ type: BodyType; label: string }> = [
  { type: 'json', label: 'JSON' },
  { type: 'form', label: 'Form' },
  { type: 'multipart', label: 'Multipart' },
  { type: 'text', label: 'Text' },
];

function NoBody({ reason, update }: { reason?: string; update: DraftUpdater }) {
  return (
    <div class={cx('rl-ed-nobody', reason !== undefined && 'rl-ed-nobody--unavailable')}>
      <div class="rl-faint">
        {reason !== undefined ? (
          <>
            The body could not be captured{reason ? ` (${reason})` : ''}. Re-sending as-is sends no body; pick a type to
            compose one.
          </>
        ) : (
          'This request has no body.'
        )}
      </div>
      <div class="rl-row rl-ed-nobody__types">
        {QUICK_TYPES.map((t) => (
          <button
            key={t.type}
            type="button"
            class="rl-btn rl-btn--ghost rl-btn--sm"
            onClick={() => update((d) => setBodyType(d, t.type))}
          >
            <Icon name="plus" size={12} />
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
