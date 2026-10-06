// OWNER: ui-editor agent. Lossless JSON body editor: one section card per top-level key / array item, nested
// collapsible groups, typed value editors, per-node revert, GraphQL (single and batched) sections.
//
// Rendering model: every node is a memoized component keyed by node id. json-tree mutators keep untouched
// subtrees identical, so an edit re-renders only the path from the root to the edited node. Diff/error
// state is read from a stable context object (`ctx.state`, refreshed by JsonEditor on every render)
// instead of being passed as props: a node's modified/error status depends only on its own subtree,
// which cannot change without the node object changing too.
import type { JSX, RefObject } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JNode, JNodeType } from '../../shared/types';
import {
  addChild,
  changeNodeType,
  duplicateNode,
  findNode,
  formatPath,
  removeNode,
  updateNode,
  type TreeDiff,
} from '../../lib/json-tree';
import { Icon } from '../components/Icon';
import { treeDiffOf, treeErrorsOf } from './derived';
import { AutoTextarea, ValueInput } from './inputs';
import { cx, isPlainEnter, memo, safely, usePersistentToggle } from './util';

type Path = Array<string | number>;
type FocusField = 'key' | 'value';

export interface JsonEditorProps {
  tree: JNode;
  /** Captured tree (diff/revert baseline); null when the original body was not JSON. */
  originalTree: JNode | null;
  flavor?: 'graphql' | 'graphql-batch';
  /** Stable: apply an immutable tree edit to the latest draft. */
  onTree(fn: (tree: JNode) => JNode): void;
  /** Stable: revert one node (removes it when it was added). */
  onRevertNode(id: string): void;
}

interface JsonCtx {
  state: { tree: JNode; diff: TreeDiff | null; errors: Map<string, string> };
  onTree(fn: (tree: JNode) => JNode): void;
  onRevertNode(id: string): void;
  /** Focus a node's key/value input now or as soon as it mounts. */
  focus(id: string, field: FocusField): void;
  takeFocus(id: string): FocusField | null;
}

const PAGE_SIZE = 100;
/** Containers deeper than this start collapsed. */
const EXPAND_DEPTH = 3;
const TYPES: JNodeType[] = ['string', 'number', 'boolean', 'null', 'object', 'array'];
const NO_KIDS: JNode[] = [];

function isContainer(node: JNode): boolean {
  return node.type === 'object' || node.type === 'array';
}

function nodeModified(diff: TreeDiff | null, node: JNode): boolean {
  if (!diff) return true;
  if (diff.changed.has(node.id) || diff.added.has(node.id)) return true;
  return isContainer(node) && diff.dirty.has(node.id);
}

const dupCache = new WeakMap<JNode[], Set<string>>();

/** Keys that occur more than once among object members. */
function duplicateKeysOf(kids: JNode[]): Set<string> {
  let set = dupCache.get(kids);
  if (set) return set;
  const seen = new Set<string>();
  set = new Set();
  for (const k of kids) {
    const key = k.key ?? '';
    if (seen.has(key)) set.add(key);
    else seen.add(key);
  }
  dupCache.set(kids, set);
  return set;
}

