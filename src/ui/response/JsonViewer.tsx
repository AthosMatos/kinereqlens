// OWNER: ui-response agent. Read-only, collapsible, filterable JSON tree over a lossless JNode.
// Find in page (opt-in `findInPage`, docs/ARCHITECTURE.md §13): locate icons next to values the page shows, the
// toolbar status, and revealing a node (back from the page, or from "Where does this come from?" via `revealKey`); a
// camera row action (and S) captures the element showing a value with the padding and opens it in the Screenshot view.
import type { JSX } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JNode } from '../../shared/types';
import { formatPath, getNodeAtPath, serializeJsonTree } from '../../lib/json-tree';
import { copyText } from '../components/clipboard';
import { Icon } from '../components/Icon';
import { memo } from '../components/memo';
import type { NodeFind } from '../find/controller';
import { FindCaptureButton, FindIcon, FindStatus } from '../find/FindParts';
import { onRevealRequest, takeReveal } from '../find/reveal';
import { useFindInPage } from '../find/useFindInPage';
import { plural } from './body-model';
import {
  ancestorIds,
  closeBracket,
  containerSummary,
  flattenJson,
  highlightSegments,
  isContainer,
  leafText,
  openBracket,
  scalarCopyText,
  searchJson,
  STRING_DISPLAY_MAX,
} from './json-view';
import type { JsonRow, SearchResult } from './json-view';
import { hasTextSelection, JSON_PAGE_ROWS, ShowMore, usePageLimit } from './parts';

export interface JsonViewerProps {
  root: JNode;
  /** Containers shallower than this are expanded initially (default 2). */
  initialDepth?: number;
  /** Rows rendered per "Show more" step (default 2,000). */
  pageSize?: number;
  testId?: string;
  /** Find in page: locate icons for the values the page shows (response bodies, WebSocket messages). */
  findInPage?: boolean;
  /** Reveal requests addressed to this key show their path here (src/ui/find/reveal.ts). */
  revealKey?: string;
}

type BaseMode = 'initial' | 'all' | 'none';

/**
 * Expansion state. Every event carries a logical clock value; for a given container the most recent
 * applicable event wins: its own toggle, a filter that matched below it, or expand/collapse all.
 */
interface ExpandState {
  root: JNode;
  base: { mode: BaseMode; at: number };
  toggles: Map<string, { open: boolean; at: number }>;
}

/** A click inside the tree resolved to its row and (optional) `data-action`. */
interface RowHit {
  row: JsonRow;
  index: number;
  action: string | null;
  /** The action came from an explicit button (not a click on the value text). */
  button: boolean;
}

const FILTER_DEBOUNCE_MS = 120;
/** A revealed node flashes this long. */
const FLASH_MS = 1600;
/** Rows flattened at most to find a revealed node beyond the "Show more" limit. */
const REVEAL_SCAN_ROWS = 2_000_000;
/** Longest value snippet sent to the page's highlight label. */
const SNIPPET_MAX = 60;

/** Value snippet of a leaf for the page-side label. */
function snippetOf(node: JNode): string {
  const text = leafText(node);
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text;
}

function initialExpandState(root: JNode): ExpandState {
  return { root, base: { mode: 'initial', at: 0 }, toggles: new Map() };
}

