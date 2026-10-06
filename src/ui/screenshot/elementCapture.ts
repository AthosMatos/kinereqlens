// Element captures with a padding, panel side: locate an element on the page (findElements: a CSS selector, a visible
// text / label, a response value), capture it with the padding (engine.ts captureArea: the overlay is hidden only while
// it covers the area) and keep it in the screenshot tool's recent captures. Used by the MCP `screenshot` /
// `find_in_page` handlers (src/ui/control/shot.ts), the response viewer's camera button and the result view's padding
// control (a capture again when the padding grows past what was captured).
//
// One command at a time (serialize): two captures would fight over the page's scroll position and the overlay.
import type { ElementMatch, ElementQuery, ElementQueryResult, ElementValueQuery } from '../../shared/find-protocol';
import { ELEMENT_MATCHES_MAX } from '../../shared/find-protocol';
import { DEFAULT_SHOT_PADDING, SHOT_PADDING_MAX } from '../../shared/screenshot-protocol';
import type { ReqlensBridge } from '../../shared/types';
import { pickMatch } from '../../lib/elementLocate';
import { sanitizePadding } from '../../lib/elementShot';
import type { OutputScale } from '../../lib/screenshot';
import type { FindHost } from '../find/controller';
import { localeHintsOf } from '../find/locales';
import { captureArea, createShotBackend, withTimeout } from './engine';
import type { AreaCapture, AreaTarget, ShotHost } from './engine';
import { openShotInView } from './open';
import type { ControlHost } from './open';
import { addShot, getShot, replaceShotArea } from './store';
import type { ShotItem } from './store';

/** A page scan for elements that has not answered after this long fails. */
export const LOCATE_ELEMENTS_TIMEOUT_MS = 20_000;
export const HIDDEN_TAB_ERROR = 'The tab is not visible (another tab is in front, or its window is minimized) — bring it to the front and try again';

/** The page cannot be captured (nor shown to the user) while its tab is hidden. */
export function tabHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

let queue: Promise<unknown> = Promise.resolve();

/** Run `fn` after the commands queued before it (each waits for the previous one to finish, failed or not). */
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** The user's default padding (settings.shotPadding). */
export function defaultPadding(bridge: Pick<ReqlensBridge, 'getSettings'> | null): number {
  try {
    return sanitizePadding(bridge?.getSettings().shotPadding, DEFAULT_SHOT_PADDING, SHOT_PADDING_MAX);
  } catch {
    return DEFAULT_SHOT_PADDING;
  }
}

/** Locator part of an ElementQuery (limit and locales are added here). */
export type ElementLocatorQuery = Pick<ElementQuery, 'selector' | 'text' | 'value' | 'exact'>;

/** findElements over the panel connection, with the "Site language" locales and a timeout. Throws on errors. */
export async function findElements(host: FindHost & Pick<ReqlensBridge, 'getSettings' | 'getCaptureInfo'>, locator: ElementLocatorQuery, limit: number): Promise<ElementQueryResult> {
  const query: ElementQuery = { ...locator, limit: Math.min(ELEMENT_MATCHES_MAX, Math.max(1, Math.round(limit))), locales: localeHintsOf(host) };
  const result = await withTimeout(host.find('findElements', query), LOCATE_ELEMENTS_TIMEOUT_MS, 'The page did not answer in time');
  if (!result || typeof result !== 'object') throw new Error('The page did not answer');
  if (result.error) throw new Error(result.error);
  return result;
}

/** The match a command works on, with the others. */
export interface LocatedElement {
  match: ElementMatch;
  index: number;
  matches: ElementMatch[];
  total: number;
}

/** Locate and choose: `index` when given, else the first visible match. Throws an Error for the user. */
export async function locateOne(host: FindHost & Pick<ReqlensBridge, 'getSettings' | 'getCaptureInfo'>, locator: ElementLocatorQuery, index?: number, limit = 20): Promise<LocatedElement> {
  const result = await findElements(host, locator, Math.max(limit, (index ?? 0) + 1));
  const picked = pickMatch(result.matches, result.total, index);
  if ('error' in picked) throw new Error(picked.error === 'No element matches' ? `No element on the page matches ${describeLocator(locator)}` : picked.error);
  return { match: result.matches[picked.index]!, index: picked.index, matches: result.matches, total: result.total };
}

/** "text “Save”", "selector .btn", "value 1258291" (messages, labels). */
export function describeLocator(locator: ElementLocatorQuery): string {
  const quote = (s: string) => `“${s.length > 60 ? `${s.slice(0, 59)}…` : s}”`;
  if (locator.selector !== undefined) return `the selector ${quote(locator.selector)}`;
  if (locator.text !== undefined) return `the text ${quote(locator.text)}`;
  if (locator.value !== undefined) return `the value ${quote(locator.value.value)}`;
  return 'the locator';
}

export interface ElementShotOptions {
  padding: number;
  /** Shown in the result view's meta line. */
  label?: string;
  output?: OutputScale;
  onProgress?(done: number, total: number): void;
}

/**
 * Capture a located element (or a page region) with a padding — the overlay is hidden only while it covers the area,
 * the page must be free (no other capture, Find in page not showing a value) — and add it to the recent captures.
 */
export async function captureTarget(host: ShotHost, target: AreaTarget, opts: ElementShotOptions): Promise<{ item: ShotItem; capture: AreaCapture }> {
  const capture = await captureArea(createShotBackend(host), target, {
    padding: opts.padding,
    hideOverlay: 'auto',
    exclusive: true,
    ...(opts.output ? { output: opts.output } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  if (opts.label) capture.label = opts.label;
  return { item: await addShot(capture), capture };
}

/** A short label of a match for the result view: its selector, else its tag. */
export function matchLabel(match: Pick<ElementMatch, 'selector' | 'tag'>): string {
  const text = match.selector || match.tag;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * The response viewer's camera button: the element showing `value` on the page (the first visible one), captured with
 * the default padding, opened in the Screenshot view. `label`: the value's JSON path.
 */
export function captureValueShot(host: ControlHost, value: ElementValueQuery, label: string): Promise<ShotItem> {
  return serialize(async () => {
    if (tabHidden()) throw new Error(HIDDEN_TAB_ERROR);
    const located = await locateOne(host, { value });
    if (!located.match.visible) throw new Error('The value is on the page, but not visible right now');
    const { item } = await captureTarget(host, { kind: 'element', ref: located.match.ref }, { padding: defaultPadding(host), label: label || matchLabel(located.match) });
    openShotInView(item.id);
    return item;
  });
}

/**
 * Capture a padded capture's element / region again with `padding` (beyond what the first capture holds); the item
 * keeps its id and annotations. Throws an Error for the user (the element is gone…).
 */
export function recaptureShot(host: ShotHost, id: string, padding: number): Promise<ShotItem | null> {
  return serialize(async () => {
    const item = getShot(id);
    const padded = item?.padded;
    if (!item || !padded) return null;
    if (tabHidden()) throw new Error(HIDDEN_TAB_ERROR);
    const capture = await captureArea(createShotBackend(host), padded.source.target, {
      padding,
      hideOverlay: 'auto',
      exclusive: true,
      output: item.scale === 1 && padded.source.scale === 1 ? 'css' : 'device',
    });
    return replaceShotArea(id, capture);
  });
}
