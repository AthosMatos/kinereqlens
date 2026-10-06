// OWNER: ui-editor agent. Request line: method select (+ custom), URL base input, computed full-URL preview.
import type { JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { KVRow } from '../../shared/types';
import { applyTypedUrl } from '../../lib/draft';
import { methodClass } from '../../lib/format';
import { isAbsoluteUrl, joinUrl, resolveUrl } from '../../lib/url';
import { copyText } from '../components/clipboard';
import { Icon } from '../components/Icon';
import type { DraftUpdater } from './draftStore';
import { cx, isPlainEnter, memo, safely } from './util';

const STANDARD_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const CUSTOM = '__custom__';
/** RFC 9110 token characters. */
const NON_TOKEN = /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/g;

export interface RequestLineProps {
  method: string;
  base: string;
  /** Hash without '#' (shown in the URL field). */
  hash: string;
  /** draftUrl(draft): what would be sent. */
  fullUrl: string;
  update: DraftUpdater;
  /** URL of the captured request; relative bases are resolved against it on blur. */
  entryUrl: string;
  methodModified: boolean;
  urlModified: boolean;
  /** The Params section is modified (a URL typed / pasted with a query may have changed it). */
  queryModified: boolean;
  urlError?: string;
  onRevertMethod(): void;
  /** `withQuery`: the params were last changed through the URL field; revert them too. */
  onRevertUrl(withQuery: boolean): void;
}

export const RequestLine = memo(function RequestLine(props: RequestLineProps) {
  return (
    <div class="rl-ed-line">
      <div class="rl-ed-line__main">
        <MethodSelect
          method={props.method}
          update={props.update}
          modified={props.methodModified}
          onRevert={props.onRevertMethod}
        />
        <UrlInput
          base={props.base}
          hash={props.hash}
          update={props.update}
          entryUrl={props.entryUrl}
          error={props.urlError}
          modified={props.urlModified}
          queryModified={props.queryModified}
          onRevert={props.onRevertUrl}
        />
      </div>
      <div class="rl-ed-line__preview">
        <UrlPreview url={props.fullUrl} />
        <button
          type="button"
          class="rl-icon-btn rl-icon-btn--sm"
          data-testid="rl-url-copy"
          title="Copy the URL that will be sent"
          aria-label="Copy URL"
          onClick={() => void copyText(props.fullUrl, 'URL copied')}
        >
          <Icon name="copy" size={12} />
        </button>
      </div>
      {props.urlError && (
        <div class="rl-error rl-ed-line__error" role="alert">
          <Icon name="warning" size={12} />
          <span>{props.urlError}</span>
        </div>
      )}
    </div>
  );
});

interface MethodSelectProps {
  method: string;
  update: DraftUpdater;
  modified: boolean;
  onRevert(): void;
}

function MethodSelect({ method, update, modified, onRevert }: MethodSelectProps) {
  const [custom, setCustom] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const before = useRef(method);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!custom || !el) return;
    el.focus();
    el.select();
  }, [custom]);

  const setMethod = (m: string) => update((d) => (d.method === m ? d : { ...d, method: m }));

  const finishCustom = () => {
    setCustom(false);
    if (!method.trim()) setMethod(before.current || 'GET');
  };

  const color = `rl-ed-method--${safely(() => methodClass(method), 'other')}`;

  return (
    <span class="rl-ed-method-wrap">
      {custom ? (
        <input
          ref={inputRef}
          type="text"
          class={cx('rl-input rl-input--mono rl-ed-method rl-ed-method--custom', color)}
          data-testid="rl-method-custom"
          aria-label="Custom method"
          placeholder="METHOD"
          spellcheck={false}
          autocomplete="off"
          value={method}
          onInput={(e) => {
            const el = e.currentTarget;
            const clean = el.value.replace(NON_TOKEN, '');
            if (clean !== el.value) el.value = clean;
            setMethod(clean);
          }}
          onBlur={finishCustom}
          onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
            if (isPlainEnter(e) || e.key === 'Escape') {
              e.preventDefault();
              if (e.key === 'Escape') setMethod(before.current);
              finishCustom();
            }
          }}
        />
      ) : (
        <select
          class={cx('rl-select rl-ed-method', color)}
          data-testid="rl-method-select"
          aria-label="Method"
          value={method}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v === CUSTOM) {
              before.current = method;
              e.currentTarget.value = method;
              setCustom(true);
            } else setMethod(v);
          }}
        >
          {STANDARD_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          {!STANDARD_METHODS.includes(method) && method && <option value={method}>{method}</option>}
          <option value={CUSTOM}>Custom…</option>
        </select>
      )}
      {modified && (
        <button
          type="button"
          class="rl-ed-line__mark"
          data-testid="rl-method-revert"
          title="Method modified — click to revert"
          aria-label="Revert method"
          onClick={onRevert}
        >
          <span class="rl-modified-dot" />
        </button>
      )}
    </span>
  );
}