/** Read-only JSON tree: expand/collapse (all), filter with highlight, click a value to copy it, copy paths. */
export function JsonViewer({ root, initialDepth = 2, pageSize = JSON_PAGE_ROWS, testId, findInPage = false, revealKey }: JsonViewerProps) {
  const clock = useRef(1);
  const tick = () => ++clock.current;

  // A new tree (e.g. another run) restarts expansion; the stable fallback keeps memoized rows valid until then.
  const [expandState, setExpandState] = useState<ExpandState>(() => initialExpandState(root));
  const freshState = useMemo(() => initialExpandState(root), [root]);
  const expand = expandState.root === root ? expandState : freshState;

  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState<{ q: string; at: number }>({ q: '', at: 0 });
  const [onlyMatches, setOnlyMatches] = useState(false);
  // Long strings the user chose to show in full, scoped to the tree they belong to.
  const [fullStringState, setFullStrings] = useState<{ root: JNode; ids: Set<string> }>(() => ({ root, ids: new Set() }));
  const fullStrings = fullStringState.root === root ? fullStringState.ids : null;
  const [limit, setLimit] = usePageLimit(root, pageSize);
  const [focus, setFocus] = useState(0);
  const treeRef = useRef<HTMLDivElement>(null);
  const focusFromKeyboard = useRef(false);
  /** A node to scroll to, focus (and flash) once the rows show it. */
  const pendingReveal = useRef<{ nodeId: string; flash: boolean } | null>(null);
  const [revealSeq, setRevealSeq] = useState(0);
  const [flashId, setFlashId] = useState<string | null>(null);

  useEffect(() => {
    if (query === applied.q) return;
    const timer = setTimeout(() => setApplied({ q: query, at: tick() }), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, applied.q]);

  const search: SearchResult | null = useMemo(() => (applied.q.trim() ? searchJson(root, applied.q) : null), [root, applied.q]);

  const isExpanded = (node: JNode, depth: number): boolean => {
    const own = expand.toggles.get(node.id);
    const filterAt = search?.ancestors.has(node.id) ? applied.at : -1;
    if (filterAt > expand.base.at && filterAt > (own?.at ?? -1)) return true;
    if (own) return own.open;
    if (expand.base.mode === 'all') return true;
    if (expand.base.mode === 'none') return depth < 1;
    return depth < initialDepth;
  };

  const { rows, more } = useMemo(
    () => flattenJson(root, { isExpanded, limit, restrictTo: onlyMatches && search ? search : undefined }),
    // isExpanded is a fresh closure every render, derived from exactly these values.
    [root, expand, search, applied.at, onlyMatches, limit, initialDepth],
  );

  const focusIndex = Math.min(focus, Math.max(0, rows.length - 1));

  useLayoutEffect(() => {
    if (!focusFromKeyboard.current) return;
    focusFromKeyboard.current = false;
    treeRef.current?.querySelector<HTMLElement>(`[data-idx="${focusIndex}"]`)?.focus();
  }, [focusIndex, rows]);

  useLayoutEffect(() => {
    const pending = pendingReveal.current;
    if (!pending) return;
    const index = rows.findIndex((r) => r.node.id === pending.nodeId && r.kind !== 'close');
    if (index < 0) {
      if (more) {
        // Beyond the "Show more" limit: show enough rows.
        const all = flattenJson(root, { isExpanded, limit: REVEAL_SCAN_ROWS });
        const at = all.rows.findIndex((r) => r.node.id === pending.nodeId && r.kind !== 'close');
        if (at >= limit) {
          setLimit(Math.ceil((at + 1) / pageSize) * pageSize);
          return;
        }
      }
      pendingReveal.current = null;
      return;
    }
    pendingReveal.current = null;
    setFocus(index);
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.focus({ preventScroll: true });
    }
    if (pending.flash) setFlashId(pending.nodeId);
    // isExpanded / limit / pageSize are read for this pass only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, more, revealSeq]);

  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);

  const setAll = (mode: BaseMode) => setExpandState({ root, base: { mode, at: tick() }, toggles: new Map() });

  const toggle = (row: JsonRow) => {
    const next = { open: row.kind !== 'open', at: tick() };
    setExpandState((prev) => {
      const current = prev.root === root ? prev : initialExpandState(root);
      const toggles = new Map(current.toggles);
      toggles.set(row.node.id, next);
      return { ...current, toggles };
    });
  };

  /** Expand the way to a node, then (layout effect below) scroll to it, focus it and optionally flash it. */
  const reveal = useCallback(
    (nodeId: string, flash: boolean) => {
      const ancestors = ancestorIds(root, nodeId);
      if (!ancestors) return;
      setExpandState((prev) => {
        const current = prev.root === root ? prev : initialExpandState(root);
        const toggles = new Map(current.toggles);
        const at = tick();
        for (const id of ancestors) toggles.set(id, { open: true, at });
        return { ...current, toggles };
      });
      // "Only matches" could hide it.
      setOnlyMatches(false);
      pendingReveal.current = { nodeId, flash };
      setRevealSeq((n) => n + 1);
    },
    [root],
  );

  const find = useFindInPage(root, findInPage, (nodeId) => reveal(nodeId, true));

  // Reveal requests ("Where does this come from?" results): taken at mount and whenever one is made.
  useEffect(() => {
    if (!revealKey) return;
    const take = () => {
      const path = takeReveal(revealKey);
      const node = path ? getNodeAtPath(root, path) : null;
      if (node) reveal(node.id, true);
    };
    take();
    return onRevealRequest(take);
  }, [revealKey, root, reveal]);

  const showFullString = (id: string) =>
    setFullStrings((prev) => ({ root, ids: new Set(prev.root === root ? prev.ids : []).add(id) }));

  const copyValue = (row: JsonRow) => {
    const text = isContainer(row.node) ? serializeJsonTree(row.node, 2) : scalarCopyText(row.node);
    void copyText(text, 'Copied value');
  };

  const copyPath = (row: JsonRow) => {
    const path = formatPath(row.path);
    void copyText(path || '(root)', `Copied path ${path || '(root)'}`);
  };

  /** Show this value on the page (hides the overlay while the page side highlights it). */
  const locate = (row: JsonRow) => {
    const nf = find.snapshot.byNode.get(row.node.id);
    if (!nf || nf.result.common) return;
    find.locate(row.node.id, formatPath(row.path) || '(root)', snippetOf(row.node));
  };

  /** Screenshot of the element showing this value (with the padding), opened in the Screenshot view. */
  const captureValue = (row: JsonRow) => {
    if (!capturable(find.snapshot.byNode.get(row.node.id), find.canCapture)) return;
    find.capture(row.node.id, formatPath(row.path) || '(root)');
  };

  const rowAt = (target: EventTarget | null): RowHit | null => {
    const el = target instanceof Element ? target : null;
    const rowEl = el?.closest<HTMLElement>('[data-idx]');
    if (!rowEl) return null;
    const index = Number(rowEl.dataset.idx);
    const row = rows[index];
    if (!row) return null;
    const actionEl = el?.closest<HTMLElement>('[data-action]');
    return { row, index, action: actionEl?.dataset.action ?? null, button: actionEl instanceof HTMLButtonElement };
  };

  const onClick = (e: JSX.TargetedMouseEvent<HTMLDivElement>) => {
    const hit = rowAt(e.target);
    if (!hit) return;
    if (hit.row.kind !== 'close') setFocus(hit.index);
    switch (hit.action) {
      case 'toggle':
        toggle(hit.row);
        break;
      case 'copy-value':
        // Clicking value text while selecting part of it must not overwrite the user's selection copy.
        if (hit.button || !hasTextSelection(e.currentTarget)) copyValue(hit.row);
        break;
      case 'copy-path':
        copyPath(hit.row);
        break;
      case 'full-string':
        showFullString(hit.row.node.id);
        break;
      case 'find-locate':
        locate(hit.row);
        break;
      case 'find-capture':
        captureValue(hit.row);
        break;
    }
  };

  const moveFocus = (from: number, step: 1 | -1) => {
    for (let i = from + step; i >= 0 && i < rows.length; i += step) {
      if (rows[i].kind !== 'close') return i;
    }
    return from;
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const row = rows[focusIndex];
    if (!row) return;
    let next = focusIndex;
    switch (e.key) {
      case 'ArrowDown':
        next = moveFocus(focusIndex, 1);
        break;
      case 'ArrowUp':
        next = moveFocus(focusIndex, -1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = moveFocus(rows.length, -1);
        break;
      case 'ArrowRight':
        if (row.kind === 'collapsed') toggle(row);
        else if (row.kind === 'open') next = moveFocus(focusIndex, 1);
        break;
      case 'ArrowLeft':
        if (row.kind === 'open') toggle(row);
        else if (row.parentIndex >= 0) next = row.parentIndex;
        break;
      case 'Enter':
        if (e.shiftKey) copyPath(row);
        else copyValue(row);
        break;
      case 'l':
      case 'L':
        // Find in page: show the focused value on the page.
        if (e.altKey || e.ctrlKey || e.metaKey || !find.snapshot.byNode.has(row.node.id)) return;
        locate(row);
        break;
      case 's':
      case 'S':
        // Find in page: screenshot of the element showing the focused value.
        if (e.altKey || e.ctrlKey || e.metaKey || !capturable(find.snapshot.byNode.get(row.node.id), find.canCapture)) return;
        captureValue(row);
        break;
      default:
        return;
    }
    e.preventDefault();
    focusFromKeyboard.current = true;
    setFocus(next);
  };

  const matchCount = search?.matches.size ?? 0;
  const q = applied.q;

  return (
    <div class="rl-jv" data-testid={testId}>
      <div class="rl-jv__toolbar">
        <label class="rl-jv__filter">
          <Icon name="search" size={12} class="rl-jv__filter-icon" />
          <input
            type="search"
            class="rl-input rl-jv__filter-input"
            placeholder="Filter keys and values"
            aria-label="Filter JSON keys and values"
            value={query}
            spellcheck={false}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault();
                setQuery('');
              }
            }}
          />
        </label>
        {search && (
          <span class={`rl-jv__matches${matchCount === 0 ? ' rl-jv__matches--none' : ''}`} aria-live="polite">
            {matchCount === 0 ? 'No matches' : plural(matchCount, 'match', 'matches')}
          </span>
        )}
        {search && (
          <button
            type="button"
            class="rl-chip"
            aria-pressed={onlyMatches}
            title="Hide everything that does not match the filter"
            onClick={() => setOnlyMatches((v) => !v)}
          >
            Only matches
          </button>
        )}
        <FindStatus view={find} />
        {/* Kept together: when the toolbar is narrow the pair wraps as one unit instead of splitting. */}
        <span class="rl-jv__tree-actions">
          <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" title="Expand all" onClick={() => setAll('all')}>
            <Icon name="chevron-down" size={12} />
            <span>Expand all</span>
          </button>
          <button type="button" class="rl-btn rl-btn--sm rl-btn--ghost" title="Collapse all" onClick={() => setAll('none')}>
            <Icon name="chevron-right" size={12} />
            <span>Collapse all</span>
          </button>
        </span>
      </div>
      <div
        ref={treeRef}
        class="rl-jv__tree"
        role="tree"
        aria-label={`JSON response (↑↓ move, ←→ collapse/expand, Enter copies value, Shift+Enter copies path${find.available && find.enabled ? ', L shows the value on the page' : ''}${find.canCapture ? ', S takes a screenshot of it' : ''})`}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        {rows.map((row, index) => (
          <JsonRowView
            key={`${row.node.id}:${row.kind === 'close' ? 'c' : 'o'}`}
            row={row}
            index={index}
            focused={index === focusIndex}
            query={q}
            matched={search?.matches.has(row.node.id) ?? false}
            fullString={fullStrings?.has(row.node.id) ?? false}
            find={row.kind === 'leaf' ? find.snapshot.byNode.get(row.node.id) : undefined}
            canCapture={find.canCapture}
            flash={flashId === row.node.id}
          />
        ))}
      </div>
      {more && (
        <ShowMore
          status={`Showing the first ${plural(rows.length, 'line')}`}
          moreLabel={`Show ${pageSize.toLocaleString('en-US')} more`}
          onMore={() => setLimit(limit + pageSize)}
        />
      )}
    </div>
  );
}

