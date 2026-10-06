/**
 * Component tree walking for the Initiator tab (bundled into hook.js, MAIN world; pure otherwise — DOM access
 * comes in through `TreeEnv`, so the walkers are unit-tested with mocked trees).
 *
 * Given component names, find their mounted instances in a React fiber tree, a Preact vnode tree or a Vue 3
 * vnode tree, with the named component path from the root ("App > ReportsPage > ReportList") and the host
 * (DOM) nodes each instance renders. Everything here reads page-owned objects: every access is guarded and
 * the walks are bounded (visited nodes, host nodes per instance, instances per name).
 */
import type { ComponentFramework } from '../shared/initiator-protocol';

/** Host environment: DOM node checks. */
export interface TreeEnv {
  /** True for an Element (nodeType 1). */
  isElement(node: unknown): boolean;
}

/** A framework tree, abstracted. */
export interface TreeAdapter {
  framework: ComponentFramework;
  /** Child nodes (in order). */
  children(node: object): object[];
  /** Component name of a composite node, null for host / text / fragment / internal nodes. */
  name(node: object): string | null;
  /** The DOM node of a host node, else null (do not descend further below a host node). */
  host(node: object): unknown;
}

export interface FoundInstance {
  path: string[];
  hosts: unknown[];
}

export interface FoundComponent {
  name: string;
  count: number;
  instances: FoundInstance[];
}

export interface WalkLimits {
  /** Nodes visited per root. */
  maxNodes: number;
  /** Instances reported per name (count keeps counting). */
  maxInstances: number;
  /** Host nodes collected per instance. */
  maxHosts: number;
}

export const DEFAULT_WALK_LIMITS: WalkLimits = { maxNodes: 200_000, maxInstances: 50, maxHosts: 64 };

