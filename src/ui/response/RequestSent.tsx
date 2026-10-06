// OWNER: ui-response agent. "Request sent" tab: exactly what a test run put on the wire.
import { useMemo } from 'preact/hooks';
import type { ResponseData, TestRun, WireBody } from '../../shared/types';
import { toCurl, toFetchSnippet } from '../../lib/curl';
import { base64ByteLength, utf8ByteLength } from '../../lib/encoding';
import { formatClock, formatDuration, methodClass } from '../../lib/format';
import { BodyView } from './BodyView';
import { HeadersTable } from './HeadersView';
import { CopyButton, Notice } from './parts';
import { isStandaloneShell } from '../shellMode';
import { headerNameIn, modeLabel } from './results-model';

/** Notes about headers that were applied through DNR or could not be sent. */
export function RunNotices({ run }: { run: TestRun }) {
  const applied = run.result?.appliedViaDnr ?? [];
  const dropped = run.result?.droppedHeaders ?? [];
  if (applied.length === 0 && dropped.length === 0) return null;
  return (
    <>
      {applied.length > 0 && (
        <Notice tone="info">
          Browser-controlled headers applied through a temporary declarativeNetRequest rule:{' '}
          <HeaderNames names={applied} />
        </Notice>
      )}
      {dropped.length > 0 && (
        <Notice tone="warn">
          Not sent: <HeaderNames names={dropped} />
          {run.request.mode !== 'page'
            ? ' — these headers cannot be overridden.'
            : isStandaloneShell()
              ? ' — the app could not send these headers.'
              : ' — the browser controls these headers in Page mode. Switch to Extension mode to send them.'}
        </Notice>
      )}
    </>
  );
}

function HeaderNames({ names }: { names: string[] }) {
  return (
    <>
      {names.map((name, i) => (
        <span key={name}>
          {i > 0 && ', '}
          <code class="rl-mono rl-resp-code">{name}</code>
        </span>
      ))}
    </>
  );
}

/** A wire body as a response-shaped object so the body viewer can render it (Pretty JSON, Raw, hex). */
function wireBodyAsResponse(body: WireBody, run: TestRun): ResponseData | null {
  const headers = run.request.headers;
  if (body.kind === 'text') {
    return { state: 'done', headers, body: { kind: 'text', text: body.text, size: utf8ByteLength(body.text) } };
  }
  if (body.kind === 'base64') {
    return { state: 'done', headers, body: { kind: 'base64', base64: body.base64, size: base64ByteLength(body.base64) } };
  }
  return null;
}

/**
 * Test requests bypass the HTTP cache (fetch `cache: 'no-store'`), so the browser adds `Cache-Control:
 * no-cache` and `Pragma: no-cache` unless the request sets them: say so, they are not in the table above.
 */
function CacheHeadersNote({ headers }: { headers: Array<{ name: string; value: string }> }) {
  const has = (name: string) => headers.some((h) => h.name.trim().toLowerCase() === name);
  const added = [has('cache-control') ? null : 'Cache-Control', has('pragma') ? null : 'Pragma'].filter((n): n is string => n !== null);
  if (added.length === 0) return null;
  return (
    <div class="rl-faint rl-resp-sent__note" data-testid="rl-cache-note">
      The browser also sent{' '}
      {added.map((name, i) => (
        <span key={name}>
          {i > 0 && ' and '}
          <code class="rl-mono rl-resp-code">{name}: no-cache</code>
        </span>
      ))}
      : test requests bypass the HTTP cache. Add your own {added.join(' / ')} header to send another value.
    </div>
  );
}

export interface RequestSentProps {
  run: TestRun;
  /** Also render {@link RunNotices} (off when the host already shows them, as the results panel does). */
  showNotices?: boolean;
}

/**
 * Method, URL, options, headers and body of the request a run sent (+ Copy as cURL / fetch / URL).
 * Headers that went through DNR or could not be sent are tagged in the table.
 */
export function RequestSent({ run, showNotices = false }: RequestSentProps) {
  const req = run.request;
  const result = run.result;
  const bodyResponse = useMemo(() => wireBodyAsResponse(req.body, run), [req.body, run]);
  const snippet = { method: req.method, url: req.url, headers: req.headers, body: req.body };

  const tagFor = (h: { name: string; value: string }) => {
    if (headerNameIn(result?.droppedHeaders, h)) return { label: 'not sent', tone: 'warn' as const };
    if (headerNameIn(result?.appliedViaDnr, h)) return { label: 'via DNR', tone: 'info' as const };
    return null;
  };

  return (
    <div class="rl-resp-sent" data-testid="rl-request-sent">
      <div class="rl-resp-sent__line">
        <span class={`rl-badge rl-badge--${methodClass(req.method)}`}>{req.method}</span>
        <span class="rl-mono rl-resp-sent__url">{req.url}</span>
      </div>
      <div class="rl-resp-sent__meta rl-muted">
        <span>{modeLabel(req.mode)} mode</span>
        <span>credentials: {req.credentials}</span>
        <span>redirect: {req.redirect}</span>
        <span>timeout: {formatDuration(req.timeoutMs)}</span>
        <span>sent {formatClock(run.startedAt)}</span>
      </div>
      <div class="rl-resp-sent__actions">
        <CopyButton text={() => toCurl(snippet)} label="Copy as cURL" done="Copied cURL command" testId="rl-copy-curl" />
        <CopyButton text={() => toFetchSnippet(snippet)} label="Copy as fetch" done="Copied fetch snippet" />
        <CopyButton text={req.url} label="Copy URL" done="Copied URL" />
      </div>
      {showNotices && <RunNotices run={run} />}
      <section class="rl-resp-sent__section">
        <h4 class="rl-resp-sent__heading">Headers</h4>
        <HeadersTable headers={req.headers} emptyText="No headers were set explicitly." tagFor={tagFor} />
        <CacheHeadersNote headers={req.headers} />
      </section>
      <section class="rl-resp-sent__section rl-resp-sent__section--body">
        <h4 class="rl-resp-sent__heading">Body</h4>
        {bodyResponse ? (
          <BodyView response={bodyResponse} testIds={false} />
        ) : (
          <div class="rl-muted rl-resp-sent__nobody">No body.</div>
        )}
      </section>
    </div>
  );
}
