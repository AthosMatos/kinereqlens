// "Where does this come from?", page side (ui.js): a temporary full-viewport layer (closed shadow root, open in the
// E2E build) to pick an element — hover highlight, click picks, ↑ / ↓ parent / child, Esc cancels — and the texts the
// panel then looks for in the captured responses. Started only by the authenticated panel connection; every listener
// it adds is removed when it finishes and the layer leaves the page.
import { normalizeText } from '../../lib/findInPage';
import { FIND_PICK_TAG } from '../../shared/find-protocol';
import type { FindPickResult } from '../../shared/find-protocol';

export interface FindPickerHandle {
  /** Cancel (resolves the pick with null). Idempotent. */
  cancel(): void;
}

/** A pick that is never finished ends by itself. */
const PICK_TIMEOUT_MS = 5 * 60_000;
const MAX_TEXTS = 16;
const MAX_TEXT_CHARS = 300;

const HOST_STYLES: ReadonlyArray<[string, string]> = [
  ['position', 'fixed'],
  ['inset', '0'],
  ['width', 'auto'],
  ['height', 'auto'],
  ['max-width', 'none'],
  ['max-height', 'none'],
  ['margin', '0'],
  ['padding', '0'],
  ['border', '0'],
  ['background', 'transparent'],
  ['overflow', 'visible'],
  ['pointer-events', 'auto'],
  ['z-index', '2147483647'],
  ['display', 'block'],
  ['opacity', '1'],
  ['visibility', 'visible'],
  ['transform', 'none'],
  ['filter', 'none'],
  ['clip-path', 'none'],
  ['zoom', '1'],
  ['color-scheme', 'normal'],
];

const CSS = `:host { all: initial; }
.layer { position: fixed; inset: 0; cursor: crosshair; outline: none; touch-action: none; user-select: none; }
.box { position: fixed; display: none; box-sizing: border-box; pointer-events: none; border-radius: 3px;
  border: 2px solid #0230bb; background: rgba(2, 48, 187, 0.12); box-shadow: 0 0 0 4px rgba(2, 48, 187, 0.15); }
.label { position: fixed; display: none; pointer-events: none; max-width: min(60vw, 420px); padding: 3px 7px; border-radius: 5px;
  background: #0230bb; color: #ffffff; font: 600 11px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); }
.hint { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; gap: 8px; align-items: center;
  max-width: calc(100vw - 32px); padding: 8px 13px; border-radius: 9px; background: rgba(18, 22, 36, 0.94); color: #e8ebf3;
  font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; white-space: nowrap; overflow: hidden;
  pointer-events: none; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(111, 140, 255, 0.35); }
.hint b { color: #8fa6ff; font-weight: 600; }
.kbd { display: inline-block; min-width: 16px; padding: 1px 4px; border: 1px solid rgba(255, 255, 255, 0.3); border-bottom-width: 2px;
  border-radius: 4px; font: 500 10.5px/1.2 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; text-align: center; }`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: Node): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  parent.appendChild(node);
  return node;
}

/** `tag.class` of an element (page data only). */
export function describeElement(target: Element): string {
  const classes = Array.from(target.classList).slice(0, 2);
  const id = target.id ? `#${target.id}` : '';
  return `${target.localName}${id}${classes.map((c) => `.${c}`).join('')}`.slice(0, 80);
}

/**
 * Texts of a picked element, most specific first: its text (text nodes joined with spaces), each distinct text node,
 * the displayed value of a form field (never a password), and alt / title / aria-label / placeholder / href / src.
 */
export function elementTexts(target: Element): string[] {
  const out: string[] = [];
  const push = (text: string | null | undefined) => {
    if (!text) return;
    const norm = normalizeText(text).slice(0, MAX_TEXT_CHARS);
    if (norm && !out.includes(norm) && out.length < MAX_TEXTS) out.push(norm);
  };
  const doc = target.ownerDocument;
  const pieces: string[] = [];
  const walker = doc.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(), i = 0; n && i < 400; n = walker.nextNode(), i++) {
    const parent = n.parentElement?.localName;
    if (parent === 'script' || parent === 'style' || parent === 'template') continue;
    pieces.push((n as Text).data);
  }
  push(pieces.join(' '));
  for (const piece of pieces) push(piece);
  const name = target.localName;
  if (name === 'input') {
    const input = target as HTMLInputElement;
    if (!['password', 'hidden', 'file'].includes((input.type || 'text').toLowerCase())) push(input.value);
  } else if (name === 'textarea') push((target as HTMLTextAreaElement).value);
  else if (name === 'select') push(Array.from((target as HTMLSelectElement).selectedOptions, (o) => o.text).join(' '));
  for (const attr of ['alt', 'title', 'aria-label', 'placeholder']) push(target.getAttribute(attr));
  for (const attr of ['href', 'src']) {
    const raw = target.getAttribute(attr);
    if (!raw || /^\s*(?:data|javascript):/i.test(raw)) continue;
    try {
      push(new URL(raw, doc.baseURI).href);
    } catch {
      push(raw);
    }
  }
  return out;
}