interface JsonRowViewProps {
  row: JsonRow;
  index: number;
  focused: boolean;
  query: string;
  matched: boolean;
  fullString: boolean;
  /** Find in page result of the value (leaves). */
  find?: NodeFind;
  /** Values shown on the page can be captured (camera row action). */
  canCapture: boolean;
  /** Just revealed: flash. */
  flash: boolean;
}

/** A value whose element can be captured: shown on the page (visible), not too common to pick one. */
function capturable(find: NodeFind | undefined, canCapture: boolean): boolean {
  return canCapture && !!find && !find.result.common && find.result.visible > 0;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  return (
    <>
      {highlightSegments(text, query).map((seg, i) =>
        seg.match ? (
          <mark key={i} class="rl-jv__mark">
            {seg.text}
          </mark>
        ) : (
          seg.text
        ),
      )}
    </>
  );
}

function RowLabel({ label, query }: { label: string | number | undefined; query: string }) {
  if (label === undefined) return null;
  if (typeof label === 'number') {
    return <span class="rl-jv__index">{label}: </span>;
  }
  return (
    <>
      <span class="rl-jv__key">
        <Highlighted text={JSON.stringify(label)} query={query} />
      </span>
      <span class="rl-jv__punct">: </span>
    </>
  );
}

function LeafValue({ node, query, fullString }: { node: JNode; query: string; fullString: boolean }) {
  const text = leafText(node);
  const clipped = !fullString && node.type === 'string' && text.length > STRING_DISPLAY_MAX;
  const shown = clipped ? `${text.slice(0, STRING_DISPLAY_MAX)}…` : text;
  return (
    <>
      <span class={`rl-jv__value rl-jv__value--${node.type}`} data-action="copy-value" title="Click to copy value">
        <Highlighted text={shown} query={query} />
      </span>
      {clipped && (
        <button type="button" class="rl-jv__more" data-action="full-string" tabIndex={-1}>
          +{(text.length - STRING_DISPLAY_MAX).toLocaleString('en-US')} chars
        </button>
      )}
    </>
  );
}

