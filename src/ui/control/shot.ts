// Panel-side handlers of the MCP `screenshot` and `find_in_page` tools (contract: src/shared/control-shot.ts). They
// drive the same capture engine (src/ui/screenshot/engine.ts) and page scanner (src/ui/frame/findElements.ts) as the
// overlay's own buttons, over the page connection the App registered (src/ui/screenshot/open.ts) — also while the
// overlay is mounted but not shown: nothing here shows it (`open` only switches the panel to the Screenshot view).
//
//  - screenshot: target visible | full | region | element (a locator: CSS selector, visible text / label, response
//    value, or requestId + JSON path). Element / region captures keep `padding` (default settings.shotPadding) around
//    the target and a spare margin for later re-crops in the overlay; the page is scrolled / stitched as needed and
//    restored, the overlay hidden only while it covers what is captured. The capture joins the Screenshot tool's
//    recent captures; `preview` is at most SHOT_PREVIEW_MAX px on its long side.
//  - find_in_page: the matching elements (document order) and, with `highlight`, the chosen one shown on the page the
//    way "Show in page" does (ends by itself after ELEMENT_HIGHLIGHT_MS); `requestId` alone lists the response values
//    the page shows.
//
// Commands run one at a time; the page must be free (no capture of the user, no value being shown) and, for anything
// the user should see, the tab visible — else they fail fast with a message for the chat.
import type { ElementInfo, ElementLocator, FindCommandArgs, FindCommandResult, PageRect, ShotCommandArgs, ShotCommandResult, ShotImage, ShotTarget } from '../../shared/control-shot';
import type { ElementMatch, ElementValueQuery } from '../../shared/find-protocol';
import { ELEMENT_HIGHLIGHT_MS, ELEMENT_MATCHES_MAX } from '../../shared/find-protocol';
import { SHOT_BUSY_ERROR, SHOT_PREVIEW_MAX } from '../../shared/screenshot-protocol';
import type { JNode, RequestEntry } from '../../shared/types';
import { pickMatch, parseValuePath, valueQueryOf, valueQueryOfNode } from '../../lib/elementLocate';
import { previewSize, sanitizePadding } from '../../lib/elementShot';
import { collectCandidates, toWire } from '../../lib/findInPage';
import { getNodeAtPath, tryParseJsonTree } from '../../lib/json-tree';
import { localeHintsOf } from '../find/locales';
import { resolveBody } from '../response/body-model';
import { HIDDEN_TAB_ERROR, LOCATE_ELEMENTS_TIMEOUT_MS, defaultPadding, describeLocator, findElements, matchLabel, serialize, tabHidden } from '../screenshot/elementCapture';
import type { ElementLocatorQuery } from '../screenshot/elementCapture';
import { captureArea, captureFullPage, captureVisibleArea, createShotBackend, isShotBusy, withTimeout } from '../screenshot/engine';
import type { AreaCapture, CaptureOutput, ShotBackend } from '../screenshot/engine';
import { controlHost, openShotInView } from '../screenshot/open';
import type { ControlHost } from '../screenshot/open';
import { addShot } from '../screenshot/store';
import { getShellState } from '../shellState';

/** Where a command runs (tests and callers that hold the bridge; default: what the App registered). */
export interface ShotCommandContext {
  /** The page connection (the panel's RemoteBridge). */
  host?: ControlHost;
  /** Capture backend (default: over `host`). */
  backend?: ShotBackend;
}

/** A properties list (requestId alone) holds at most this many values unless `limit` says otherwise. */
const PROPERTIES_MAX = 500;
/** A PNG preview larger than this is sent as JPEG instead (the chat's image budget). */
const PREVIEW_PNG_MAX_BYTES = 1_500_000;
const PREVIEW_JPEG_QUALITY = 0.88;

const NOT_CONNECTED = 'kineReqLens is not connected to the page — open the overlay in this tab (or reload the page) and try again';
const BUSY = `${SHOT_BUSY_ERROR} (the user may be capturing, picking an element or looking at a value on the page) — try again in a moment`;