/** Read a property without letting a throwing getter / Proxy escape. */
export function prop(obj: unknown, key: string): unknown {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** `Memo(ReportList)` / `ForwardRef(ReportList)` / `withRouter(ReportList)` → ReportList. */
export function unwrapName(name: string): string {
  let n = name;
  for (let i = 0; i < 4; i++) {
    const m = /^[\w$.]+\((.+)\)$/.exec(n);
    if (!m) break;
    n = m[1]!;
  }
  return n;
}

/** Name of a component function / class / exotic object (memo, forwardRef). */
function typeName(type: unknown, depth = 0): string | null {
  if (depth > 3) return null;
  if (typeof type === 'function') return str(prop(type, 'displayName')) ?? str(prop(type, 'name'));
  if (type && typeof type === 'object') {
    const display = str(prop(type, 'displayName'));
    if (display) return display;
    // forwardRef: {render}, memo: {type}, lazy: {_payload}
    const render = prop(type, 'render');
    if (typeof render === 'function') return typeName(render, depth + 1);
    const inner = prop(type, 'type');
    if (inner && inner !== type) return typeName(inner, depth + 1);
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ adapters

/** React fibers (tag 5 = HostComponent; composite = function / class / forwardRef / memo). */
export function reactAdapter(env: TreeEnv): TreeAdapter {
  return {
    framework: 'react',
    children(node) {
      const out: object[] = [];
      let child = prop(node, 'child');
      for (let guard = 0; child && typeof child === 'object' && guard < 10_000; guard++) {
        out.push(child);
        child = prop(child, 'sibling');
      }
      return out;
    },
    name(node) {
      const type = prop(node, 'type');
      if (typeof type === 'string' || type === null || type === undefined) return null;
      const tag = prop(node, 'tag');
      // 0 Function, 1 Class, 11 ForwardRef, 14 Memo, 15 SimpleMemo (2 = indeterminate in React ≤ 18).
      if (typeof tag === 'number' && ![0, 1, 2, 11, 14, 15].includes(tag)) return null;
      return typeName(type);
    },
    host(node) {
      if (typeof prop(node, 'type') !== 'string') return null;
      const el = prop(node, 'stateNode');
      return env.isElement(el) ? el : null;
    },
  };
}

/** Preact 10 vnodes (mangled `__k` children / `__e` DOM; unmangled `_children` / `_dom` too). */
export function preactAdapter(env: TreeEnv): TreeAdapter {
  return {
    framework: 'preact',
    children(node) {
      const kids = prop(node, '__k') ?? prop(node, '_children');
      if (!Array.isArray(kids)) return [];
      return kids.filter((k): k is object => !!k && typeof k === 'object');
    },
    name(node) {
      const type = prop(node, 'type');
      return typeof type === 'function' ? typeName(type) : null;
    },
    host(node) {
      if (typeof prop(node, 'type') !== 'string') return null;
      const el = prop(node, '__e') ?? prop(node, '_dom');
      return env.isElement(el) ? el : null;
    },
  };
}

/** Vue 3 vnodes: component vnodes (`component.subTree`), element / fragment children, suspense branches. */
export function vueAdapter(env: TreeEnv): TreeAdapter {
  return {
    framework: 'vue',
    children(node) {
      const component = prop(node, 'component');
      if (component && typeof component === 'object') {
        const sub = prop(component, 'subTree');
        return sub && typeof sub === 'object' ? [sub] : [];
      }
      const suspense = prop(node, 'suspense');
      if (suspense && typeof suspense === 'object') {
        const active = prop(suspense, 'activeBranch');
        if (active && typeof active === 'object') return [active];
      }
      const kids = prop(node, 'children');
      if (Array.isArray(kids)) return kids.filter((k): k is object => !!k && typeof k === 'object' && 'type' in k);
      return [];
    },
    name(node) {
      const component = prop(node, 'component');
      if (!component || typeof component !== 'object') return null;
      const type = prop(node, 'type');
      const file = str(prop(type, '__file'));
      return (
        str(prop(type, 'name')) ??
        str(prop(type, '__name')) ??
        str(prop(type, 'displayName')) ??
        (file ? (file.split('/').pop() ?? '').replace(/\.\w+$/, '') || null : null)
      );
    },
    host(node) {
      if (typeof prop(node, 'type') !== 'string') return null;
      const el = prop(node, 'el');
      return env.isElement(el) ? el : null;
    },
  };
}

// ------------------------------------------------------------------------------------------------ walk

/** A name worth showing in a component path. */
function isPathName(name: string): boolean {
  // PascalCase with a lower-case letter: minified internals ("S", "S2", "k") stay out of the path.
  return /^[A-Z][\w$]*[a-z][\w$]*$/.test(unwrapName(name));
}

/** Names of the composite ancestors of `node` (root first), via the parent map. */
function pathOf(adapter: TreeAdapter, parents: Map<object, object | null>, node: object): string[] {
  const names: string[] = [];
  let cur: object | null | undefined = node;
  for (let guard = 0; cur && guard < 5000; guard++) {
    const n = adapter.name(cur);
    if (n && isPathName(n)) {
      const clean = unwrapName(n);
      // memo / forwardRef wrappers produce the same name twice in a row.
      if (names[names.length - 1] !== clean) names.push(clean);
    }
    cur = parents.get(cur);
  }
  return names.reverse();
}

/** Nearest composite ancestor name (exclusive). */
function parentComponentName(adapter: TreeAdapter, parents: Map<object, object | null>, node: object): string | null {
  let cur = parents.get(node);
  for (let guard = 0; cur && guard < 5000; guard++) {
    const n = adapter.name(cur);
    if (n) return unwrapName(n);
    cur = parents.get(cur);
  }
  return null;
}

/** Top-most host nodes under `node` (the DOM an instance renders); the node itself when it is a host node. */
export function hostNodesOf(adapter: TreeAdapter, node: object, max: number): unknown[] {
  const own = adapter.host(node);
  if (own) return [own];
  const out: unknown[] = [];
  const stack: object[] = adapter.children(node).reverse();
  let visited = 0;
  while (stack.length && out.length < max && visited < 50_000) {
    const cur = stack.pop()!;
    visited++;
    const host = adapter.host(cur);
    if (host) {
      out.push(host);
      continue;
    }
    const kids = adapter.children(cur);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out;
}

/**
 * Find the instances of `names` (exact or wrapper-unwrapped match) under `roots`. Results are merged into
 * `found` (one entry per name, same order as `names`).
 */
export function findComponents(
  adapter: TreeAdapter,
  roots: readonly object[],
  names: readonly string[],
  found: FoundComponent[],
  limits: WalkLimits = DEFAULT_WALK_LIMITS,
): void {
  const wanted = new Map<string, FoundComponent>();
  names.forEach((name, i) => {
    let entry = found[i];
    if (!entry) {
      entry = { name, count: 0, instances: [] };
      found[i] = entry;
    }
    wanted.set(name, entry);
  });
  for (const root of roots) {
    const parents = new Map<object, object | null>();
    parents.set(root, null);
    const stack: object[] = [root];
    let visited = 0;
    while (stack.length && visited < limits.maxNodes) {
      const node = stack.pop()!;
      visited++;
      const raw = adapter.name(node);
      if (raw) {
        const name = unwrapName(raw);
        const entry = wanted.get(name) ?? wanted.get(raw);
        // A memo / forwardRef wrapper and its inner function are one instance.
        if (entry && parentComponentName(adapter, parents, node) !== name) {
          entry.count++;
          if (entry.instances.length < limits.maxInstances) {
            entry.instances.push({ path: pathOf(adapter, parents, node), hosts: hostNodesOf(adapter, node, limits.maxHosts) });
          }
        }
      }
      const kids = adapter.children(node);
      for (let i = kids.length - 1; i >= 0; i--) {
        const kid = kids[i]!;
        if (parents.has(kid)) continue;
        parents.set(kid, node);
        stack.push(kid);
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ roots

/** React: the current HostRoot fiber of a root container / FiberRoot / any fiber. */
export function reactRootOf(value: unknown): object | null {
  // FiberRoot (devtools hook) / container value: {current: HostRootFiber}
  const current = prop(value, 'current');
  if (current && typeof current === 'object' && prop(current, 'tag') === 3) return current;
  // Legacy root container: {_internalRoot: FiberRoot}
  const internal = prop(value, '_internalRoot');
  if (internal) return reactRootOf(internal);
  // A fiber: climb to the HostRoot, then its FiberRoot's current tree.
  let fiber: unknown = value;
  for (let guard = 0; fiber && typeof fiber === 'object' && guard < 10_000; guard++) {
    const parent = prop(fiber, 'return');
    if (!parent) break;
    fiber = parent;
  }
  if (fiber && typeof fiber === 'object' && prop(fiber, 'tag') === 3) {
    const root = prop(fiber, 'stateNode');
    const cur = prop(root, 'current');
    return cur && typeof cur === 'object' ? cur : fiber;
  }
  return null;
}

/** Kinds of root markers found on DOM elements. */
export type RootMarker = { framework: ComponentFramework; root: object };

/** The React fiber property of a host element (`__reactFiber$…` / `__reactInternalInstance$…`), or null. */
export function reactFiberKey(keys: readonly string[]): string | null {
  for (const key of keys) if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return key;
  return null;
}

/**
 * Root markers of one element from its own property names: React containers (`__reactContainer$…`,
 * `_reactRootContainer`), Preact render containers (`__k` / `_children` vnode), Vue 3 apps (`__vue_app__`).
 * Fiber keys of host elements are left to `reactFiberKey` (climbing from every element would be quadratic).
 */
export function rootMarkersOf(el: object, keys: readonly string[]): RootMarker[] {
  const out: RootMarker[] = [];
  for (const key of keys) {
    if (key.startsWith('__reactContainer$') || key === '_reactRootContainer') {
      const root = reactRootOf(prop(el, key));
      if (root) out.push({ framework: 'react', root });
    } else if (key === '__k' || key === '_children') {
      const vnode = prop(el, key);
      if (vnode && typeof vnode === 'object' && !Array.isArray(vnode) && 'type' in vnode) out.push({ framework: 'preact', root: vnode });
    } else if (key === '__vue_app__') {
      const instance = prop(prop(el, key), '_instance');
      const vnode = prop(instance, 'vnode');
      if (vnode && typeof vnode === 'object') out.push({ framework: 'vue', root: vnode });
    }
  }
  return out;
}