/** What the picker reports (the manager adds the page's locales). */
export type PickedElement = Omit<FindPickResult, 'locales'>;

/** Show the picker. `done` is called exactly once: with the picked element's texts, or null when cancelled. */
export function startFindPicker(done: (result: PickedElement | null) => void, isOwn: (el: Element) => boolean): FindPickerHandle {
  const host = document.createElement(FIND_PICK_TAG);
  for (const [prop, value] of HOST_STYLES) host.style.setProperty(prop, value, 'important');
  const popover = typeof host.showPopover === 'function';
  if (popover) host.popover = 'manual';
  const shadow = host.attachShadow({ mode: __E2E__ ? 'open' : 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);
  const layer = el('div', 'layer', shadow);
  layer.tabIndex = -1;
  layer.dataset.testid = 'rl-find-pick-layer';
  layer.setAttribute('role', 'application');
  layer.setAttribute('aria-label', 'kineReqLens: pick an element to find which response its text comes from');
  const box = el('div', 'box', layer);
  const label = el('div', 'label', layer);
  const hint = el('div', 'hint', layer);
  const hintParts: Array<string | { strong: string } | { key: string }> = [
    { strong: 'Where does this come from?' },
    ' Click an element · ',
    { key: '↑' },
    ' ',
    { key: '↓' },
    ' parent / child · ',
    { key: 'Esc' },
    ' cancel',
  ];
  for (const part of hintParts) {
    if (typeof part === 'string') hint.appendChild(document.createTextNode(part));
    else if ('strong' in part) el('b', '', hint).textContent = part.strong;
    else el('span', 'kbd', hint).textContent = part.key;
  }

  let finished = false;
  let current: Element | null = null;
  let below: Element[] = [];

  const render = () => {
    if (!current) {
      box.style.display = 'none';
      label.style.display = 'none';
      return;
    }
    const r = current.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    const text = normalizeText(current.textContent ?? '');
    label.textContent = text ? `${describeElement(current)} — ${text.slice(0, 60)}` : describeElement(current);
    label.style.display = 'block';
    const lh = label.offsetHeight;
    let top = r.top - lh - 6;
    if (top < 4) top = r.bottom + 6;
    if (top + lh > window.innerHeight - 4) top = Math.max(4, r.top + 4);
    label.style.top = `${top}px`;
    label.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - label.offsetWidth - 4))}px`;
  };

  const hitTest = (x: number, y: number): Element | null => {
    for (const candidate of document.elementsFromPoint(x, y)) {
      if (candidate === host || isOwn(candidate)) continue;
      return candidate;
    }
    return null;
  };

  const finish = (target: Element | null) => {
    if (finished) return;
    finished = true;
    cleanup();
    let result: PickedElement | null = null;
    if (target) {
      try {
        result = { texts: elementTexts(target), label: describeElement(target) };
      } catch {
        result = null;
      }
    }
    try {
      done(result);
    } catch {
      /* caller's problem */
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const next = hitTest(e.clientX, e.clientY);
    if (next === current) return;
    if (current && next && below.length > 0 && current.contains(next)) return;
    below = [];
    current = next;
    render();
  };
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onPointerUp = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;
    if (!current) current = hitTest(e.clientX, e.clientY);
    finish(current);
  };
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    let handled = true;
    if (e.key === 'Escape') finish(null);
    else if (e.key === 'Enter') {
      if (current) finish(current);
    } else if (e.key === 'ArrowUp' && current?.parentElement && current !== document.documentElement) {
      below.push(current);
      current = current.parentElement;
      render();
    } else if (e.key === 'ArrowDown' && current) {
      const back = below.pop();
      const next = back && current.contains(back) ? back : (Array.from(current.children).find((c) => !isOwn(c)) ?? null);
      if (next) {
        current = next;
        render();
      }
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  const onScroll = () => render();
  const onPageHide = () => finish(null);

  layer.addEventListener('pointermove', onPointerMove);
  layer.addEventListener('pointerdown', onPointerDown);
  layer.addEventListener('pointerup', onPointerUp);
  layer.addEventListener('click', swallow);
  layer.addEventListener('contextmenu', swallow);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  window.addEventListener('pagehide', onPageHide);
  const timeout = setTimeout(() => finish(null), PICK_TIMEOUT_MS);

  function cleanup(): void {
    clearTimeout(timeout);
    layer.removeEventListener('pointermove', onPointerMove);
    layer.removeEventListener('pointerdown', onPointerDown);
    layer.removeEventListener('pointerup', onPointerUp);
    layer.removeEventListener('click', swallow);
    layer.removeEventListener('contextmenu', swallow);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('pagehide', onPageHide);
    if (popover) {
      try {
        host.hidePopover();
      } catch {
        /* not shown */
      }
    }
    host.remove();
  }

  (document.documentElement ?? document.body).appendChild(host);
  if (popover) {
    try {
      host.showPopover();
    } catch {
      /* z-index fallback */
    }
  }
  layer.focus({ preventScroll: true });
  return { cancel: () => finish(null) };
}