interface UrlInputProps {
  base: string;
  hash: string;
  update: DraftUpdater;
  entryUrl: string;
  error?: string;
  modified: boolean;
  queryModified: boolean;
  /** `withQuery`: the params were last changed through the URL field; restore them too. */
  onRevert(withQuery: boolean): void;
}

/**
 * URL input: shows the base and the hash (`base#hash`); the query lives in the Params table.
 *  - Typing edits base / hash; a "#…" never touches the params.
 *  - Typing "?k=v" after the base adds those params to the table (the text stays in the field while typing
 *    and moves to the table on blur / Enter); the existing params are kept.
 *  - Replacing the whole field (select all, then paste or type a full URL with a query string) replaces
 *    base, params and hash: the Params table is re-parsed.
 *  "Revert URL" also restores params changed through the field.
 */
function UrlInput({ base, hash, update, entryUrl, error, modified, queryModified, onRevert }: UrlInputProps) {
  const [fullText, setFullText] = useState<string | null>(null);
  /** Params when "?" was first typed in this edit (typed params are appended to them). */
  const startQuery = useRef<KVRow[] | null>(null);
  /** This edit replaced the whole field (select all + type / paste): a query in it replaces the params. */
  const replacing = useRef(false);
  /** The params were last changed through this field (typed "?…"): Revert URL restores them too. */
  const [queryFromUrl, setQueryFromUrl] = useState(false);
  const showRevert = modified || (queryFromUrl && queryModified);

  const onBeforeInput = (e: JSX.TargetedInputEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    if (el.value.length === 0 || (el.selectionStart === 0 && el.selectionEnd === el.value.length)) replacing.current = true;
  };

  const onInput = (value: string) => {
    const typesQuery = /^[^#]*\?/.test(value);
    // The field shows the text as typed until blur / Enter (a lone "#" or "?" has no model of its own).
    setFullText(value);
    if (typesQuery && !queryFromUrl) setQueryFromUrl(true);
    update((d) => {
      if (typesQuery && startQuery.current === null) startQuery.current = d.query;
      return safely(() => applyTypedUrl(d, value, startQuery.current, replacing.current), d);
    });
  };

  const commit = () => {
    setFullText(null);
    startQuery.current = null;
    replacing.current = false;
    update((d) => {
      const trimmed = d.base.trim();
      let next = trimmed;
      if (trimmed && !safely(() => isAbsoluteUrl(trimmed), true) && entryUrl) {
        next = safely(() => resolveUrl(trimmed, entryUrl), trimmed);
      }
      return next === d.base ? d : { ...d, base: next };
    });
  };

  return (
    <span class="rl-ed-url-wrap">
      <input
        type="text"
        class={cx('rl-input rl-input--mono rl-ed-url', error && 'rl-input--invalid')}
        data-testid="rl-url-input"
        aria-label="URL"
        aria-invalid={!!error || undefined}
        placeholder="https://example.com/path"
        spellcheck={false}
        autocomplete="off"
        title={error ?? 'URL without the query string (edit params below; type ?name=value to add params)'}
        value={fullText ?? joinUrl(base, '', hash)}
        onBeforeInput={onBeforeInput}
        onInput={(e) => onInput(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
          if (isPlainEnter(e)) {
            e.preventDefault();
            commit();
          }
        }}
      />
      {showRevert && (
        <button
          type="button"
          class="rl-icon-btn rl-icon-btn--sm rl-ed-url__revert"
          data-testid="rl-url-revert"
          title="Revert URL to the captured one"
          aria-label="Revert URL"
          onClick={() => {
            onRevert(queryFromUrl);
            setQueryFromUrl(false);
          }}
        >
          <Icon name="revert" size={12} />
        </button>
      )}
    </span>
  );
}

/** Full URL with the query highlighted; the text content is exactly `url`. */
function UrlPreview({ url }: { url: string }) {
  const hashAt = url.indexOf('#');
  const qAt = url.indexOf('?');
  const queryAt = qAt >= 0 && (hashAt < 0 || qAt < hashAt) ? qAt : -1;
  const baseEnd = queryAt >= 0 ? queryAt : hashAt >= 0 ? hashAt : url.length;
  const queryEnd = hashAt >= 0 ? hashAt : url.length;
  const query = queryAt >= 0 ? url.slice(queryAt + 1, queryEnd) : null;
  return (
    <div class="rl-ed-preview rl-mono" data-testid="rl-url-preview" title={url}>
      <span class="rl-ed-preview__base">{url.slice(0, baseEnd)}</span>
      {query !== null && (
        <span class="rl-ed-preview__query">
          ?
          {query.split('&').map((seg, i) => {
            const eq = seg.indexOf('=');
            return (
              <span key={i}>
                {i > 0 && '&'}
                <span class="rl-ed-preview__k">{eq >= 0 ? seg.slice(0, eq) : seg}</span>
                {eq >= 0 && (
                  <>
                    =<span class="rl-ed-preview__v">{seg.slice(eq + 1)}</span>
                  </>
                )}
              </span>
            );
          })}
        </span>
      )}
      {hashAt >= 0 && <span class="rl-ed-preview__hash">{url.slice(hashAt)}</span>}
    </div>
  );
}
