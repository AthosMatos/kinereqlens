// The results area's "Initiator" tab: which code — and which UI component — made the selected request.
// Shows the component guess (name, component path on the page, "Highlight on page", instance count), the
// source-mapped call stack (app frames emphasized, library / framework frames collapsed), the code around the
// initiating line, "Open in VS Code" links and "Copy stack". Everything is rendered as text.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentLocateResult } from '../../shared/initiator-protocol';
import type { RequestEntry } from '../../shared/types';
import type { AnalyzedFrame, InitiatorAnalysis } from '../../lib/initiator';
import { bundleLocation, functionLabel, groupFrames, locationText, vscodeUrl } from '../../lib/initiator';
import type { CodeExcerpt } from '../../lib/sourcemap';
import { copyText } from '../components/clipboard';
import { Icon } from '../components/Icon';
import { toast } from '../components/toast';
import { useBridge, useSettings } from '../hooks';
import { componentBridgeOf, stackOf, useComponentLocate, useInitiator } from './initiatorState';

export interface InitiatorPanelProps {
  entry: RequestEntry;
}

const HIGHLIGHT_MS = 4_000;

/** The Initiator tab body. */
export function InitiatorPanel({ entry }: InitiatorPanelProps) {
  const state = useInitiator(entry);
  const { analysis } = state;
  if (!analysis) return <NoStack entry={entry} />;
  return (
    <div class="rl-results rl-init" data-testid="rl-initiator" data-state={state.status}>
      <div class="rl-results__content rl-init__body">
        <ComponentCard entry={entry} analysis={analysis} resolving={state.status === 'resolving'} />
        <InitiatorCard analysis={analysis} resolving={state.status === 'resolving'} error={state.error} />
        <StackList entry={entry} analysis={analysis} />
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- empty

function NoStack({ entry }: { entry: RequestEntry }) {
  let why: string;
  if (entry.source === 'manual') why = 'Requests you composed in kineReqLens have no page initiator.';
  else if (entry.source === 'webRequest') {
    why =
      entry.kind === 'fetch' || entry.kind === 'xhr' || entry.kind === 'ping'
        ? 'This request was only seen on the network (a worker, an iframe kineReqLens could not hook, or a request made before the page hook was ready), so no JavaScript call stack exists for it.'
        : 'The browser loaded this resource itself (document, script, style, image…): there is no JavaScript call stack for it.';
  } else if (entry.restored) why = 'This entry was restored from the preserved log without a call stack.';
  else why = 'No call stack was recorded: the request was made before the overlay was opened (or while capture was paused). Reload the page with the overlay open to record it.';
  return (
    <div class="rl-results rl-init" data-testid="rl-initiator" data-state="none">
      <div class="rl-empty rl-init__empty" data-testid="rl-initiator-empty">
        <Icon name="code" size={20} />
        <div>No call stack for this request</div>
        <div class="rl-faint rl-init__why">{why}</div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- component

function ComponentCard({ entry, analysis, resolving }: { entry: RequestEntry; analysis: InitiatorAnalysis; resolving: boolean }) {
  const bridge = useBridge();
  const guess = analysis.component;
  const names = useMemo(() => {
    const list = guess ? [guess.name, ...analysis.componentNames.filter((n) => n !== guess.name)] : analysis.componentNames;
    return list.slice(0, 8);
  }, [guess, analysis.componentNames]);
  const topFrame = entry.frameId === 0;
  const [located, setLocated] = useComponentLocate(bridge, names, !resolving && topFrame);
  const [busy, setBusy] = useState(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cb = componentBridgeOf(bridge);

  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    [],
  );

  if (!guess) {
    return (
      <section class="rl-init__card" data-testid="rl-initiator-component" data-name="">
        <div class="rl-init__card-title">Component</div>
        <div class="rl-faint">
          {resolving
            ? 'Resolving source maps…'
            : analysis.initiatorIndex < 0
              ? 'Only library / framework code is on the call stack: the request was not made from app code that kineReqLens can see.'
              : 'No component name on the call stack (minified code without source maps, or a request made outside a component).'}
        </div>
      </section>
    );
  }

  const match = located.result?.matches.find((m) => m.name === guess.name);
  const other = !match?.count ? located.result?.matches.find((m) => m.count > 0) : undefined;
  const shown = match?.count ? match : other;
  const path = shown?.instances[0]?.path.length ? shown.instances[0].path : [...analysis.componentNames].reverse();
  const frameworks = located.result?.frameworks ?? [];

  const highlight = async () => {
    if (!cb.locateComponents || !shown) return;
    setBusy(true);
    try {
      const result: ComponentLocateResult = await cb.locateComponents({ names: [shown.name], scroll: true, highlight: true });
      if (!result.highlighted) toast(`No visible instance of ${shown.name} on the page`, 'info');
      else {
        // Esc in the overlay also removes the highlight (the page's own Esc is handled by the page side).
        const onKey = (e: KeyboardEvent) => {
          if (e.key === 'Escape') cb.clearHighlight?.();
        };
        document.addEventListener('keydown', onKey, true);
        if (highlightTimer.current) clearTimeout(highlightTimer.current);
        highlightTimer.current = setTimeout(() => document.removeEventListener('keydown', onKey, true), HIGHLIGHT_MS);
      }
    } finally {
      setBusy(false);
    }
  };

  let countText: string;
  if (!topFrame) countText = 'Component lookup works for requests of the top frame only';
  else if (located.status === 'unavailable') countText = 'Component lookup is not available here';
  else if (located.status === 'locating' || located.status === 'idle') countText = 'Looking for it on the page…';
  else if (located.result?.error && !frameworks.length) countText = located.result.error;
  else if (!frameworks.length) countText = 'No React, Preact or Vue tree found on the page';
  else if (match?.count) countText = `${match.count} instance${match.count === 1 ? '' : 's'} on the page`;
  else if (other) countText = `Not mounted now; found ${other.name} (${other.count}) instead`;
  else countText = 'Not mounted on the page right now';

  return (
    <section class="rl-init__card" data-testid="rl-initiator-component" data-name={guess.name}>
      <div class="rl-init__card-title">
        Component
        {frameworks.length > 0 && <span class="rl-pill rl-init__fw">{frameworks.join(' · ')}</span>}
      </div>
      <div class="rl-init__component">
        <span class="rl-init__component-name rl-mono">{`<${guess.name}>`}</span>
        {guess.hook && <span class="rl-faint rl-mono" title="Hook between the component and the request">{`via ${guess.hook}()`}</span>}
      </div>
      {path.length > 0 && (
        <div class="rl-init__path rl-mono" data-testid="rl-initiator-path" title="Component path on the page">
          {path.map((p, i) => (
            <span key={`${i}:${p}`}>
              {i > 0 && <span class="rl-init__sep"> › </span>}
              <span class={p === (shown?.name ?? guess.name) ? 'rl-init__path-self' : undefined}>{p}</span>
            </span>
          ))}
        </div>
      )}
      <div class="rl-row rl-init__actions">
        <button
          type="button"
          class="rl-btn rl-btn--sm"
          data-testid="rl-initiator-highlight"
          disabled={busy || !shown || !cb.locateComponents || !topFrame}
          title="Scroll to the component and outline it on the page for a few seconds (Esc removes it)"
          onClick={() => void highlight()}
        >
          <Icon name="eye" size={12} />
          Highlight on page
        </button>
        <span class="rl-faint" data-testid="rl-initiator-count" data-count={match?.count ?? 0}>
          {countText}
        </span>
      </div>
    </section>
  );
}

// --------------------------------------------------------------------------------------------- initiator

function InitiatorCard({ analysis, resolving, error }: { analysis: InitiatorAnalysis; resolving: boolean; error?: string }) {
  const settings = useSettings();
  const index = analysis.initiatorIndex;
  const f = index >= 0 ? analysis.frames[index] : undefined;
  return (
    <section class="rl-init__card" data-testid="rl-initiator-frame-card">
      <div class="rl-init__card-title">
        Initiator
        {resolving && <span class="rl-spinner" aria-label="Resolving source maps" />}
      </div>
      {!f ? (
        <div class="rl-faint">No app code on the call stack.</div>
      ) : (
        <>
          <div class="rl-init__fn rl-mono">{functionLabel(f)}</div>
          <FrameLocation f={f} editorRoot={settings.editorRoot} primary />
          {f.excerpt && <Excerpt excerpt={f.excerpt} />}
        </>
      )}
      {analysis.minifiedWithoutMaps && !resolving && (
        <div class="rl-warning rl-init__note" data-testid="rl-initiator-nomaps">
          This code is minified and has no source map. Enable source maps in your dev build (webpack <span class="rl-mono">devtool: 'source-map'</span>,
          Vite <span class="rl-mono">build.sourcemap: true</span>, esbuild <span class="rl-mono">--sourcemap</span>) to see the original files and component names.
        </div>
      )}
      {error && !resolving && <div class="rl-faint rl-init__note">Source maps could not be resolved: {error}</div>}
    </section>
  );
}

function FrameLocation({ f, editorRoot, primary }: { f: AnalyzedFrame; editorRoot: string; primary?: boolean }) {
  const link = f.original ? vscodeUrl(f.original.source, f.original.line, f.original.col, editorRoot) : null;
  return (
    <div class="rl-init__loc">
      <span class={`rl-mono ${f.original ? 'rl-init__orig' : ''}`} data-testid={primary ? 'rl-initiator-location' : undefined} title={f.original?.source ?? f.frame.url}>
        {locationText(f)}
      </span>
      {f.original && (
        <span class="rl-faint rl-mono rl-init__raw" title={f.frame.url}>
          {bundleLocation(f.frame)}
        </span>
      )}
      {link && (
        <a class="rl-init__vscode" href={link} data-testid="rl-initiator-vscode" title={`Open ${f.original?.path ?? ''} in VS Code`}>
          <Icon name="external" size={11} />
          VS Code
        </a>
      )}
    </div>
  );
}

function Excerpt({ excerpt }: { excerpt: CodeExcerpt }) {
  const width = String(excerpt.startLine + excerpt.lines.length - 1).length;
  return (
    <pre class="rl-init__excerpt rl-mono" data-testid="rl-initiator-excerpt">
      {excerpt.lines.map((text, i) => {
        const n = excerpt.startLine + i;
        const focus = n === excerpt.line;
        return (
          <div key={n} class={focus ? 'rl-init__line rl-init__line--focus' : 'rl-init__line'}>
            <span class="rl-init__ln">{String(n).padStart(width, ' ')}</span>
            <span class="rl-init__code">{text || ' '}</span>
          </div>
        );
      })}
    </pre>
  );
}

// --------------------------------------------------------------------------------------------- stack

/** Plain-text stack with original locations (for "Copy stack"). */
export function stackText(analysis: InitiatorAnalysis): string {
  return analysis.frames
    .map((f) => {
      const fn = f.frame.fn ? `${f.frame.async ? 'async ' : ''}${f.frame.fn} ` : f.frame.async ? 'async ' : '';
      if (f.original) return `    at ${fn}(${f.original.path}:${f.original.line}:${f.original.col}) [${f.frame.url}:${f.frame.line}:${f.frame.col}]`;
      return `    ${f.frame.raw}`;
    })
    .join('\n');
}

function StackList({ entry, analysis }: { entry: RequestEntry; analysis: InitiatorAnalysis }) {
  const settings = useSettings();
  const rows = useMemo(() => groupFrames(analysis.frames), [analysis]);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (first: number) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(first)) next.delete(first);
      else next.add(first);
      return next;
    });
  return (
    <section class="rl-init__card rl-init__stack" data-testid="rl-initiator-stack">
      <div class="rl-init__card-title">
        Call stack
        <span class="rl-faint">{analysis.frames.length} frames</span>
        <span class="rl-spacer" />
        <button
          type="button"
          class="rl-btn rl-btn--sm rl-btn--ghost"
          data-testid="rl-initiator-copy"
          title="Copy the call stack (with original locations)"
          onClick={() => void copyText(analysis.sourceMapped ? stackText(analysis) : stackOf(entry), 'Stack copied')}
        >
          <Icon name="copy" size={12} />
          Copy stack
        </button>
      </div>
      <ol class="rl-init__frames">
        {rows.map((row) => {
          if (row.type === 'frame') {
            const f = analysis.frames[row.index]!;
            return <FrameRow key={row.index} f={f} index={row.index} initiator={row.index === analysis.initiatorIndex} editorRoot={settings.editorRoot} />;
          }
          const first = row.indices[0]!;
          const expanded = open.has(first);
          const label = row.libraries.length ? row.libraries.slice(0, 3).join(', ') + (row.libraries.length > 3 ? '…' : '') : kindLabel(analysis.frames[first]!);
          return (
            <li key={`g${first}`} class="rl-init__group">
              <button
                type="button"
                class="rl-init__group-btn"
                data-testid="rl-initiator-library-group"
                aria-expanded={expanded ? 'true' : 'false'}
                onClick={() => toggle(first)}
              >
                <span class="rl-init__caret">{expanded ? '▾' : '▸'}</span>
                {`${row.indices.length} library frame${row.indices.length === 1 ? '' : 's'}`}
                <span class="rl-faint"> · {label}</span>
              </button>
              {expanded && (
                <ol class="rl-init__frames rl-init__frames--nested">
                  {row.indices.map((i) => (
                    <FrameRow key={i} f={analysis.frames[i]!} index={i} initiator={false} editorRoot={settings.editorRoot} />
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function kindLabel(f: AnalyzedFrame): string {
  switch (f.kind) {
    case 'framework':
      return 'framework';
    case 'extension':
      return 'browser extension';
    case 'native':
      return 'native';
    default:
      return 'library';
  }
}

function FrameRow({ f, index, initiator, editorRoot }: { f: AnalyzedFrame; index: number; initiator: boolean; editorRoot: string }) {
  return (
    <li
      class={`rl-init__frame rl-init__frame--${f.kind}${initiator ? ' rl-init__frame--initiator' : ''}`}
      data-testid="rl-initiator-frame"
      data-kind={f.kind}
      data-index={index}
      data-location={f.original ? `${f.original.path}:${f.original.line}` : ''}
    >
      <span class="rl-init__frame-fn rl-mono">{functionLabel(f)}</span>
      <FrameLocation f={f} editorRoot={editorRoot} />
    </li>
  );
}
