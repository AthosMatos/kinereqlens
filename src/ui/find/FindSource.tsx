// "Where does this come from?" (docs/ARCHITECTURE.md §13): a request-list toolbar button that starts the page-side
// element picker, then searches the captured response bodies and WebSocket messages for the picked element's text and
// lists the matches — request rows (method, path, status, time) with JSON paths and values; a click selects the request,
// opens its Original response and reveals + flashes the JSON node (or opens the WebSocket message).
import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RequestEntry } from '../../shared/types';
import type { FindPickResult } from '../../shared/find-protocol';
import { formatClock, methodClass, statusClass } from '../../lib/format';
import { useOutsideDismiss } from '../components/dismiss';
import { Icon } from '../components/Icon';
import { placePopup } from '../components/position';
import type { PopupPlacement } from '../components/position';
import { useBridge } from '../hooks';
import { requestResultsTab } from '../detail/resultsTab';
import { EndpointLabel } from '../list/EndpointChips';
import { endpointTemplate, layoutLabel } from '../list/endpointLabel';
import { useWsInspector } from '../ws/hooks';
import { wsUrlParts } from '../ws/format';
import { isFindHost } from './controller';
import type { FindHost } from './controller';
import { TargetIcon } from './FindParts';
import { originalRevealKey, requestReveal } from './reveal';
import { searchSources } from './source';
import type { SourceGroup, SourceMatch, SourceResult } from './source';

export interface FindSourceProps {
  /** All entries (oldest first). */
  entries: readonly RequestEntry[];
  /** Select (and show) a request. */
  onSelectEntry(entryId: string): void;
  /** Show a WebSocket message (switches to the WebSocket view); omitted: WebSocket matches are listed only. */
  onShowWsFrame?(wsId: string, frameId: number, path: Array<string | number> | null): void;
}

type State =
  | { phase: 'idle' }
  | { phase: 'picking' }
  | { phase: 'searching'; pick: FindPickResult }
  | { phase: 'done'; pick: FindPickResult; result: SourceResult }
  | { phase: 'error'; error: string };

const MATCHES_SHOWN = 4;
/** Characters of the endpoint label in a result row (the popover is ≤ 440 px wide). */
const LABEL_BUDGET = 34;

