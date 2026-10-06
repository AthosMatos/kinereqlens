// OWNER: ui-response agent. Response body viewer: Pretty (JSON tree) / Raw / Preview, progressive rendering.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ResponseData } from '../../shared/types';
import { utf8ByteLength, utf8Encode } from '../../lib/encoding';
import { formatBytes } from '../../lib/format';
import { tryParseJsonTree } from '../../lib/json-tree';
import { Icon } from '../components/Icon';
import {
  availableModes,
  bodyCopyText,
  buildPreviewDocument,
  countLines,
  effectiveMode,
  hexDump,
  plural,
  resolveBody,
  sliceText,
} from './body-model';
import type { BodyMode, ResolvedBody } from './body-model';
import { JsonViewer } from './JsonViewer';
import { CopyButton, Notice, Segmented, ShowMore, TEXT_PAGE_CHARS, usePageLimit } from './parts';

export interface BodyViewProps {
  response: ResponseData;
  /** Emit the response test ids (rl-result-body, rl-body-pretty/raw/preview). Default true. */
  testIds?: boolean;
  /** Find in page for the JSON tree (docs/ARCHITECTURE.md §13). */
  findInPage?: boolean;
  /** Reveal key of the JSON tree (src/ui/find/reveal.ts). */
  revealKey?: string;
}

/** Largest image (bytes) retried as a data: URL when the page's CSP blocks blob: images. */
const DATA_URL_FALLBACK_MAX = 8 * 1024 * 1024;
/** Hex dump bytes per "Show more" step. */
const HEX_PAGE_BYTES = 4096;

const MODE_LABELS: Record<BodyMode, string> = { pretty: 'Pretty', raw: 'Raw', preview: 'Preview' };

/** Body tab of the response view. */
export function BodyView({ response, testIds = true, findInPage = false, revealKey }: BodyViewProps) {
  const tid = (id: string) => (testIds ? id : undefined);
  const resolved = useMemo(
    () => (response.body ? resolveBody(response.body, response.headers) : null),
    [response.body, response.headers],
  );
  const tree = useMemo(
    () => (resolved?.kind === 'text' && resolved.jsonCandidate && !resolved.truncated ? tryParseJsonTree(resolved.text) : null),
    [resolved],
  );
  const [picked, setPicked] = useState<BodyMode | null>(null);
  const [wrap, setWrap] = useState(true);

  if (response.state === 'running' || (response.state === 'pending' && !resolved)) {
    return (
      <div class="rl-empty rl-resp-body__empty" data-testid={tid('rl-result-body')}>
        <span class="rl-spinner" aria-hidden="true" />
        <span>{response.bodyNote ?? 'Waiting for the response…'}</span>
      </div>
    );
  }
  if (!resolved || resolved.kind === 'unavailable' || resolved.kind === 'empty') {
    const text =
      resolved?.kind === 'unavailable'
        ? `Response body unavailable — ${resolved.reason}`
        : resolved?.kind === 'empty'
          ? 'Empty body (0 bytes).'
          : (response.bodyNote ?? 'No response body.');
    return (
      <div class="rl-empty rl-resp-body__empty" data-testid={tid('rl-result-body')} data-empty="true">
        {text}
      </div>
    );
  }

  const modes = availableModes(resolved);
  const mode = effectiveMode(picked, resolved, tree !== null);
  const showsRawText = resolved.kind === 'text' && (mode === 'raw' || (mode === 'pretty' && !tree));

  return (
    <div class="rl-resp-body">
      <div class="rl-resp-body__toolbar">
        <Segmented<BodyMode>
          label="Body view"
          value={mode}
          onChange={setPicked}
          options={(['pretty', 'raw', 'preview'] as const).map((id) => ({
            id,
            label: MODE_LABELS[id],
            disabled: !modes[id],
            testId: tid(`rl-body-${id}`),
            title: modeTitle(id, resolved, tree !== null),
          }))}
        />
        <BodyMeta body={resolved} showLines={showsRawText} />
        <span class="rl-spacer" />
        {showsRawText && (
          <button type="button" class="rl-chip" aria-pressed={wrap} title="Wrap long lines" onClick={() => setWrap((w) => !w)}>
            Wrap
          </button>
        )}
        <CopyButton text={() => bodyCopyText(resolved)} label="Copy" done="Copied body" title={resolved.kind === 'binary' ? 'Copy body (base64)' : 'Copy body'} />
      </div>
      {(resolved.kind === 'text' || resolved.kind === 'binary') && resolved.truncated && <TruncatedNotice body={resolved} />}
      {mode === 'pretty' && resolved.kind === 'text' && !tree && resolved.jsonCandidate && !resolved.truncated && (
        <Notice tone="info">Not valid JSON — showing the raw text.</Notice>
      )}
      <div class="rl-resp-body__content rl-scroll" data-testid={tid('rl-result-body')} data-mode={mode}>
        <BodyContent body={resolved} mode={mode} tree={tree} wrap={wrap} findInPage={findInPage} revealKey={revealKey} />
      </div>
    </div>
  );
}