function scalarPreview(c: JNode): string {
  switch (c.type) {
    case 'object':
      return '{…}';
    case 'array':
      return '[…]';
    case 'string': {
      const s = typeof c.value === 'string' ? c.value : '';
      return JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}…` : s);
    }
    case 'null':
      return 'null';
    default:
      return String(c.value);
  }
}

/** One-line preview of a collapsed container ("id: 1, name: "x", …"). */
function previewOf(node: JNode, max = 72): string {
  const parts: string[] = [];
  let len = 0;
  for (const c of node.children ?? NO_KIDS) {
    const s = node.type === 'object' ? `${c.key ?? ''}: ${scalarPreview(c)}` : scalarPreview(c);
    parts.push(s);
    len += s.length + 2;
    if (len > max) break;
  }
  const out = parts.join(', ');
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

const KEY_SELECTOR = '[data-testid="rl-json-key"]';
const VALUE_SELECTOR =
  'input[data-testid="rl-json-value"], textarea[data-testid="rl-json-value"], textarea[data-testid="rl-gql-query"]';

/** Focus the key or value control of a rendered node row (falls back to its first control). */
function focusRenderedNode(root: HTMLElement | null, id: string, field: FocusField): void {
  const row = root?.querySelector<HTMLElement>(`[data-target-id="${CSS.escape(id)}"]`);
  if (!row) return;
  const first = field === 'key' ? KEY_SELECTOR : VALUE_SELECTOR;
  const second = field === 'key' ? VALUE_SELECTOR : KEY_SELECTOR;
  const el =
    row.querySelector<HTMLElement>(first) ??
    row.querySelector<HTMLElement>(second) ??
    row.querySelector<HTMLElement>('input, textarea, select');
  el?.focus();
}

function useJsonCtx(
  tree: JNode,
  onTree: JsonCtx['onTree'],
  onRevertNode: JsonCtx['onRevertNode'],
  rootRef: RefObject<HTMLElement>,
): JsonCtx {
  const ctx = useMemo<JsonCtx>(() => {
    let pending: { id: string; field: FocusField } | null = null;
    const c: JsonCtx = {
      state: { tree, diff: null, errors: new Map() },
      onTree,
      onRevertNode,
      focus(id, field) {
        const request = { id, field };
        pending = request;
        // A node that mounts takes the focus in its layout effect. One that is already mounted (e.g. the next
        // sibling after a delete) may not re-render at all, so focus it from the DOM once the edit committed.
        // Either way the request is dropped afterwards, so it can never steal focus later.
        setTimeout(() => {
          if (pending !== request) return;
          pending = null;
          focusRenderedNode(rootRef.current, id, field);
        }, 0);
      },
      takeFocus(id) {
        if (!pending || pending.id !== id) return null;
        const f = pending.field;
        pending = null;
        return f;
      },
    };
    return c;
    // `tree` only seeds the initial state; JsonEditor refreshes ctx.state on every render.
  }, [onTree, onRevertNode, rootRef]);
  return ctx;
}

/** JSON body editor (Fields view). */
export const JsonEditor = memo(function JsonEditor(props: JsonEditorProps) {
  const { tree, originalTree, flavor } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const ctx = useJsonCtx(tree, props.onTree, props.onRevertNode, rootRef);
  ctx.state = {
    tree,
    diff: originalTree ? treeDiffOf(originalTree, tree) : null,
    errors: treeErrorsOf(tree),
  };

  let content: JSX.Element;
  let variant: string | false = false;
  if (flavor === 'graphql' && tree.type === 'object') {
    variant = 'rl-gql';
    content = <GraphqlOperation node={tree} path={[]} depth={0} ctx={ctx} />;
  } else if (flavor === 'graphql-batch' && tree.type === 'array') {
    variant = 'rl-gql rl-gql-batch';
    content = <GraphqlBatch tree={tree} ctx={ctx} />;
  } else if (isContainer(tree)) {
    content = <ChildrenList parent={tree} path={[]} depth={0} ctx={ctx} card />;
  } else {
    content = <JsonNode node={tree} path={[]} pathKey="" depth={0} inArray={false} dupKey={false} card root ctx={ctx} />;
  }
  return (
    <div class={cx('rl-jed', variant)} ref={rootRef}>
      {content}
    </div>
  );
});

// --------------------------------------------------------------------------------------------- lists

interface ChildrenListProps {
  parent: JNode;
  path: Path;
  depth: number;
  ctx: JsonCtx;
  /** Render children as section cards (top level). */
  card?: boolean;
  /** Label of the add button (default "Add field" / "Add item"). */
  addLabel?: string;
}

function ChildrenList({ parent, path, depth, ctx, card, addLabel }: ChildrenListProps) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const kids = parent.children ?? NO_KIDS;
  const isArr = parent.type === 'array';
  const dups = isArr ? null : duplicateKeysOf(kids);
  const shown = kids.length > limit ? kids.slice(0, limit) : kids;
  const pathKey = safely(() => formatPath(path), '');

  const onAdd = () => {
    const created = { id: '' };
    ctx.onTree((t) => {
      const r = addChild(t, parent.id, { type: 'string' });
      created.id = r.id;
      return r.root;
    });
    if (kids.length >= limit) setLimit(kids.length + 1);
    if (created.id) ctx.focus(created.id, isArr ? 'value' : 'key');
  };

  return (
    <div class={cx('rl-jed-list', card && 'rl-jed-list--cards')}>
      {kids.length === 0 && (
        <div class="rl-jed-empty rl-faint">{isArr ? 'Empty array.' : 'Empty object.'}</div>
      )}
      {shown.map((child, i) => {
        const childPath = [...path, isArr ? i : (child.key ?? '')];
        return (
          <JsonNode
            key={child.id}
            node={child}
            path={childPath}
            pathKey={safely(() => formatPath(childPath), String(i))}
            depth={depth + 1}
            inArray={isArr}
            dupKey={!!dups && dups.has(child.key ?? '')}
            card={!!card}
            ctx={ctx}
          />
        );
      })}
      {kids.length > shown.length && (
        <div class="rl-jed-more">
          <span class="rl-faint">
            Showing {shown.length} of {kids.length}
          </span>
          <button
            type="button"
            class="rl-btn rl-btn--ghost rl-btn--sm"
            onClick={() => setLimit((l) => l + PAGE_SIZE)}
          >
            Show {Math.min(PAGE_SIZE, kids.length - shown.length)} more
          </button>
          <button type="button" class="rl-btn rl-btn--ghost rl-btn--sm" onClick={() => setLimit(Infinity)}>
            Show all
          </button>
        </div>
      )}
      <button
        type="button"
        class="rl-btn rl-btn--ghost rl-btn--sm rl-jed-add"
        data-testid="rl-json-add"
        data-path={pathKey}
        onClick={onAdd}
      >
        <Icon name="plus" size={12} />
        {addLabel ?? (isArr ? 'Add item' : 'Add field')}
      </button>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- node

interface JsonNodeProps {
  node: JNode;
  path: Path;
  /** formatPath(path); compared instead of `path` by the memo. */
  pathKey: string;
  depth: number;
  inArray: boolean;
  dupKey: boolean;
  card: boolean;
  /** Fixed title instead of the key input (GraphQL sections). */
  title?: string;
  /** Root node: cannot be deleted/duplicated. */
  root?: boolean;
  ctx: JsonCtx;
}

/** Mutations shared by node rows and GraphQL cards. */
function nodeOps(ctx: JsonCtx, node: JNode, inArray: boolean) {
  return {
    revert: () => ctx.onRevertNode(node.id),
    duplicate: () => {
      const created = { id: '' };
      ctx.onTree((t) => {
        const r = duplicateNode(t, node.id);
        created.id = r.id;
        return r.root;
      });
      if (created.id) ctx.focus(created.id, inArray ? 'value' : 'key');
    },
    remove: () => {
      const loc = safely(() => findNode(ctx.state.tree, node.id), null);
      const siblings = loc?.parent?.children;
      const next = loc && siblings ? (siblings[loc.index + 1] ?? siblings[loc.index - 1]) : undefined;
      ctx.onTree((t) => removeNode(t, node.id));
      if (next) ctx.focus(next.id, inArray ? 'value' : 'key');
    },
  };
}

const JsonNode = memo(
  function JsonNode(p: JsonNodeProps) {
    const { node, ctx, depth } = p;
    const container = isContainer(node);
    const { diff, errors } = ctx.state;
    const modified = nodeModified(diff, node);
    const added = !diff || diff.added.has(node.id);
    const error = errors.get(node.id);
    const [expanded, setExpanded] = usePersistentToggle(`json:${node.id}`, depth <= EXPAND_DEPTH);
    const rowRef = useRef<HTMLDivElement>(null);
    const keyEl = useRef<HTMLElement | null>(null);
    const valueEl = useRef<HTMLElement | null>(null);

    useLayoutEffect(() => {
      const field = ctx.takeFocus(node.id);
      if (!field) return;
      const el =
        (field === 'key' ? (keyEl.current ?? valueEl.current) : (valueEl.current ?? keyEl.current)) ??
        rowRef.current?.querySelector<HTMLElement>('input, select, textarea');
      el?.focus();
    });

    const ops = nodeOps(ctx, node, p.inArray);
    const setKey = (key: string) => ctx.onTree((t) => updateNode(t, node.id, { key }));
    const setValue = (value: string | boolean) => ctx.onTree((t) => updateNode(t, node.id, { value }));
    const setType = (type: JNodeType) => {
      ctx.onTree((t) => changeNodeType(t, node.id, type));
      if (type === 'object' || type === 'array') setExpanded(true);
    };
    const focusValue = () => {
      if (valueEl.current) valueEl.current.focus();
      else if (container && !expanded) setExpanded(true);
    };

    const index = p.path[p.path.length - 1];
    // Screen readers: every control names the field it acts on (a flat list of "Delete" buttons is useless).
    const label = p.title ?? (p.root ? 'body' : p.pathKey || 'field');
    const keyPart =
      p.title !== undefined ? (
        <span class="rl-jed-title">{p.title}</span>
      ) : p.root ? null : p.inArray ? (
        <span class="rl-jed-index" title={`Index ${String(index)}`}>
          {String(index)}
        </span>
      ) : (
        <input
          ref={(el) => {
            keyEl.current = el;
          }}
          type="text"
          class="rl-input rl-input--mono rl-jed-key"
          data-testid="rl-json-key"
          aria-label={`Key of ${label}`}
          placeholder="key"
          spellcheck={false}
          autocomplete="off"
          size={Math.min(28, Math.max(4, (node.key ?? '').length + 1))}
          value={node.key ?? ''}
          onInput={(e) => setKey(e.currentTarget.value)}
          onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
            if (isPlainEnter(e)) {
              e.preventDefault();
              focusValue();
            }
          }}
        />
      );

    const children = node.children ?? NO_KIDS;
    const removedCount = container && diff ? (diff.removed.get(node.id)?.length ?? 0) : 0;

    const row = (
      <div
        ref={rowRef}
        class={cx(
          'rl-jed-row',
          `rl-jed-row--${node.type}`,
          p.card && 'rl-jed-row--card',
          modified && 'rl-jed-row--modified',
          error && 'rl-jed-row--invalid',
        )}
        data-testid="rl-json-node"
        data-path={p.pathKey}
        data-modified={String(modified)}
        data-type={node.type}
        data-target-id={node.id}
      >
        {container ? (
          <button
            type="button"
            class="rl-icon-btn rl-icon-btn--sm rl-jed-chevron"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
            onClick={() => setExpanded()}
          >
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
          </button>
        ) : (
          p.card && <span class="rl-jed-chevron-spacer" />
        )}
        {keyPart}
        {p.dupKey && (
          <span class="rl-jed-dup" title="Duplicate key — most JSON parsers keep only the last occurrence">
            <Icon name="warning" size={11} />
          </span>
        )}
        <select
          class="rl-select rl-jed-type"
          data-testid="rl-json-type"
          aria-label={`Type of ${label}`}
          value={node.type}
          onChange={(e) => setType(e.currentTarget.value as JNodeType)}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {container ? (
          <span class="rl-jed-summary">
            <span class="rl-jed-count">{node.type === 'array' ? `[${children.length}]` : `{${children.length}}`}</span>
            {!expanded && children.length > 0 && <span class="rl-jed-preview rl-truncate">{previewOf(node)}</span>}
            {removedCount > 0 && (
              <span class="rl-jed-removed" title={`${removedCount} removed — revert to restore`}>
                −{removedCount}
              </span>
            )}
          </span>
        ) : (
          <LeafValue node={node} label={label} error={error} setValue={setValue} valueEl={valueEl} />
        )}
        <span class="rl-jed-marks">
          {error && (
            <span class="rl-jed-error-icon" title={error}>
              <Icon name="warning" size={12} />
            </span>
          )}
          {modified && <span class="rl-modified-dot" title={added ? 'Added' : 'Modified'} />}
        </span>
        <span class="rl-jed-actions">
          {modified && (
            <button
              type="button"
              class="rl-icon-btn rl-icon-btn--sm"
              data-testid="rl-json-revert"
              title={added && !p.root ? 'Remove added field' : 'Revert to captured value'}
              aria-label={`Revert ${label}`}
              onClick={ops.revert}
            >
              <Icon name="revert" size={12} />
            </button>
          )}
          {!p.root && (
            <button
              type="button"
              class="rl-icon-btn rl-icon-btn--sm rl-jed-action"
              data-testid="rl-json-duplicate"
              title="Duplicate"
              aria-label={`Duplicate ${label}`}
              onClick={ops.duplicate}
            >
              <Icon name="copy" size={12} />
            </button>
          )}
          {!p.root && (
            <button
              type="button"
              class="rl-icon-btn rl-icon-btn--sm rl-jed-action"
              data-testid="rl-json-delete"
              title="Delete"
              aria-label={`Delete ${label}`}
              onClick={ops.remove}
            >
              <Icon name="trash" size={12} />
            </button>
          )}
        </span>
      </div>
    );

    const body = container && expanded && (
      <ChildrenList parent={node} path={p.path} depth={depth} ctx={ctx} />
    );

    if (p.card) {
      return (
        <div
          class={cx(
            'rl-card rl-jed-card',
            !container && 'rl-jed-card--leaf',
            modified && 'rl-jed-card--modified',
          )}
        >
          {row}
          {body && (
            <div class="rl-jed-card__body" role="group" aria-label={`Fields of ${label}`}>
              {body}
            </div>
          )}
        </div>
      );
    }
    if (!container) return row;
    return (
      <div class="rl-jed-group">
        {row}
        {body && (
          <div class="rl-jed-children" role="group" aria-label={`Fields of ${label}`}>
            {body}
          </div>
        )}
      </div>
    );
  },
  (a, b) =>
    a.node === b.node &&
    a.pathKey === b.pathKey &&
    a.depth === b.depth &&
    a.inArray === b.inArray &&
    a.dupKey === b.dupKey &&
    a.card === b.card &&
    a.title === b.title &&
    a.root === b.root &&
    a.ctx === b.ctx,
);

interface LeafValueProps {
  node: JNode;
  /** Field path, for the accessible name. */
  label: string;
  error?: string;
  setValue(value: string | boolean): void;
  valueEl: { current: HTMLElement | null };
}

function LeafValue({ node, label, error, setValue, valueEl }: LeafValueProps) {
  const register = (el: HTMLElement | null) => {
    valueEl.current = el;
  };
  switch (node.type) {
    case 'string':
      return (
        <ValueInput
          value={typeof node.value === 'string' ? node.value : ''}
          onValue={setValue}
          ariaLabel={`Value of ${label}`}
          testId="rl-json-value"
          placeholder='""'
          class="rl-jed-value rl-jed-value--string"
          longThreshold={60}
          maxHeight={280}
          elRef={register}
        />
      );
    case 'number':
      return (
        <input
          ref={register}
          type="text"
          inputMode="decimal"
          class={cx('rl-input rl-input--mono rl-jed-value rl-jed-value--number', error && 'rl-input--invalid')}
          data-testid="rl-json-value"
          aria-label={`Value of ${label} (number)`}
          aria-invalid={!!error || undefined}
          title={error}
          spellcheck={false}
          autocomplete="off"
          value={typeof node.value === 'string' ? node.value : String(node.value ?? '')}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
      );
    case 'boolean':
      return (
        <label class="rl-jed-bool">
          <input
            ref={register}
            type="checkbox"
            class="rl-checkbox"
            data-testid="rl-json-value"
            aria-label={`Value of ${label} (boolean)`}
            checked={node.value === true}
            onChange={(e) => setValue(e.currentTarget.checked)}
          />
          <span class="rl-mono">{node.value === true ? 'true' : 'false'}</span>
        </label>
      );
    default:
      return (
        <span class="rl-jed-null rl-mono" data-testid="rl-json-value">
          null
        </span>
      );
  }
}

// --------------------------------------------------------------------------------------------- GraphQL

const GQL_TITLES: Record<string, string> = {
  query: 'Query',
  variables: 'Variables',
  operationName: 'Operation name',
  extensions: 'Extensions',
};
const GQL_KEYS = ['query', 'variables', 'operationName', 'extensions'] as const;
const GQL_DEFAULT_TYPE: Record<(typeof GQL_KEYS)[number], JNodeType> = {
  query: 'string',
  variables: 'object',
  operationName: 'string',
  extensions: 'object',
};

/** "mutation CreateUser", "query (anonymous)", or null when the document has no operation. */
function describeOperation(doc: string): string | null {
  const text = doc.replace(/#[^\n\r]*/g, ' ');
  const m = /^\s*(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/.exec(text);
  if (m) return m[2] ? `${m[1]} ${m[2]}` : `${m[1]} (anonymous)`;
  if (/^\s*\{/.test(text)) return 'query (anonymous)';
  const any = /\b(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(text);
  return any ? `${any[1]} ${any[2]}` : null;
}

interface GraphqlOperationProps {
  node: JNode;
  path: Path;
  depth: number;
  ctx: JsonCtx;
}

/**
 * Fields created with "+ Add field" in a GraphQL object. They stay ordinary key/value fields whatever their
 * key becomes: re-classifying one as a standard section while its key is being typed ("extensions…",
 * "queryId") would remount it and drop focus and keystrokes.
 */
const addedGqlFields = new Set<string>();

/** Sections of one GraphQL request object: Query, Variables, Operation name, Extensions, then other keys. */
function GraphqlOperation({ node, path, depth, ctx }: GraphqlOperationProps) {
  const kids = node.children ?? NO_KIDS;
  const std = new Map<string, JNode>();
  const others: JNode[] = [];
  for (const c of kids) {
    const k = c.key ?? '';
    if (k in GQL_TITLES && !std.has(k) && !addedGqlFields.has(c.id)) std.set(k, c);
    else others.push(c);
  }
  const missing = GQL_KEYS.filter((k) => !std.has(k));

  const childProps = (c: JNode) => {
    const childPath = [...path, c.key ?? ''];
    return { path: childPath, pathKey: safely(() => formatPath(childPath), c.key ?? '') };
  };

  const addSection = (key: (typeof GQL_KEYS)[number]) => {
    const created = { id: '' };
    ctx.onTree((t) => {
      const r = addChild(t, node.id, { key, type: GQL_DEFAULT_TYPE[key] });
      created.id = r.id;
      return r.root;
    });
    if (created.id) ctx.focus(created.id, 'value');
  };

  return (
    <div class="rl-jed-list rl-jed-list--cards">
      {GQL_KEYS.map((k) => {
        const c = std.get(k);
        if (!c) return null;
        const cp = childProps(c);
        if (k === 'query' && c.type === 'string') {
          return <GqlQuery key={c.id} node={c} pathKey={cp.pathKey} ctx={ctx} />;
        }
        return (
          <JsonNode
            key={c.id}
            node={c}
            path={cp.path}
            pathKey={cp.pathKey}
            depth={depth + 1}
            inArray={false}
            dupKey={false}
            card
            title={GQL_TITLES[k]}
            ctx={ctx}
          />
        );
      })}
      {others.map((c) => {
        const cp = childProps(c);
        return (
          <JsonNode
            key={c.id}
            node={c}
            path={cp.path}
            pathKey={cp.pathKey}
            depth={depth + 1}
            inArray={false}
            dupKey={false}
            card
            ctx={ctx}
          />
        );
      })}
      <div class="rl-gql-add">
        {missing.map((k) => (
          <button
            key={k}
            type="button"
            class="rl-btn rl-btn--ghost rl-btn--sm"
            data-testid="rl-gql-add-section"
            data-key={k}
            onClick={() => addSection(k)}
          >
            <Icon name="plus" size={12} />
            {GQL_TITLES[k]}
          </button>
        ))}
        <ChildrenAddField node={node} path={path} ctx={ctx} />
      </div>
    </div>
  );
}

/** "+ Add field" for a GraphQL object (extra top-level keys). */
function ChildrenAddField({ node, path, ctx }: { node: JNode; path: Path; ctx: JsonCtx }) {
  const onAdd = () => {
    const created = { id: '' };
    ctx.onTree((t) => {
      const r = addChild(t, node.id, { type: 'string' });
      created.id = r.id;
      return r.root;
    });
    if (created.id) {
      addedGqlFields.add(created.id);
      ctx.focus(created.id, 'key');
    }
  };
  return (
    <button
      type="button"
      class="rl-btn rl-btn--ghost rl-btn--sm rl-jed-add"
      data-testid="rl-json-add"
      data-path={safely(() => formatPath(path), '')}
      onClick={onAdd}
    >
      <Icon name="plus" size={12} />
      Add field
    </button>
  );
}

interface GqlQueryProps {
  node: JNode;
  pathKey: string;
  ctx: JsonCtx;
}

/** Query document editor (monospace code textarea). */
const GqlQuery = memo(function GqlQuery({ node, pathKey, ctx }: GqlQueryProps) {
  const modified = nodeModified(ctx.state.diff, node);
  const text = typeof node.value === 'string' ? node.value : '';
  const op = useMemo(() => describeOperation(text), [text]);
  return (
    <div
      class={cx('rl-card rl-jed-card rl-gql-card', modified && 'rl-jed-card--modified')}
      data-testid="rl-json-node"
      data-path={pathKey}
      data-modified={String(modified)}
      data-type="string"
      data-target-id={node.id}
    >
      <div class="rl-jed-row rl-jed-row--card rl-gql-card__header">
        <span class="rl-jed-chevron-spacer" />
        <span class="rl-jed-title">Query</span>
        {op && <span class="rl-pill rl-gql-op rl-mono">{op}</span>}
        <span class="rl-spacer" />
        <span class="rl-jed-marks">{modified && <span class="rl-modified-dot" title="Modified" />}</span>
        <span class="rl-jed-actions">
          {modified && (
            <button
              type="button"
              class="rl-icon-btn rl-icon-btn--sm"
              data-testid="rl-json-revert"
              title="Revert query"
              aria-label="Revert query"
              onClick={() => ctx.onRevertNode(node.id)}
            >
              <Icon name="revert" size={12} />
            </button>
          )}
        </span>
      </div>
      <div class="rl-jed-card__body">
        <AutoTextarea
          value={text}
          onValue={(v) => ctx.onTree((t) => updateNode(t, node.id, { value: v }))}
          class="rl-textarea--mono rl-gql-query"
          testId="rl-gql-query"
          ariaLabel="GraphQL query"
          placeholder="query { … }"
          minRows={3}
          maxHeight={480}
        />
      </div>
    </div>
  );
});

/** Batched GraphQL: one group per operation. */
function GraphqlBatch({ tree, ctx }: { tree: JNode; ctx: JsonCtx }) {
  const items = tree.children ?? NO_KIDS;
  const addOperation = () => {
    ctx.onTree((t) => {
      const op = addChild(t, tree.id, { type: 'object' });
      return addChild(op.root, op.id, { key: 'query', type: 'string' }).root;
    });
  };
  return (
    <div class="rl-gql-batch__list">
      <div class="rl-jed-list rl-jed-list--cards">
        {items.map((item, i) => {
          const pathKey = safely(() => formatPath([i]), `[${i}]`);
          return item.type === 'object' ? (
            <GqlBatchItem key={item.id} node={item} index={i} pathKey={pathKey} ctx={ctx} />
          ) : (
            <JsonNode
              key={item.id}
              node={item}
              path={[i]}
              pathKey={pathKey}
              depth={1}
              inArray
              dupKey={false}
              card
              ctx={ctx}
            />
          );
        })}
        {items.length === 0 && <div class="rl-jed-empty rl-faint">No operations.</div>}
        <button
          type="button"
          class="rl-btn rl-btn--ghost rl-btn--sm rl-jed-add"
          data-testid="rl-json-add"
          data-path=""
          onClick={addOperation}
        >
          <Icon name="plus" size={12} />
          Add operation
        </button>
      </div>
    </div>
  );
}

interface GqlBatchItemProps {
  node: JNode;
  index: number;
  pathKey: string;
  ctx: JsonCtx;
}

const GqlBatchItem = memo(function GqlBatchItem({ node, index, pathKey, ctx }: GqlBatchItemProps) {
  const [expanded, setExpanded] = usePersistentToggle(`json:${node.id}`, true);
  const modified = nodeModified(ctx.state.diff, node);
  const ops = nodeOps(ctx, node, true);
  const opName = node.children?.find((c) => c.key === 'operationName');
  const query = node.children?.find((c) => c.key === 'query');
  const label =
    (typeof opName?.value === 'string' && opName.value) ||
    (typeof query?.value === 'string' ? describeOperation(query.value) : null) ||
    'anonymous';
  return (
    <div class={cx('rl-card rl-jed-card rl-gql-op-card', modified && 'rl-jed-card--modified')}>
      <div
        class={cx('rl-jed-row rl-jed-row--card rl-jed-row--object', modified && 'rl-jed-row--modified')}
        data-testid="rl-json-node"
        data-path={pathKey}
        data-modified={String(modified)}
        data-type="object"
        data-target-id={node.id}
      >
        <button
          type="button"
          class="rl-icon-btn rl-icon-btn--sm rl-jed-chevron"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={() => setExpanded()}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
        </button>
        <span class="rl-jed-title">Operation {index + 1}</span>
        <span class="rl-pill rl-gql-op rl-mono">{label}</span>
        <span class="rl-spacer" />
        <span class="rl-jed-marks">{modified && <span class="rl-modified-dot" title="Modified" />}</span>
        <span class="rl-jed-actions">
          {modified && (
            <button
              type="button"
              class="rl-icon-btn rl-icon-btn--sm"
              data-testid="rl-json-revert"
              title="Revert operation"
              aria-label="Revert operation"
              onClick={ops.revert}
            >
              <Icon name="revert" size={12} />
            </button>
          )}
          <button
            type="button"
            class="rl-icon-btn rl-icon-btn--sm rl-jed-action"
            data-testid="rl-json-duplicate"
            title="Duplicate operation"
            aria-label="Duplicate operation"
            onClick={ops.duplicate}
          >
            <Icon name="copy" size={12} />
          </button>
          <button
            type="button"
            class="rl-icon-btn rl-icon-btn--sm rl-jed-action"
            data-testid="rl-json-delete"
            title="Delete operation"
            aria-label="Delete operation"
            onClick={ops.remove}
          >
            <Icon name="trash" size={12} />
          </button>
        </span>
      </div>
      {expanded && (
        <div class="rl-jed-card__body rl-gql-op-card__body">
          <GraphqlOperation node={node} path={[index]} depth={1} ctx={ctx} />
        </div>
      )}
    </div>
  );
});