function viewportSize(): { width: number; height: number } {
  const el = document.documentElement;
  return { width: el.clientWidth || window.innerWidth, height: el.clientHeight || window.innerHeight };
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

/** The toolbar button (renders nothing without a page connection, e.g. in the standalone tab). */
export function FindSourceButton(props: FindSourceProps) {
  const bridge = useBridge();
  return isFindHost(bridge) ? <FindSourceImpl {...props} host={bridge} /> : null;
}

function FindSourceImpl({ entries, onSelectEntry, onShowWsFrame, host }: FindSourceProps & { host: FindHost }) {
  const inspector = useWsInspector();
  const [state, setState] = useState<State>({ phase: 'idle' });
  const [placement, setPlacement] = useState<PopupPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const run = useRef<{ aborted: boolean }>({ aborted: false });
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const open = state.phase === 'searching' || state.phase === 'done' || state.phase === 'error';

  const close = (refocus: boolean) => {
    run.current.aborted = true;
    setState({ phase: 'idle' });
    setPlacement(null);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };

  useOutsideDismiss(open, [triggerRef, popupRef], () => close(false));

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;
    const rect = trigger.getBoundingClientRect();
    setPlacement(placePopup(rect, { width: popup.offsetWidth, height: popup.scrollHeight }, viewportSize(), 'start'));
  }, [open, state]);

  // Keyboard: the popover takes the focus (the first match once the results are in), so Esc / Tab work right away.
  useEffect(() => {
    const popup = popupRef.current;
    if (!open || !placement || !popup) return;
    const active = (popup.getRootNode() as ShadowRoot | Document).activeElement;
    if (active && popup.contains(active) && active !== popup) return;
    const first = popup.querySelector<HTMLElement>('.rl-find-source__match, [data-testid="rl-find-source-again"]');
    (state.phase === 'done' && first ? first : popup).focus({ preventScroll: true });
  }, [open, placement !== null, state.phase]);

  const pick = async () => {
    run.current.aborted = true;
    const signal = { aborted: false };
    run.current = signal;
    setState({ phase: 'picking' });
    let picked: FindPickResult | null;
    try {
      picked = await host.find('findPick');
    } catch (err) {
      if (!signal.aborted) setState({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (signal.aborted) return;
    if (!picked) {
      setState({ phase: 'idle' });
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    setState({ phase: 'searching', pick: picked });
    try {
      const result = await searchSources(picked.texts, picked.locales, entriesRef.current, inspector, signal);
      if (!signal.aborted) setState({ phase: 'done', pick: picked, result });
    } catch (err) {
      if (!signal.aborted) setState({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  };

  const goEntry = (entryId: string, path: Array<string | number> | null) => {
    close(false);
    requestResultsTab(entryId, 'original');
    if (path) requestReveal(originalRevealKey(entryId), path);
    onSelectEntry(entryId);
  };

  const goWs = (wsId: string, frameId: number, path: Array<string | number> | null) => {
    close(false);
    onShowWsFrame?.(wsId, frameId, path);
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  const picking = state.phase === 'picking';
  return (
    <span class="rl-popup-anchor">
      <button
        ref={triggerRef}
        type="button"
        class={`rl-icon-btn rl-find-source-btn${open || picking ? ' rl-find-source-btn--on' : ''}`}
        title="Where does this come from? Pick an element on the page to find the response it came from"
        aria-label="Where does this come from? Pick an element on the page"
        aria-haspopup="dialog"
        aria-expanded={open ? 'true' : 'false'}
        data-testid="rl-find-source"
        data-state={state.phase}
        onClick={() => (open ? close(false) : void pick())}
        onKeyDown={onKeyDown}
      >
        <TargetIcon size={15} />
      </button>
      {open ? (
        <div
          ref={popupRef}
          class={`rl-popup rl-find-source${placement ? ` rl-popup--${placement.side}` : ''}`}
          role="dialog"
          aria-label="Where does this come from?"
          tabIndex={-1}
          data-testid="rl-find-source-popover"
          data-state={state.phase}
          style={placement ? { left: `${placement.left}px`, top: `${placement.top}px`, maxHeight: `${placement.maxHeight}px` } : { left: '0px', top: '0px', visibility: 'hidden' }}
          onKeyDown={onKeyDown}
        >
          <SourcePanel state={state} entries={entries} onEntry={goEntry} onWs={onShowWsFrame ? goWs : undefined} onAgain={() => void pick()} onClose={() => close(true)} />
        </div>
      ) : null}
    </span>
  );
}

interface SourcePanelProps {
  state: State;
  entries: readonly RequestEntry[];
  onEntry(entryId: string, path: Array<string | number> | null): void;
  onWs?(wsId: string, frameId: number, path: Array<string | number> | null): void;
  onAgain(): void;
  onClose(): void;
}

function SourcePanel({ state, entries, onEntry, onWs, onAgain, onClose }: SourcePanelProps) {
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e] as const)), [entries]);
  const inspector = useWsInspector();
  const pick = state.phase === 'searching' || state.phase === 'done' ? state.pick : null;
  const result = state.phase === 'done' ? state.result : null;
  const groups = (result?.groups ?? []).filter((g) => (g.kind === 'entry' ? byId.has(g.entryId) : true));
  return (
    <>
      <div class="rl-find-source__head">
        <TargetIcon size={14} class="rl-find-source__icon" />
        <span class="rl-find-source__title">Where does this come from?</span>
        <span class="rl-spacer" />
        <button type="button" class="rl-icon-btn rl-icon-btn--sm" title="Close" aria-label="Close" data-testid="rl-find-source-close" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      </div>
      {pick ? (
        <div class="rl-find-source__query" data-testid="rl-find-source-query" title={pick.texts.join('\n')}>
          <span class="rl-find-source__text rl-mono">“{pick.texts[0] ?? ''}”</span>
          <span class="rl-find-source__el">{pick.label}</span>
        </div>
      ) : null}
      {state.phase === 'searching' ? (
        <div class="rl-find-source__status">
          <span class="rl-spinner" aria-hidden="true" />
          Searching the captured responses…
        </div>
      ) : null}
      {state.phase === 'error' ? <div class="rl-find-source__status rl-error">{state.error}</div> : null}
      {result && groups.length === 0 ? (
        <div class="rl-find-source__empty" data-testid="rl-find-source-empty">
          <div class="rl-find-source__empty-title">Not found in the captured responses</div>
          <div class="rl-faint">
            The text may come from the page's own code, a response captured before the overlay was open (reload to capture
            page-load requests), or a format kineReqLens does not recognise.
          </div>
        </div>
      ) : null}
      {groups.length > 0 ? (
        <ul class="rl-find-source__list" aria-label="Matching responses">
          {groups.map((g) =>
            g.kind === 'entry' ? (
              <EntryGroup key={`e:${g.entryId}`} group={g} entry={byId.get(g.entryId)!} onPick={onEntry} />
            ) : (
              <WsGroup key={`w:${g.frameId}`} group={g} url={inspector?.log.getConnection(g.wsId)?.url ?? ''} onPick={onWs} />
            ),
          )}
        </ul>
      ) : null}
      {result || state.phase === 'error' ? (
        <div class="rl-find-source__foot">
          {result ? (
            <span class="rl-faint rl-find-source__searched">
              Searched {plural(result.bodies, 'response')}
              {result.frames ? ` · ${plural(result.frames, 'WebSocket message')}` : ''}
              {result.skipped ? ` · ${result.skipped} over 2 MB skipped` : ''}
            </span>
          ) : null}
          <span class="rl-spacer" />
          <button type="button" class="rl-btn rl-btn--sm" data-testid="rl-find-source-again" onClick={onAgain}>
            <TargetIcon size={12} />
            Pick another element
          </button>
        </div>
      ) : null}
    </>
  );
}

function MatchRows({ matches, total, onPick }: { matches: SourceMatch[]; total: number; onPick(path: Array<string | number> | null): void }) {
  const shown = matches.slice(0, MATCHES_SHOWN);
  return (
    <ul class="rl-find-source__matches">
      {shown.map((m, i) => (
        <li key={i}>
          <button
            type="button"
            class="rl-find-source__match"
            data-testid="rl-find-source-match"
            data-path={m.path ? m.label : ''}
            title={m.path ? `${m.label} = ${m.value} (${m.how})` : m.label}
            onClick={() => onPick(m.path)}
          >
            <span class="rl-find-source__path rl-mono">{m.path ? m.label : 'text'}</span>
            <span class="rl-find-source__value rl-mono">{m.path ? m.value : m.label}</span>
            <span class={`rl-find-source__how rl-find-source__how--${m.score}`}>{m.how}</span>
          </button>
        </li>
      ))}
      {total > shown.length ? <li class="rl-find-source__more rl-faint">+{(total - shown.length).toLocaleString('en-US')} more in this response</li> : null}
    </ul>
  );
}

function EntryGroup({ group, entry, onPick }: { group: Extract<SourceGroup, { kind: 'entry' }>; entry: RequestEntry; onPick(entryId: string, path: Array<string | number> | null): void }) {
  const template = endpointTemplate(entry.url);
  const layout = useMemo(() => layoutLabel(template, LABEL_BUDGET), [template]);
  const first = group.matches[0]?.path ?? null;
  return (
    <li class="rl-find-source__group" data-testid="rl-find-source-group" data-entry-id={entry.id} data-url={entry.url}>
      <button type="button" class="rl-find-source__req" title={entry.url} onClick={() => onPick(entry.id, first)}>
        <span class={`rl-badge rl-badge--${methodClass(entry.method)}`}>{entry.method}</span>
        <span class="rl-find-source__name rl-mono rl-truncate">
          <EndpointLabel template={template} layout={layout} />
        </span>
        <span class={`rl-status rl-status--${statusClass(entry.status, entry.state)}`}>{entry.status ?? '—'}</span>
        <span class="rl-find-source__time rl-faint">{formatClock(entry.startTime)}</span>
      </button>
      <MatchRows matches={group.matches} total={group.total} onPick={(path) => onPick(entry.id, path)} />
    </li>
  );
}

function WsGroup({ group, url, onPick }: { group: Extract<SourceGroup, { kind: 'ws' }>; url: string; onPick?(wsId: string, frameId: number, path: Array<string | number> | null): void }) {
  const parts = wsUrlParts(url);
  const first = group.matches[0]?.path ?? null;
  const go = (path: Array<string | number> | null) => onPick?.(group.wsId, group.frameId, path);
  return (
    <li class="rl-find-source__group" data-testid="rl-find-source-group" data-ws-id={group.wsId} data-frame-id={group.frameId}>
      <button type="button" class="rl-find-source__req" title={url} disabled={!onPick} onClick={() => go(first)}>
        <span class="rl-badge rl-badge--other">WS</span>
        <span class="rl-find-source__name rl-mono rl-truncate">{`${parts.host}${parts.path === '/' ? '' : parts.path}`}</span>
        <span class="rl-find-source__time rl-faint">{formatClock(group.time)}</span>
      </button>
      <MatchRows matches={group.matches} total={group.total} onPick={go} />
    </li>
  );
}
