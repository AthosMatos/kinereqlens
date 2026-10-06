import { describe, expect, it } from 'vitest';
import {
  findComponents,
  hostNodesOf,
  preactAdapter,
  reactAdapter,
  reactFiberKey,
  reactRootOf,
  rootMarkersOf,
  unwrapName,
  vueAdapter,
} from '../../src/lib/component-tree';
import type { FoundComponent, TreeEnv } from '../../src/lib/component-tree';
import { sanitizeComponentLocateResult, sanitizeComponentQuery } from '../../src/shared/initiator-protocol';
import { cleanHookStart } from '../../src/content/validate';
import { entryFromHookStart, isValidHookStart, PRESERVED_STACK_CAP, toPreserved } from '../../src/lib/capture';
import type { HookRequestStart } from '../../src/shared/types';

/** Fake DOM element. */
class El {
  constructor(readonly tag: string) {}
}
const env: TreeEnv = { isElement: (n) => n instanceof El };

// ------------------------------------------------------------------------------------------------ React mock

interface Fiber {
  tag: number;
  type: unknown;
  stateNode: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
}

function fiber(tag: number, type: unknown, children: Fiber[] = [], stateNode: unknown = null): Fiber {
  const f: Fiber = { tag, type, stateNode, child: null, sibling: null, return: null };
  children.forEach((c, i) => {
    c.return = f;
    if (i === 0) f.child = c;
    else children[i - 1]!.sibling = c;
  });
  return f;
}
const host = (tag: string, children: Fiber[] = []) => fiber(5, tag, children, new El(tag));
const fn = (name: string): (() => null) => {
  const f = () => null;
  Object.defineProperty(f, 'name', { value: name });
  return f;
};

function reactTree() {
  const ReportList = fn('ReportList');
  const memoList = { $$typeof: Symbol.for('react.memo'), type: ReportList };
  const row1 = host('li');
  const row2 = host('li');
  const list = host('ul', [row1, row2]);
  // memo(ReportList): MemoComponent (14) wrapping the inner function component (0)
  const inner = fiber(0, ReportList, [list]);
  const memo = fiber(14, memoList, [inner]);
  const second = fiber(0, ReportList, [host('p')]);
  const page = fiber(0, fn('ReportsPage'), [host('section', [memo]), fiber(11, { render: fn('Toolbar') }, [host('nav')])]);
  const anon = fiber(0, fn(''), [second]);
  const app = fiber(0, fn('App'), [page, anon]);
  const root = fiber(3, null, [app]);
  root.stateNode = { current: root };
  return { root, list, row1, inner };
}

