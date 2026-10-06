// Page-side handles of located elements (ui.js, top frame isolated world): findElements and the screenshot picker hand
// the panel an opaque random id per element instead of the element, and shotElement / findHighlight resolve it again.
// Weak references (a removed element can be collected), dropped after ELEMENT_REF_TTL_MS, at most MAX_REFS kept.
// Only the authenticated panel connection ever receives or sends these ids (frame/server.ts).
import { ELEMENT_REF_TTL_MS } from '../../shared/find-protocol';

const MAX_REFS = 2000;

interface Held {
  el: WeakRef<Element>;
  at: number;
}

const refs = new Map<string, Held>();
const byElement = new WeakMap<Element, string>();

function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `e${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function prune(now: number): void {
  for (const [id, held] of refs) {
    if (now - held.at > ELEMENT_REF_TTL_MS || !held.el.deref()) refs.delete(id);
  }
  // Oldest first (insertion order): drop the excess.
  for (const id of refs.keys()) {
    if (refs.size <= MAX_REFS) break;
    refs.delete(id);
  }
}

/** The handle of `el` (the same one while it is held; a fresh one after it expired). */
export function refOf(el: Element, now = Date.now()): string {
  const known = byElement.get(el);
  if (known) {
    const held = refs.get(known);
    if (held && held.el.deref() === el && now - held.at <= ELEMENT_REF_TTL_MS) {
      // Refreshed: still in use.
      refs.delete(known);
      refs.set(known, { el: held.el, at: now });
      return known;
    }
  }
  const id = newId();
  refs.set(id, { el: new WeakRef(el), at: now });
  byElement.set(el, id);
  if (refs.size > MAX_REFS) prune(now);
  return id;
}

/** The element of a handle, when it is still held and connected to the page. */
export function elementOf(ref: unknown, now = Date.now()): Element | null {
  if (typeof ref !== 'string') return null;
  const held = refs.get(ref);
  if (!held) return null;
  const el = held.el.deref();
  if (!el || now - held.at > ELEMENT_REF_TTL_MS) {
    refs.delete(ref);
    return null;
  }
  return el.isConnected ? el : null;
}

/** Forget every handle (tests; a new page side). */
export function clearRefs(): void {
  refs.clear();
}
