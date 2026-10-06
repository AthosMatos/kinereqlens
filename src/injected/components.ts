/**
 * Component lookup in the page (MAIN world), for the Initiator tab's "which component is this" (src/shared/
 * initiator-protocol.ts). Runs only when the overlay panel asks, through the private port (`{t:'components'}`);
 * page messages cannot start it. Finds React / Preact / Vue 3 roots from the DOM (and React's devtools hook),
 * walks their trees for the requested names (src/lib/component-tree.ts) and measures the instances' host
 * elements; optionally scrolls the first instance into view first. Never throws into the page.
 */
import type { ComponentFramework, ComponentInstance, ComponentLocateResult, ComponentRect } from '../shared/initiator-protocol';
import { COMPONENT_MAX_INSTANCES, COMPONENT_MAX_NAMES, COMPONENT_NAME_MAX, COMPONENT_PATH_MAX } from '../shared/initiator-protocol';
import type { FoundComponent, RootMarker, TreeAdapter, TreeEnv } from '../lib/component-tree';
import {
  findComponents,
  preactAdapter,
  prop,
  reactAdapter,
  reactFiberKey,
  reactRootOf,
  rootMarkersOf,
  vueAdapter,
} from '../lib/component-tree';
import { call, isArray, objectKeys, W } from './natives';

/** Elements scanned for root markers. */
const MAX_SCANNED_ELEMENTS = 40_000;
const MAX_ROOTS = 32;

const NativeElement = typeof Element === 'function' ? Element : undefined;
const getRect = NativeElement ? NativeElement.prototype.getBoundingClientRect : undefined;
const scrollIntoViewFn = NativeElement ? NativeElement.prototype.scrollIntoView : undefined;
const querySelectorAllFn = typeof Document === 'function' ? Document.prototype.querySelectorAll : undefined;

const env: TreeEnv = {
  isElement: (node) => {
    try {
      return !!NativeElement && node instanceof NativeElement;
    } catch {
      return false;
    }
  },
};

function keysOf(obj: object): string[] {
  try {
    return objectKeys(obj);
  } catch {
    return [];
  }
}

/** Roots of every supported framework on the page, deduplicated. */
function discoverRoots(): RootMarker[] {
  const roots: RootMarker[] = [];
  const seen = new Set<object>();
  const add = (marker: RootMarker) => {
    if (roots.length >= MAX_ROOTS || seen.has(marker.root)) return;
    seen.add(marker.root);
    roots.push(marker);
  };
  // React DevTools' global hook (present when the DevTools extension or a dev setup installed it).
  try {
    const hook = prop(W, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
    const getFiberRoots = prop(hook, 'getFiberRoots');
    const renderers = prop(hook, 'renderers');
    if (typeof getFiberRoots === 'function' && renderers && typeof (renderers as Map<unknown, unknown>).forEach === 'function') {
      (renderers as Map<unknown, unknown>).forEach((_r, id) => {
        try {
          const set = call<Set<unknown>>(getFiberRoots, hook, [id]);
          set?.forEach((fiberRoot) => {
            const root = reactRootOf(fiberRoot);
            if (root) add({ framework: 'react', root });
          });
        } catch {
          /* renderer without roots */
        }
      });
    }
  } catch {
    /* no hook */
  }
  let elements: ArrayLike<Element> = [];
  try {
    elements = querySelectorAllFn ? call<NodeListOf<Element>>(querySelectorAllFn, document, ['*']) : document.querySelectorAll('*');
  } catch {
    elements = [];
  }
  let fiberHost: { el: Element; key: string } | null = null;
  const count = Math.min(elements.length, MAX_SCANNED_ELEMENTS);
  for (let i = 0; i < count && roots.length < MAX_ROOTS; i++) {
    const el = elements[i]!;
    const keys = keysOf(el);
    if (keys.length === 0) continue;
    for (const marker of rootMarkersOf(el, keys)) add(marker);
    if (!fiberHost) {
      const key = reactFiberKey(keys);
      if (key) fiberHost = { el, key };
    }
  }
  // A React tree mounted without a marked container (portals, legacy roots): climb from any host fiber.
  if (fiberHost && !roots.some((r) => r.framework === 'react')) {
    const root = reactRootOf(prop(fiberHost.el, fiberHost.key));
    if (root) add({ framework: 'react', root });
  }
  return roots;
}

function adapterFor(framework: ComponentFramework): TreeAdapter {
  return framework === 'react' ? reactAdapter(env) : framework === 'preact' ? preactAdapter(env) : vueAdapter(env);
}

function rectOf(el: unknown): ComponentRect | null {
  if (!getRect || !env.isElement(el)) return null;
  try {
    const r = call<DOMRect>(getRect, el);
    if (!(r.width > 0 || r.height > 0)) return null;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  } catch {
    return null;
  }
}

function unionRect(hosts: unknown[]): ComponentRect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const host of hosts) {
    const r = rectOf(host);
    if (!r) continue;
    left = Math.min(left, r.x);
    top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.width);
    bottom = Math.max(bottom, r.y + r.height);
  }
  return Number.isFinite(left) ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

function scrollToFirst(found: FoundComponent[]): void {
  if (!scrollIntoViewFn) return;
  for (const entry of found) {
    for (const instance of entry.instances) {
      const el = instance.hosts.find((h) => rectOf(h));
      if (el) {
        try {
          call(scrollIntoViewFn, el, [{ block: 'center', inline: 'nearest', behavior: 'instant' }]);
        } catch {
          /* detached */
        }
        return;
      }
    }
  }
}

/** Answer a `{t:'components'}` request. `names` / `scroll` are re-checked here (the port is private, but cheap). */
export function locateComponents(names: unknown, scroll: unknown): ComponentLocateResult {
  const wanted: string[] = [];
  if (isArray(names)) {
    for (const n of names) {
      if (wanted.length >= COMPONENT_MAX_NAMES) break;
      if (typeof n === 'string' && n && n.length <= COMPONENT_NAME_MAX && !wanted.includes(n)) wanted.push(n);
    }
  }
  try {
    const roots = discoverRoots();
    const frameworks: ComponentFramework[] = [];
    const found: FoundComponent[] = [];
    for (const { framework, root } of roots) {
      if (!frameworks.includes(framework)) frameworks.push(framework);
      try {
        findComponents(adapterFor(framework), [root], wanted, found, { maxNodes: 200_000, maxInstances: COMPONENT_MAX_INSTANCES, maxHosts: 64 });
      } catch {
        /* a broken tree: the others still count */
      }
    }
    if (scroll === true) scrollToFirst(found);
    const matches = wanted.map((name, i) => {
      const entry = found[i] ?? { name, count: 0, instances: [] };
      const instances: ComponentInstance[] = entry.instances.map((inst) => ({
        path: inst.path.slice(-COMPONENT_PATH_MAX),
        rect: unionRect(inst.hosts),
      }));
      return { name, count: entry.count, instances };
    });
    return { frameworks, matches };
  } catch (error) {
    return { frameworks: [], matches: wanted.map((name) => ({ name, count: 0, instances: [] })), error: String(error).slice(0, 200) };
  }
}