describe('React fiber walking', () => {
  it('finds instances with their component path and host nodes; memo wrappers count once', () => {
    const { root, list } = reactTree();
    const found: FoundComponent[] = [];
    findComponents(reactAdapter(env), [root], ['ReportList', 'Toolbar', 'Missing'], found);
    expect(found[0]!.count).toBe(2);
    expect(found[0]!.instances[0]!.path).toEqual(['App', 'ReportsPage', 'ReportList']);
    expect(found[0]!.instances[0]!.hosts).toEqual([list.stateNode]);
    expect(found[0]!.instances[1]!.path).toEqual(['App', 'ReportList']);
    expect(found[1]).toMatchObject({ name: 'Toolbar', count: 1 });
    expect(found[1]!.instances[0]!.path).toEqual(['App', 'ReportsPage', 'Toolbar']);
    expect(found[2]).toEqual({ name: 'Missing', count: 0, instances: [] });
  });

  it('respects the instance and node limits', () => {
    const { root } = reactTree();
    const found: FoundComponent[] = [];
    findComponents(reactAdapter(env), [root], ['ReportList'], found, { maxNodes: 1_000, maxInstances: 1, maxHosts: 64 });
    expect(found[0]).toMatchObject({ count: 2 });
    expect(found[0]!.instances).toHaveLength(1);
    const few: FoundComponent[] = [];
    findComponents(reactAdapter(env), [root], ['ReportList'], few, { maxNodes: 3, maxInstances: 5, maxHosts: 64 });
    expect(few[0]!.count).toBe(0);
  });

  it('finds the root from a container, a FiberRoot, a legacy root or any fiber', () => {
    const { root, row1 } = reactTree();
    const fiberRoot = root.stateNode as { current: Fiber };
    expect(reactRootOf(fiberRoot)).toBe(root);
    expect(reactRootOf({ _internalRoot: fiberRoot })).toBe(root);
    expect(reactRootOf(row1)).toBe(root);
    expect(reactRootOf(root)).toBe(root);
    expect(reactRootOf(null)).toBeNull();
    const container = { '__reactContainer$abc': root, other: 1 };
    expect(rootMarkersOf(container, Object.keys(container))).toEqual([{ framework: 'react', root }]);
    expect(reactFiberKey(['x', '__reactFiber$q1', '__reactProps$q1'])).toBe('__reactFiber$q1');
    expect(reactFiberKey(['x'])).toBeNull();
  });

  it('survives throwing getters and cycles', () => {
    const evil = {
      tag: 0,
      get type() {
        throw new Error('nope');
      },
      child: null,
      sibling: null,
    };
    const root = fiber(3, null, []);
    root.child = evil as unknown as Fiber;
    const found: FoundComponent[] = [];
    expect(() => findComponents(reactAdapter(env), [root], ['X'], found)).not.toThrow();
    const a = fiber(0, fn('Loop'));
    a.child = a;
    const loop: FoundComponent[] = [];
    findComponents(reactAdapter(env), [a], ['Loop'], loop);
    expect(loop[0]!.count).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ Preact mock

describe('Preact vnode walking (mangled internals)', () => {
  it('walks __k children and reads __e DOM nodes', () => {
    const Fragment = fn('S');
    const ul = new El('ul');
    const listVnode = { type: 'ul', __k: [{ type: null, __k: null, __e: {} }], __e: ul };
    const ReportList = fn('ReportList');
    const comp = { type: ReportList, __k: [listVnode], __e: ul };
    const memoList = { type: Object.assign(fn('Memo'), { displayName: 'Memo(ReportList)' }), __k: [comp], __e: ul };
    const page = { type: fn('ReportsPage'), __k: [{ type: 'main', __k: [memoList, null], __e: new El('main') }] };
    const app = { type: fn('App'), __k: [page] };
    const root = { type: Fragment, __k: [app] };
    const container = { __k: root };
    const markers = rootMarkersOf(container, Object.keys(container));
    expect(markers).toEqual([{ framework: 'preact', root }]);
    const found: FoundComponent[] = [];
    findComponents(preactAdapter(env), [root], ['ReportList'], found);
    expect(found[0]!.count).toBe(1);
    expect(found[0]!.instances[0]!.path).toEqual(['App', 'ReportsPage', 'ReportList']);
    expect(found[0]!.instances[0]!.hosts).toEqual([ul]);
    expect(hostNodesOf(preactAdapter(env), page, 10)).toHaveLength(1);
  });

  it('supports unmangled _children / _dom too', () => {
    const div = new El('div');
    const root = { type: fn('S'), _children: [{ type: fn('Widget'), _children: [{ type: 'div', _dom: div, _children: [] }] }] };
    const found: FoundComponent[] = [];
    findComponents(preactAdapter(env), [root], ['Widget'], found);
    expect(found[0]!.instances[0]!.hosts).toEqual([div]);
  });
});

// ------------------------------------------------------------------------------------------------ Vue mock

describe('Vue 3 vnode walking', () => {
  it('follows component subTrees, element children and SFC names', () => {
    const li = new El('li');
    const ul = new El('ul');
    const reportList = { type: { __name: 'ReportList' }, component: { subTree: { type: 'ul', el: ul, children: [{ type: 'li', el: li, children: 'x' }] } } };
    const fragment = { type: Symbol('Fragment'), children: [reportList] };
    const page = { type: { name: 'ReportsPage' }, component: { subTree: fragment } };
    const app = { type: { __file: '/src/App.vue' }, component: { subTree: { type: 'div', el: new El('div'), children: [page] } } };
    const container = { __vue_app__: { _instance: { vnode: app } } };
    const markers = rootMarkersOf(container, Object.keys(container));
    expect(markers).toEqual([{ framework: 'vue', root: app }]);
    const found: FoundComponent[] = [];
    findComponents(vueAdapter(env), [app], ['ReportList', 'App'], found);
    expect(found[0]!.instances[0]!.path).toEqual(['App', 'ReportsPage', 'ReportList']);
    expect(found[0]!.instances[0]!.hosts).toEqual([ul]);
    expect(found[1]!.count).toBe(1);
  });
});

describe('names', () => {
  it('unwraps HOC display names', () => {
    expect(unwrapName('Memo(ReportList)')).toBe('ReportList');
    expect(unwrapName('withRouter(Connect(ReportList))')).toBe('ReportList');
    expect(unwrapName('ReportList')).toBe('ReportList');
  });
});

// ------------------------------------------------------------------------------------------------ protocol

describe('component protocol sanitizers', () => {
  it('cleans queries', () => {
    expect(sanitizeComponentQuery({ names: ['A1', 'A1', 'bad name', '<x>', 7, 'B'], scroll: 1, highlight: true })).toEqual({
      names: ['A1', 'B'],
      scroll: false,
      highlight: true,
    });
    expect(sanitizeComponentQuery(null)).toEqual({ names: [], scroll: false, highlight: false });
  });

  it('rebuilds untrusted results for the queried names only', () => {
    const query = { names: ['ReportList', 'Other'], scroll: false, highlight: false };
    const raw = {
      frameworks: ['react', 'angular', 'preact'],
      matches: [
        { name: 'Injected', count: 5, instances: [] },
        {
          name: 'ReportList',
          count: 1e12,
          instances: [{ path: ['App', 7, 'x'.repeat(500)], rect: { x: 1, y: 2, width: -5, height: Infinity } }, 'junk', { path: 'App', rect: { x: 1, y: 2, width: 3, height: 4 } }],
        },
      ],
      error: 'e'.repeat(1000),
      extra: '<script>',
    };
    const clean = sanitizeComponentLocateResult(raw, query);
    expect(clean.frameworks).toEqual(['react', 'preact']);
    expect(clean.matches.map((m) => m.name)).toEqual(['ReportList', 'Other']);
    expect(clean.matches[0]!.count).toBe(1e6);
    expect(clean.matches[0]!.instances).toEqual([
      { path: ['App', 'x'.repeat(200)], rect: null },
      { path: [], rect: { x: 1, y: 2, width: 3, height: 4 } },
    ]);
    expect(clean.matches[1]).toEqual({ name: 'Other', count: 0, instances: [] });
    expect(clean.error).toHaveLength(500);
    expect('extra' in clean).toBe(false);
  });
});

describe('initiator stacks in captures', () => {
  const start: HookRequestStart = {
    hookId: '1abc',
    kind: 'fetch',
    method: 'GET',
    url: 'https://x.test/api',
    headers: [],
    body: null,
    contentType: null,
    startTime: 1,
    frameUrl: 'https://x.test/',
  };

  it('validates, caps (line boundary) and carries the stack into the entry and the preserved log', () => {
    const long = Array.from({ length: 400 }, (_, i) => `at f${i} (https://x.test/a.js:${i}:1)`).join('\n');
    expect(isValidHookStart({ ...start, initiatorStack: long })).toBe(true);
    expect(isValidHookStart({ ...start, initiatorStack: 42 })).toBe(false);
    const clean = cleanHookStart({ ...start, initiatorStack: long }, (b) => b);
    expect(clean.initiatorStack!.length).toBeLessThanOrEqual(8 * 1024);
    expect(clean.initiatorStack!.endsWith(':1)')).toBe(true);
    expect(cleanHookStart({ ...start, initiatorStack: 5 as unknown as string }, (b) => b).initiatorStack).toBeUndefined();
    const entry = entryFromHookStart(0, clean, 'https://x.test/');
    expect(entry.initiatorStack).toBe(clean.initiatorStack);
    const preserved = toPreserved(entry, 1000);
    expect(preserved.initiatorStack!.length).toBeLessThanOrEqual(PRESERVED_STACK_CAP);
    expect(entryFromHookStart(0, start, '').initiatorStack).toBeUndefined();
  });
});