function modeTitle(mode: BodyMode, body: ResolvedBody, hasTree: boolean): string {
  if (mode === 'pretty') return hasTree ? 'Collapsible JSON tree' : body.kind === 'text' ? 'Pretty view is available for JSON; shows raw text' : 'Not available for binary bodies';
  if (mode === 'raw') return body.kind === 'binary' ? 'Hex dump' : 'Raw text';
  const preview = body.kind === 'text' || body.kind === 'binary' ? body.preview : null;
  if (preview === 'html') return 'Rendered HTML (sandboxed: no scripts, no network)';
  if (preview === 'image') return 'Image preview';
  return 'Preview is available for HTML and images';
}

function BodyMeta({ body, showLines }: { body: ResolvedBody; showLines: boolean }) {
  const lines = useMemo(() => (body.kind === 'text' && showLines ? countLines(body.text) : null), [body, showLines]);
  if (body.kind !== 'text' && body.kind !== 'binary') return null;
  const parts = [body.mime || (body.kind === 'binary' ? 'binary' : 'text'), formatBytes(body.size)];
  if (lines !== null) parts.push(plural(lines, 'line'));
  return <span class="rl-resp-body__meta rl-muted">{parts.join(' · ')}</span>;
}

function TruncatedNotice({ body }: { body: Extract<ResolvedBody, { kind: 'text' | 'binary' }> }) {
  const shown = body.kind === 'text' ? utf8ByteLength(body.text) : (body.bytes?.length ?? 0);
  return (
    <Notice tone="warn">
      Body truncated at capture — showing the first {formatBytes(shown)} of {formatBytes(body.size)}. Raise the body cap in
      Settings to capture more.
    </Notice>
  );
}

interface BodyContentProps {
  body: ResolvedBody;
  mode: BodyMode;
  tree: ReturnType<typeof tryParseJsonTree>;
  wrap: boolean;
  findInPage: boolean;
  revealKey?: string;
}

