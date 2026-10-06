// OWNER: ui-editor agent. multipart/form-data parts editor: text parts and file parts with file pickers.
import type { JSX } from 'preact';
import { useCallback, useMemo, useRef } from 'preact/hooks';
import type { MultipartPart } from '../../shared/types';
import { formatBytes } from '../../lib/format';
import { uid } from '../../lib/ids';
import { Icon } from '../components/Icon';
import { toast } from '../components/toast';
import { partsDiffOf } from './derived';
import { readFileAsBase64, ValueInput } from './inputs';
import { cx, errorMessage, isPlainEnter, memo, safely } from './util';

/** Largest file accepted by the pickers (replays travel through extension messaging as base64). */
export const MAX_PICKED_FILE_BYTES = 25 * 1024 * 1024;

export interface MultipartEditorProps {
  parts: MultipartPart[];
  originalParts: MultipartPart[];
  boundary: string;
  /** Stable: apply an immutable parts edit to the latest draft. */
  onParts(fn: (parts: MultipartPart[]) => MultipartPart[]): void;
  /** Stable: revert / restore one part by id. */
  onRevertPart(id: string): void;
}

interface PartActions {
  patch(id: string, patch: Partial<Omit<MultipartPart, 'id'>>): void;
  remove(id: string): void;
  revert(id: string): void;
}

function patchPart(parts: MultipartPart[], id: string, patch: Partial<Omit<MultipartPart, 'id'>>): MultipartPart[] {
  let changed = false;
  const next = parts.map((p) => {
    if (p.id !== id) return p;
    changed = true;
    const merged: MultipartPart = { ...p, ...patch };
    // `undefined` in a patch removes the field (e.g. the file metadata of a part switched to Text).
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (merged as unknown as Record<string, unknown>)[key];
    return merged;
  });
  return changed ? next : parts;
}

/** Part fields for a picked file. */
async function filePatch(file: File): Promise<Partial<MultipartPart>> {
  const base64 = await readFileAsBase64(file, MAX_PICKED_FILE_BYTES);
  return {
    kind: 'file',
    fileName: file.name,
    mime: file.type || 'application/octet-stream',
    base64,
    size: file.size,
    missingContent: false,
  };
}

export const MultipartEditor = memo(function MultipartEditor(props: MultipartEditorProps) {
  const { parts, originalParts, onParts, onRevertPart } = props;
  const diff = partsDiffOf(originalParts, parts);
  const addFileInput = useRef<HTMLInputElement>(null);

  const actions = useMemo<PartActions>(
    () => ({
      patch: (id, patch) => onParts((ps) => patchPart(ps, id, patch)),
      remove: (id) => onParts((ps) => ps.filter((p) => p.id !== id)),
      revert: (id) => onRevertPart(id),
    }),
    [onParts, onRevertPart],
  );

  const addText = () => {
    const part: MultipartPart = { id: uid('mp'), enabled: true, name: '', kind: 'text', value: '' };
    onParts((ps) => [...ps, part]);
  };

  const onAddFile = async (e: JSX.TargetedEvent<HTMLInputElement, Event>) => {
    const input = e.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = '';
    for (const file of files) {
      try {
        const patch = await filePatch(file);
        const part: MultipartPart = { id: uid('mp'), enabled: true, name: 'file', value: '', kind: 'file', ...patch };
        onParts((ps) => [...ps, part]);
      } catch (err) {
        toast(`Could not read ${file.name}: ${errorMessage(err)}`, 'error');
      }
    }
  };

  return (
    <div class="rl-mp">
      {parts.length === 0 ? (
        <div class="rl-kv-empty rl-faint">No parts.</div>
      ) : (
        <div class="rl-mp-list">
          {parts.map((part) => (
            <PartRow
              key={part.id}
              part={part}
              modified={diff.changed.has(part.id) || diff.added.has(part.id)}
              added={diff.added.has(part.id)}
              actions={actions}
            />
          ))}
        </div>
      )}
      {diff.removed.length > 0 && (
        <div class="rl-kv-removed">
          <span class="rl-faint">Removed:</span>
          {diff.removed.map((p) => (
            <button
              key={p.id}
              type="button"
              class="rl-chip rl-kv-removed__item"
              data-testid="rl-mp-restore"
              title={`Restore ${p.name || '(unnamed)'}`}
              onClick={() => onRevertPart(p.id)}
            >
              <Icon name="revert" size={11} />
              <span class="rl-mono">{p.name || '(unnamed)'}</span>
            </button>
          ))}
        </div>
      )}
      <div class="rl-kv-footer">
        <button type="button" class="rl-btn rl-btn--ghost rl-btn--sm" data-testid="rl-mp-add-text" onClick={addText}>
          <Icon name="plus" size={12} />
          Text part
        </button>
        <button
          type="button"
          class="rl-btn rl-btn--ghost rl-btn--sm"
          data-testid="rl-mp-add-file"
          onClick={() => addFileInput.current?.click()}
        >
          <Icon name="upload" size={12} />
          File part
        </button>
        <input
          ref={addFileInput}
          type="file"
          multiple
          hidden
          data-testid="rl-mp-add-file-input"
          onChange={onAddFile}
        />
        <span class="rl-spacer" />
        <span class="rl-faint rl-mono rl-truncate rl-mp-boundary" title={`boundary=${props.boundary}`}>
          boundary={props.boundary}
        </span>
      </div>
    </div>
  );
});