function RowActions({ root, capture }: { root: boolean; capture: boolean }) {
  return (
    <span class="rl-jv__actions">
      {capture ? <FindCaptureButton /> : null}
      <button type="button" class="rl-jv__action" data-action="copy-value" tabIndex={-1} title="Copy value" aria-label="Copy value">
        <Icon name="copy" size={11} />
      </button>
      {!root && (
        <button type="button" class="rl-jv__action" data-action="copy-path" tabIndex={-1} title="Copy path" aria-label="Copy path">
          path
        </button>
      )}
    </span>
  );
}

/** One row; memoized (props by identity) so streaming Find in page results only re-render the rows they change. */
const JsonRowView = memo(function JsonRowView({ row, index, focused, query, matched, fullString, find, canCapture, flash }: JsonRowViewProps) {
  const { node, kind } = row;
  const style = `--rl-jv-depth:${Math.min(row.depth, 64)}`;
  if (kind === 'close') {
    return (
      <div class="rl-jv__row rl-jv__row--close" role="none" data-idx={index} style={style}>
        <span class="rl-jv__toggle-space" />
        <span class="rl-jv__punct">{closeBracket(node)}</span>
        {row.comma && <span class="rl-jv__punct">,</span>}
      </div>
    );
  }
  const container = kind === 'open' || kind === 'collapsed';
  const summary = kind === 'collapsed' ? containerSummary(node) : null;
  return (
    <div
      class={`rl-jv__row${matched ? ' rl-jv__row--match' : ''}${flash ? ' rl-jv__row--flash' : ''}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={container ? kind === 'open' : undefined}
      tabIndex={focused ? 0 : -1}
      data-idx={index}
      data-path={formatPath(row.path)}
      data-type={node.type}
      style={style}
    >
      {container ? (
        <button
          type="button"
          class={`rl-jv__toggle${kind === 'open' ? ' rl-jv__toggle--open' : ''}`}
          data-action="toggle"
          tabIndex={-1}
          aria-label={kind === 'open' ? 'Collapse' : 'Expand'}
        >
          <Icon name="chevron-right" size={11} />
        </button>
      ) : (
        <span class="rl-jv__toggle-space" />
      )}
      <RowLabel label={row.label} query={query} />
      {kind === 'leaf' && (
        // One inline box, so a wrapped long value keeps its comma right after the last character.
        <span class="rl-jv__leaf">
          <LeafValue node={node} query={query} fullString={fullString} />
          {row.comma && <span class="rl-jv__punct">,</span>}
        </span>
      )}
      {kind === 'leaf' && find ? <FindIcon find={find} /> : null}
      {kind === 'open' && <span class="rl-jv__punct" data-action="toggle">{openBracket(node)}</span>}
      {summary && (
        <span class="rl-jv__summary" data-action="toggle">
          <span class="rl-jv__punct">{summary.brackets}</span>
          <span class="rl-jv__count">{summary.count}</span>
        </span>
      )}
      {row.comma && kind === 'collapsed' && <span class="rl-jv__punct">,</span>}
      <RowActions root={row.parentIndex < 0} capture={kind === 'leaf' && capturable(find, canCapture)} />
    </div>
  );
});