function BodyContent({ body, mode, tree, wrap, findInPage, revealKey }: BodyContentProps) {
  if (body.kind === 'text') {
    if (mode === 'pretty' && tree) return <JsonViewer root={tree} findInPage={findInPage} revealKey={revealKey} />;
    if (mode === 'preview' && body.preview === 'html') return <HtmlPreview html={body.text} />;
    if (mode === 'preview' && body.preview === 'image') return <TextImagePreview text={body.text} mime={body.mime} />;
    return <RawText text={body.text} wrap={wrap} />;
  }
  if (body.kind === 'binary') {
    if (mode === 'preview' && body.preview === 'image' && body.bytes) {
      return <ImagePreview bytes={body.bytes} mime={body.mime} base64={body.base64} />;
    }
    return <BinarySummary body={body} />;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Raw text
// ---------------------------------------------------------------------------------------------

export interface RawTextProps {
  text: string;
  wrap: boolean;
  /** Characters per "Show more" step. */
  pageSize?: number;
  class?: string;
}

/** Monospace text rendered progressively (~200 kB at a time). */
export function RawText({ text, wrap, pageSize = TEXT_PAGE_CHARS, class: cls }: RawTextProps) {
  const [limit, setLimit] = usePageLimit(text, pageSize);
  const slice = useMemo(() => sliceText(text, limit), [text, limit]);
  const remaining = text.length - slice.end;
  return (
    <div class={`rl-resp-raw${cls ? ` ${cls}` : ''}`}>
      <pre class={`rl-resp-raw__pre rl-mono${wrap ? ' rl-resp-raw__pre--wrap' : ''}`}>{slice.text}</pre>
      {remaining > 0 && (
        <ShowMore
          status={`Showing ${slice.end.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters`}
          onMore={() => setLimit(slice.end + pageSize)}
          onAll={() => setLimit(text.length)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Binary
// ---------------------------------------------------------------------------------------------

function BinarySummary({ body }: { body: Extract<ResolvedBody, { kind: 'binary' }> }) {
  const bytes = body.bytes;
  const [limit, setLimit] = usePageLimit(bytes, 512);
  const lines = useMemo(() => (bytes ? hexDump(bytes, limit) : []), [bytes, limit]);
  return (
    <div class="rl-resp-binary">
      <div class="rl-resp-binary__summary">
        <Icon name="code" size={14} />
        <span>
          Binary body · <span class="rl-mono">{body.mime || 'unknown type'}</span> · {formatBytes(body.size)}
          {body.size !== bytes?.length && bytes ? ` (${formatBytes(bytes.length)} captured)` : ''}
        </span>
      </div>
      {bytes ? (
        <>
          <pre class="rl-resp-raw__pre rl-resp-binary__hex rl-mono" aria-label="Hex dump">
            {lines.join('\n')}
          </pre>
          {bytes.length > limit && (
            <ShowMore
              status={`Showing the first ${formatBytes(limit)} of ${formatBytes(bytes.length)}`}
              onMore={() => setLimit(limit + HEX_PAGE_BYTES)}
            />
          )}
        </>
      ) : (
        <div class="rl-muted">The captured base64 data is malformed and can't be decoded.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------------------------

/**
 * HTML preview in an `<iframe sandbox="" srcdoc>`: no scripts, forms, popups, plugins or same-origin
 * access, plus a CSP <meta> that blocks every network load. The iframe is created imperatively so the
 * sandbox attribute is guaranteed to be in place before `srcdoc` is assigned.
 */
function HtmlPreview({ html }: { html: string }) {
  const host = useRef<HTMLDivElement>(null);
  const doc = useMemo(() => buildPreviewDocument(html), [html]);
  const [failed, setFailed] = useState<string | null>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const frame = el.ownerDocument.createElement('iframe');
    frame.setAttribute('sandbox', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('loading', 'eager');
    frame.title = 'Response preview (sandboxed)';
    frame.className = 'rl-resp-preview__frame';
    try {
      // The sandbox attribute is set above, before any content is assigned.
      frame.srcdoc = doc;
    } catch (err) {
      // E.g. a Trusted Types policy of the host page rejecting the srcdoc sink.
      setFailed(err instanceof Error ? err.message : String(err));
      return;
    }
    setFailed(null);
    el.replaceChildren(frame);
    return () => frame.remove();
  }, [doc]);
  return (
    <div class="rl-resp-preview">
      <div class="rl-resp-preview__note rl-faint">Sandboxed preview — scripts, forms, links and network requests are disabled.</div>
      {failed && (
        <Notice tone="warn">
          This page doesn't allow the preview to be rendered ({failed}). Use the Raw view instead.
        </Notice>
      )}
      <div class="rl-resp-preview__host" ref={host} data-testid="rl-preview-host" />
    </div>
  );
}

type ImageStage = 'blob' | 'data' | 'failed';

interface ImagePreviewProps {
  bytes: Uint8Array;
  mime: string;
  /** Used for the data: URL fallback (base64 bodies). */
  base64?: string;
  /** Used for the data: URL fallback (SVG text bodies). */
  text?: string;
}

/** Image via a Blob URL (revoked on change/unmount), falling back to a data: URL if the page CSP blocks blob:. */
function ImagePreview({ bytes, mime, base64, text }: ImagePreviewProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [stage, setStage] = useState<ImageStage>('blob');
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    // Copy into a fresh ArrayBuffer-backed view (Blob parts must not be SharedArrayBuffer views).
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime || 'application/octet-stream' }));
    setBlobUrl(url);
    setStage('blob');
    setNatural(null);
    return () => URL.revokeObjectURL(url);
  }, [bytes, mime]);

  const dataUrl = useMemo(() => {
    if (bytes.length > DATA_URL_FALLBACK_MAX) return null;
    if (base64 !== undefined) return `data:${mime};base64,${base64.replace(/\s+/g, '')}`;
    if (text !== undefined) return `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
    return null;
  }, [bytes, mime, base64, text]);

  const src = stage === 'blob' ? blobUrl : stage === 'data' ? dataUrl : null;
  const onError = () => setStage((s) => (s === 'blob' && dataUrl ? 'data' : 'failed'));

  return (
    <div class="rl-resp-image">
      {stage === 'failed' || !src ? (
        <div class="rl-empty">
          {stage === 'failed' ? "The image couldn't be displayed (unsupported format, truncated data, or blocked by the page's Content-Security-Policy)." : 'Loading preview…'}
        </div>
      ) : (
        <div class="rl-resp-image__frame">
          <img
            class="rl-resp-image__img"
            src={src}
            alt="Response image preview"
            referrerpolicy="no-referrer"
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={onError}
          />
        </div>
      )}
      <div class="rl-resp-image__meta rl-muted">
        <span class="rl-mono">{mime}</span> · {formatBytes(bytes.length)}
        {natural && ` · ${natural.w} × ${natural.h} px`}
      </div>
    </div>
  );
}

function TextImagePreview({ text, mime }: { text: string; mime: string }) {
  const bytes = useMemo(() => utf8Encode(text), [text]);
  return <ImagePreview bytes={bytes} mime={mime} text={text} />;
}