interface PartRowProps {
  part: MultipartPart;
  modified: boolean;
  added: boolean;
  actions: PartActions;
}

const PartRow = memo(function PartRow({ part, modified, added, actions }: PartRowProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLElement | null>(null);
  const id = part.id;
  const onValue = useCallback((value: string) => actions.patch(id, { value }), [actions, id]);
  const regValue = useCallback((el: HTMLElement | null) => {
    valueRef.current = el;
  }, []);

  const onPick = async (e: JSX.TargetedEvent<HTMLInputElement, Event>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      actions.patch(id, await filePatch(file));
    } catch (err) {
      toast(`Could not read ${file.name}: ${errorMessage(err)}`, 'error');
    }
  };

  /** File data of this part while it is switched to Text (so switching back restores the file). */
  const stashedFile = useRef<Pick<MultipartPart, 'fileName' | 'mime' | 'base64' | 'size' | 'missingContent'> | null>(null);
  const setKind = (kind: MultipartPart['kind']) => {
    if (kind === part.kind) return;
    if (kind === 'text') {
      // A text part carries no file metadata: its value must not go out labelled as the file's type.
      stashedFile.current = {
        fileName: part.fileName,
        mime: part.mime,
        base64: part.base64,
        size: part.size,
        missingContent: part.missingContent,
      };
      actions.patch(id, { kind, value: '', fileName: undefined, mime: undefined, base64: undefined, size: undefined, missingContent: undefined });
      return;
    }
    const file = stashedFile.current;
    stashedFile.current = null;
    actions.patch(
      id,
      file
        ? { kind, value: '', ...file }
        : { kind, value: '', fileName: part.fileName || 'file.bin', mime: part.mime || 'application/octet-stream', base64: '', size: 0 },
    );
  };

  const extra = part.extraHeaders?.length ?? 0;

  return (
    <div
      class={cx('rl-mp-part', !part.enabled && 'rl-kv-row--disabled', modified && 'rl-kv-row--modified')}
      data-testid="rl-mp-part"
      data-name={part.name}
      data-kind={part.kind}
      data-modified={String(modified)}
      data-target-id={id}
    >
      <span class="rl-kv-cell rl-kv-cell--check">
        <input
          type="checkbox"
          class="rl-checkbox"
          data-testid="rl-mp-enabled"
          aria-label={`Send part ${part.name || ''}`}
          checked={part.enabled}
          onChange={(e) => actions.patch(id, { enabled: e.currentTarget.checked })}
        />
      </span>
      <span class="rl-kv-cell rl-kv-cell--key">
        <input
          type="text"
          class="rl-input rl-input--mono rl-kv-input"
          data-testid="rl-mp-name"
          aria-label="Part name"
          placeholder="name"
          spellcheck={false}
          autocomplete="off"
          value={part.name}
          onInput={(e) => actions.patch(id, { name: e.currentTarget.value })}
          onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
            if (isPlainEnter(e)) {
              e.preventDefault();
              valueRef.current?.focus();
            }
          }}
        />
        <select
          class="rl-select rl-mp-kind"
          data-testid="rl-mp-kind"
          aria-label="Part kind"
          value={part.kind}
          onChange={(e) => setKind(e.currentTarget.value as MultipartPart['kind'])}
        >
          <option value="text">Text</option>
          <option value="file">File</option>
        </select>
      </span>
      <span class="rl-kv-cell rl-kv-cell--value">
        {part.kind === 'text' ? (
          <ValueInput
            value={part.value}
            onValue={onValue}
            ariaLabel={`Value of ${part.name || 'part'}`}
            testId="rl-mp-value"
            placeholder="value"
            class="rl-kv-input"
            elRef={regValue}
          />
        ) : (
          <span class="rl-mp-file">
            <input
              ref={regValue}
              type="text"
              class="rl-input rl-input--mono rl-kv-input rl-mp-file__name"
              data-testid="rl-mp-filename"
              aria-label="File name"
              placeholder="file name"
              spellcheck={false}
              value={part.fileName ?? ''}
              onInput={(e) => actions.patch(id, { fileName: e.currentTarget.value })}
            />
            <input
              type="text"
              class="rl-input rl-input--mono rl-kv-input rl-mp-file__mime"
              data-testid="rl-mp-mime"
              aria-label="File content type"
              placeholder="content type"
              spellcheck={false}
              value={part.mime ?? ''}
              onInput={(e) => actions.patch(id, { mime: e.currentTarget.value })}
            />
            <span class="rl-mp-file__size rl-faint" title={`${part.size ?? 0} bytes`}>
              {safely(() => formatBytes(part.size ?? 0), `${part.size ?? 0} B`)}
            </span>
            <button
              type="button"
              class="rl-btn rl-btn--sm"
              data-testid="rl-mp-replace"
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="upload" size={12} />
              Replace file…
            </button>
            <input ref={fileInput} type="file" hidden data-testid="rl-mp-file" onChange={onPick} />
          </span>
        )}
        {part.kind === 'file' && part.missingContent && (
          <span class="rl-mp-note rl-warning" title="The file content was not captured">
            <Icon name="warning" size={11} /> Content not captured — an empty file is sent unless you replace it.
          </span>
        )}
        {extra > 0 && (
          <span
            class="rl-mp-note rl-faint"
            title={part.extraHeaders!.map((h) => `${h.name}: ${h.value}`).join('\n')}
          >
            +{extra} part header{extra === 1 ? '' : 's'}
          </span>
        )}
      </span>
      <span class="rl-kv-cell rl-kv-cell--status">
        {modified && <span class="rl-modified-dot" title={added ? 'Added' : 'Modified'} />}
      </span>
      <span class="rl-kv-cell rl-kv-cell--actions">
        {modified && (
          <button
            type="button"
            class="rl-icon-btn rl-icon-btn--sm"
            data-testid="rl-mp-revert"
            title={added ? 'Remove added part' : 'Revert part'}
            aria-label="Revert part"
            onClick={() => actions.revert(id)}
          >
            <Icon name="revert" size={12} />
          </button>
        )}
        <button
          type="button"
          class="rl-icon-btn rl-icon-btn--sm rl-kv-delete"
          data-testid="rl-mp-delete"
          title="Delete part"
          aria-label="Delete part"
          onClick={() => actions.remove(id)}
        >
          <Icon name="trash" size={12} />
        </button>
      </span>
    </div>
  );
});