function hostOf(ctx?: ShotCommandContext): ControlHost {
  const host = ctx?.host ?? controlHost();
  if (!host) throw new Error(NOT_CONNECTED);
  return host;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Errors of the engine, worded for the chat. */
function friendly(err: unknown): Error {
  if (isShotBusy(err)) return new Error(BUSY);
  if ((err instanceof DOMException && err.name === 'AbortError') || /cancelled/i.test(errorText(err))) {
    return new Error('The capture was cancelled on the page (Esc)');
  }
  return err instanceof Error ? err : new Error(String(err));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundRect(r: PageRect): PageRect {
  return { x: round2(r.x), y: round2(r.y), width: round2(r.width), height: round2(r.height) };
}

/** An element as reported to the chat. */
function infoOf(match: ElementMatch): ElementInfo {
  return { tag: match.tag, text: match.text, selector: match.selector, rect: roundRect(match.rect), visible: match.visible };
}

// ------------------------------------------------------------------------------------------------ locators

/** The request a `requestId` names ("selected": the one selected in the overlay). */
function entryOf(host: ControlHost, requestId: string): RequestEntry {
  const id = requestId === 'selected' ? getShellState().selectedId : requestId;
  if (!id) throw new Error('No request is selected in the kineReqLens overlay — pass an id from list_requests');
  const entry = host.getEntries().find((e) => e.id === id);
  if (!entry) throw new Error(`No captured request with id ${requestId} on this page (ids come from list_requests)`);
  return entry;
}

/** The JSON tree of a request's captured response (as the Original response shows it). */
function responseTree(entry: RequestEntry): JNode {
  const what = `The response of ${entry.method} ${entry.url.length > 120 ? `${entry.url.slice(0, 119)}…` : entry.url}`;
  const body = entry.responseBody;
  if (!body) throw new Error(`${what} has no captured body`);
  const resolved = resolveBody(body, entry.responseHeaders ?? []);
  if (resolved.kind !== 'text') throw new Error(`${what} is not text`);
  if (resolved.truncated) throw new Error(`${what} was truncated at capture (raise the response body cap in Settings)`);
  const tree = tryParseJsonTree(resolved.text);
  if (!tree) throw new Error(`${what} is not JSON`);
  return tree;
}

/** The locator of `requestId` + `path`: the value at that path, looked for the way Find in page does. */
function valueAtPath(host: ControlHost, requestId: string, path: string): ElementValueQuery {
  const segments = parseValuePath(path);
  if (!segments) throw new Error(`Invalid path "${path}" (e.g. data.items[0].name)`);
  const node = getNodeAtPath(responseTree(entryOf(host, requestId)), segments);
  if (!node) throw new Error(`No value at "${path}" in that response`);
  const query = valueQueryOfNode(node, segments);
  if ('error' in query) throw new Error(query.error);
  return query;
}

function hasLocator(args: ElementLocator): boolean {
  return args.selector !== undefined || args.text !== undefined || args.value !== undefined || args.requestId !== undefined;
}

/** The page-side query of a command's locator. */
function locatorOf(args: ElementLocator, host: ControlHost): ElementLocatorQuery {
  const exact = args.exact === true ? { exact: true } : {};
  if (args.selector !== undefined) return { selector: args.selector };
  if (args.text !== undefined) return { text: args.text, ...exact };
  if (args.value !== undefined) return { value: valueQueryOf(args.value), ...exact };
  if (args.requestId !== undefined) {
    if (args.path === undefined) throw new Error('requestId needs a path to locate one value (find_in_page with requestId alone lists the values the page shows)');
    return { value: valueAtPath(host, args.requestId, args.path), ...exact };
  }
  throw new Error('Give a locator: selector, text, value, or requestId + path');
}

// ------------------------------------------------------------------------------------------------ images

/** Base64 of a blob (no data: prefix). */
async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

async function imageOf(blob: Blob, width: number, height: number): Promise<ShotImage> {
  return { data: await base64Of(blob), mimeType: 'image/png', width, height };
}

/** The chat's copy: at most SHOT_PREVIEW_MAX px on the long side (the image itself when it fits). */
async function previewOf(blob: Blob, full: ShotImage): Promise<ShotImage> {
  const size = previewSize(full.width, full.height, SHOT_PREVIEW_MAX);
  if (size.scale >= 1) return full;
  const bitmap = await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' });
  try {
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    let out = await canvas.convertToBlob({ type: 'image/png' });
    let mimeType: ShotImage['mimeType'] = 'image/png';
    if (out.size > PREVIEW_PNG_MAX_BYTES) {
      out = await canvas.convertToBlob({ type: 'image/jpeg', quality: PREVIEW_JPEG_QUALITY });
      mimeType = 'image/jpeg';
    }
    return { data: await base64Of(out), mimeType, width: size.width, height: size.height };
  } finally {
    bitmap.close();
  }
}

/** The backend whose first begin opens the session only when the page is free (never joins the user's capture). */
function exclusiveFirst(backend: ShotBackend): ShotBackend {
  let first = true;
  return {
    ...backend,
    begin(hide, opts = {}) {
      const o = first ? { ...opts, exclusive: true } : opts;
      first = false;
      return backend.begin(hide, o);
    },
  };
}

/** End an element highlight a previous find_in_page left on the page (it would make the page busy). */
async function endHighlight(host: ControlHost): Promise<void> {
  try {
    await withTimeout(host.find('findHighlight', { refs: [], index: 0, label: '', durationMs: 0 }), 3_000, 'timeout');
  } catch {
    /* an older page side, or none to end */
  }
}

// ------------------------------------------------------------------------------------------------ screenshot

/** Capture what `args` describe with the overlay's capture engine. Throws an Error with a message for the user. */
export async function runShotCommand(args: ShotCommandArgs, ctx?: ShotCommandContext): Promise<ShotCommandResult> {
  const host = hostOf(ctx);
  return serialize(async () => {
    if (tabHidden()) throw new Error(HIDDEN_TAB_ERROR);
    const target: ShotTarget = args.target ?? (hasLocator(args) ? 'element' : 'visible');
    const padding = sanitizePadding(args.padding, defaultPadding(host));
    const backend = ctx?.backend ?? createShotBackend(host);
    const notes: string[] = [];
    let capture: CaptureOutput | AreaCapture;
    let element: ElementInfo | undefined;
    let matches: number | undefined;
    let matchIndex: number | undefined;
    await endHighlight(host);
    try {
      switch (target) {
        case 'visible':
          capture = await captureVisibleArea(exclusiveFirst(backend));
          break;
        case 'full':
          capture = await captureFullPage(exclusiveFirst(backend));
          if (capture.capped) notes.push('the page was cut at the height limit (20 000 px)');
          break;
        case 'region': {
          const r = args.region;
          if (!r || !(r.width > 0) || !(r.height > 0)) throw new Error('target "region" needs a region {x, y, width, height} in page CSS px');
          capture = await captureArea(backend, { kind: 'region', rect: r }, { padding, hideOverlay: 'auto', exclusive: true });
          break;
        }
        case 'element': {
          const locator = locatorOf(args, host);
          const found = await findElements(host, locator, Math.max(20, (args.index ?? 0) + 1));
          const picked = pickMatch(found.matches, found.total, args.index);
          if ('error' in picked) throw new Error(picked.error === 'No element matches' ? `No element on the page matches ${describeLocator(locator)}` : picked.error);
          const match = found.matches[picked.index]!;
          if (!match.visible) throw new Error(`Match #${picked.index} (${matchLabel(match)}) is on the page but not visible`);
          const shot = await captureArea(backend, { kind: 'element', ref: match.ref }, { padding, hideOverlay: 'auto', exclusive: true });
          shot.label = matchLabel(match);
          capture = shot;
          element = { ...infoOf(match), rect: roundRect(shot.source.element), visible: true };
          matches = found.total;
          matchIndex = picked.index;
          if (found.total > 1 && args.index === undefined) {
            notes.push(`${found.total} elements matched; captured #${picked.index}, the first visible one (pass index to choose another)`);
          }
          break;
        }
        default:
          throw new Error(`Unknown target "${String(target)}"`);
      }
    } catch (err) {
      throw friendly(err);
    }
    const padded = 'source' in capture ? (capture as AreaCapture) : null;
    if (padded) notes.unshift(...padded.notes);
    else if (args.padding !== undefined) notes.push('padding applies to element and region captures only');

    const item = await addShot(capture);
    if (args.open) openShotInView(item.id);
    const image = await imageOf(capture.blob, capture.width, capture.height);
    const preview = await previewOf(capture.blob, image);
    const area = capture.pageRect ?? { x: 0, y: 0, width: capture.width / capture.scale, height: capture.height / capture.scale };
    const result: ShotCommandResult = { image, preview, area: roundRect(area), padding: padded ? padding : 0 };
    if (element) result.element = element;
    if (matches !== undefined) result.matches = matches;
    if (matchIndex !== undefined) result.matchIndex = matchIndex;
    if (notes.length) result.notes = notes;
    return result;
  });
}

// ------------------------------------------------------------------------------------------------ find

/** The response values of a request that the page shows, in the response's order. */
async function properties(host: ControlHost, requestId: string, limit: number): Promise<FindCommandResult> {
  const root = responseTree(entryOf(host, requestId));
  const set = collectCandidates(root);
  if (set.candidates.length === 0) return { matches: [], total: 0, properties: [] };
  const answer = await withTimeout(
    host.find('findValues', { candidates: toWire(set.candidates), locales: localeHintsOf(host) }),
    LOCATE_ELEMENTS_TIMEOUT_MS,
    'The page did not answer in time',
  );
  if (answer.error) throw new Error(answer.error);
  // Document order of the JSON nodes (the candidates are ordered by priority).
  const order = new Map<string, number>();
  const stack: JNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    order.set(node.id, order.size);
    const kids = node.children ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  const found = answer.results
    .map((r) => ({ r, c: set.candidates[r.id] }))
    .filter((x): x is { r: (typeof answer.results)[number]; c: NonNullable<typeof x.c> } => !!x.c)
    .sort((a, b) => (order.get(a.c.nodeIds[0]!) ?? 0) - (order.get(b.c.nodeIds[0]!) ?? 0));
  const notes: string[] = [];
  if (set.dropped > 0) notes.push(`${set.dropped} values were not searched (only the first ${set.candidates.length})`);
  if (found.length > limit) notes.push(`${found.length} values are shown; listed the first ${limit}`);
  const result: FindCommandResult = {
    matches: [],
    total: found.length,
    properties: found.slice(0, limit).map(({ r, c }) => {
      const p: NonNullable<FindCommandResult['properties']>[number] = { path: c.path || '(root)', value: c.value, matches: r.total, visible: r.visible };
      if (r.as && r.confidence < 3 && r.as !== c.value) p.as = r.as;
      return p;
    }),
  };
  if (notes.length) result.notes = notes;
  return result;
}

/** Locate page elements (or the response values shown in the page) with the Find in page scanner. */
export async function runFindCommand(args: FindCommandArgs, ctx?: ShotCommandContext): Promise<FindCommandResult> {
  const host = hostOf(ctx);
  return serialize(async () => {
    const onlyRequest = args.requestId !== undefined && args.path === undefined && args.selector === undefined && args.text === undefined && args.value === undefined;
    if (onlyRequest) {
      const limit = Math.max(1, Math.min(PROPERTIES_MAX, Math.round(args.limit ?? PROPERTIES_MAX)));
      const result = await properties(host, args.requestId!, limit);
      if (args.highlight) (result.notes ??= []).push('highlight needs a locator (a requestId alone lists values)');
      return result;
    }
    if (args.highlight && tabHidden()) throw new Error(HIDDEN_TAB_ERROR);
    const limit = Math.max(1, Math.min(ELEMENT_MATCHES_MAX, Math.round(args.limit ?? 20)));
    const locator = locatorOf(args, host);
    const found = await findElements(host, locator, Math.max(limit, (args.index ?? 0) + 1));
    const result: FindCommandResult = { matches: found.matches.slice(0, limit).map(infoOf), total: found.total };
    if (args.highlight) {
      const notes: string[] = [];
      const picked = pickMatch(found.matches, found.total, args.index);
      if ('error' in picked) notes.push(picked.error === 'No element matches' ? 'Nothing to highlight: no element matches' : picked.error);
      else {
        const chosen = found.matches[picked.index]!;
        // The bar cycles through the visible matches, starting at the chosen one.
        const refs = found.matches.filter((m) => m.visible || m === chosen).map((m) => m.ref);
        await endHighlight(host);
        const shown = await withTimeout(
          host.find('findHighlight', { refs, index: refs.indexOf(chosen.ref), label: describeLocator(locator), durationMs: ELEMENT_HIGHLIGHT_MS }),
          LOCATE_ELEMENTS_TIMEOUT_MS,
          'The page did not answer in time',
        );
        if (shown.ok) result.highlighted = picked.index;
        else notes.push(`Not highlighted: ${shown.message}`);
      }
      if (notes.length) result.notes = notes;
    }
    return result;
  });
}
