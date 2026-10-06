// Capture pipelines of the screenshot tool (panel side). The page side (overlay hiding, scrolling, picker) is
// driven over the panel Port (RemoteBridge.shot → frame/server.ts → page/controller.ts); the pixels come from the
// service worker (CAPTURE_VISIBLE_TAB → chrome.tabs.captureVisibleTab) straight to this extension page.
//
// Every pipeline runs inside a page session (inSession): the page side is always ended — overlay, scroll position,
// fixed elements and picker restored — also when a step fails or times out, and a session the page side had to end
// by itself (Esc, its idle / hidden-window timeouts) fails the capture instead of returning a picture that may show
// the overlay. Port calls and the worker request have timeouts, so a hung request never keeps a session open.
import {
  captureScale,
  dataUrlToBytes,
  errorAreaRect,
  imageSpan,
  normalizeElementRect,
  outputSize,
  planStitch,
  tileSlice,
  toImageRect,
  DEFAULT_MAX_PAGE_HEIGHT,
} from '../../lib/screenshot';
import type { OutputScale, Rect } from '../../lib/screenshot';
import type { ComponentLocateResult, ComponentQuery } from '../../shared/initiator-protocol';
import { CAPTURE_REQUEST_TIMEOUT_MS, SHOT_BUSY_ERROR } from '../../shared/screenshot-protocol';
import type {
  CaptureVisibleResponse,
  ShotBeginOptions,
  ShotCallName,
  ShotCalls,
  ShotElementGeometry,
  ShotEndState,
  ShotPickMode,
  ShotPickResult,
  ShotViewport,
} from '../../shared/screenshot-protocol';
import { SHOT_SPARE_MARGIN } from '../../shared/screenshot-protocol';
import type { HitRect } from '../../shared/panel-protocol';
import { captureAreaFor, clippedNote, cropArea, pageSizeOf, planAreaTiles, tileCopy, tilePixels } from '../../lib/elementShot';
import type { AreaCrop, AreaTile } from '../../lib/elementShot';
import { intersectRect, normalizeRect } from '../../lib/screenshot';
import type { Size } from '../../lib/screenshot';
import { overlayCovers } from '../errors/autoShot';
import { reportedHitRegions } from '../panel/hit';

/** Port calls that do not wait for the user (begin, scroll) fail after this long. */
export const SHOT_CALL_TIMEOUT_MS = 10_000;
/** shotEnd answer timeout (the page side restores by itself anyway when it hears nothing). */
const SHOT_END_TIMEOUT_MS = 5_000;
/** Component lookup budget of an error-area capture; past it the visible page is captured instead. */
export const LOCATE_TIMEOUT_MS = 5_000;

/** Everything a capture needs from the outside world (a fake in tests). */
export interface ShotBackend {
  begin(hideOverlay: boolean, opts?: Omit<ShotBeginOptions, 'hideOverlay'>): Promise<ShotViewport>;
  /** Scroll the window to (x, y); x defaults to where it was when the session began. */
  scroll(y: number, hideFixed: boolean, x?: number): Promise<ShotViewport>;
  /** End the page session; says whether it was still intact ('ok'). */
  end(): Promise<ShotEndState>;
  pick(mode: ShotPickMode): Promise<ShotPickResult | null>;
  /** PNG of the visible tab. */
  captureVisible(): Promise<Blob>;
  /** Measure a located element (ref), scrolling it into view first when `scroll`; null when it is gone. */
  element?(ref: string, scroll: boolean): Promise<ShotElementGeometry | null>;
}

/** The part of RemoteBridge (src/ui/panel/remote.ts) the backend uses. */
export interface ShotHost {
  shot<M extends ShotCallName>(method: M, ...args: Parameters<ShotCalls[M]>): Promise<ReturnType<ShotCalls[M]>>;
}

export function isShotHost(value: unknown): value is ShotHost {
  return !!value && typeof (value as { shot?: unknown }).shot === 'function';
}

/** A step that did not finish in time (a hung request, a capture past its hidden-window cap). */
export class ShotTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShotTimeoutError';
  }
}

/** shotBegin with `exclusive` was refused: another capture or Find in page uses the page (nothing was changed). */
export function isShotBusy(err: unknown): boolean {
  return err instanceof Error && err.message === SHOT_BUSY_ERROR;
}

/** Settle like `promise`, or reject with `error` once `ms` passed (the late result is dropped). */
export function withTimeout<T>(promise: Promise<T>, ms: number, error: string | (() => Error)): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(typeof error === 'string' ? new ShotTimeoutError(error) : error()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Capture sessions open in this panel (between a begin and its end), all backends together. */
let openSessions = 0;

/** A capture session of this panel is open (the screenshot tool, an error-area capture): the page is in use. */
export function shotSessionActive(): boolean {
  return openSessions > 0;
}

const END_STATES: readonly ShotEndState[] = ['ok', 'cancelled', 'expired', 'none'];

/** Backend over the panel connection (`host` = the panel's RemoteBridge) and the worker's CAPTURE_VISIBLE_TAB. */
export function createShotBackend(host: ShotHost): ShotBackend {
  let open = false;
  const setOpen = (value: boolean) => {
    if (value === open) return;
    open = value;
    openSessions = Math.max(0, openSessions + (value ? 1 : -1));
  };
  return {
    async begin(hideOverlay, opts = {}) {
      setOpen(true);
      try {
        return await withTimeout(host.shot('shotBegin', { ...opts, hideOverlay }), SHOT_CALL_TIMEOUT_MS, 'The page did not answer in time');
      } catch (err) {
        // Refused: nothing changed on the page, there is no session of ours to end.
        if (isShotBusy(err)) setOpen(false);
        throw err;
      }
    },
    scroll: (y, hideFixed, x) =>
      withTimeout(
        x === undefined ? host.shot('shotScroll', y, hideFixed) : host.shot('shotScroll', y, hideFixed, x),
        SHOT_CALL_TIMEOUT_MS,
        'The page did not answer in time',
      ),
    element: (ref, scroll) => withTimeout(host.shot('shotElement', ref, scroll), SHOT_CALL_TIMEOUT_MS, 'The page did not answer in time'),
    async end() {
      setOpen(false);
      const state: unknown = await withTimeout(host.shot('shotEnd'), SHOT_END_TIMEOUT_MS, 'The page did not answer in time');
      // An older page side answers nothing: it had no way to end a session by itself but Esc.
      return END_STATES.includes(state as ShotEndState) ? (state as ShotEndState) : 'ok';
    },
    pick: (mode) => host.shot('shotPick', mode),
    async captureVisible() {
      const answer = (await withTimeout(
        chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' }) as Promise<CaptureVisibleResponse | undefined>,
        CAPTURE_REQUEST_TIMEOUT_MS,
        'The browser did not return the screenshot in time',
      )) as CaptureVisibleResponse | undefined;
      if (!answer || typeof answer !== 'object') throw new Error('No answer from the extension');
      if (!answer.ok) throw new Error(answer.error);
      const decoded = dataUrlToBytes(answer.dataUrl);
      if (!decoded) throw new Error('The browser returned no image');
      return new Blob([decoded.bytes as BlobPart], { type: 'image/png' });
    },
  };
}

/** The error of a session the page side had ended before the panel did. */
function interrupted(state: ShotEndState): Error {
  return state === 'cancelled'
    ? new DOMException('Screenshot cancelled', 'AbortError')
    : new Error('The capture was interrupted — the page side timed out and showed the overlay again');
}

/**
 * Run a capture pipeline inside a page session. The session is always ended (also when `body` fails or times out),
 * and a capture whose session the page side ended first (Esc, its timeouts) fails. A begin refused as busy
 * (`exclusive`) changed nothing, so nothing is ended then.
 */
export async function inSession<T>(backend: ShotBackend, body: () => Promise<T>): Promise<T> {
  let finished = false;
  let refused = false;
  try {
    const value = await body();
    finished = true;
    const state = await backend.end();
    if (state !== 'ok') throw interrupted(state);
    return value;
  } catch (err) {
    if (!finished && isShotBusy(err)) refused = true;
    throw err;
  } finally {
    if (!finished && !refused) await backend.end().catch(() => undefined);
  }
}

export type ShotMode = 'visible' | 'region' | 'element' | 'fullpage' | 'component';

/** A finished capture. */
export interface CaptureOutput {
  blob: Blob;
  width: number;
  height: number;
  /** Image px per CSS px of the page (1 for 1× output). */
  scale: number;
  mode: ShotMode;
  host: string;
  /** Element picks: what was picked. */
  label?: string;
  /** Full page: the page was taller than the cap. */
  capped?: boolean;
  /** What the picture shows, in page (document) CSS px (unknown for panel components). */
  pageRect?: Rect;
}

export interface CaptureOptions {
  output?: OutputScale;
  signal?: AbortSignal;
  /** Full page: tiles done / total. */
  onProgress?(done: number, total: number): void;
  /** Full page height cap (CSS px). */
  maxHeight?: number;
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Screenshot cancelled', 'AbortError');
}

/** Encode a canvas as PNG. */
async function toPng(canvas: OffscreenCanvas): Promise<Blob> {
  return canvas.convertToBlob({ type: 'image/png' });
}

function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/** Crop `bitmap` (captured at `scale`) to `rect` (CSS px) and encode it at the requested output scale. */
async function cropBitmap(bitmap: ImageBitmap, rect: Rect, scale: number, output: OutputScale): Promise<{ blob: Blob; width: number; height: number; scale: number }> {
  const crop = toImageRect(rect, scale, { width: bitmap.width, height: bitmap.height });
  if (!crop) throw new Error('Nothing to capture: the selection is outside the visible area');
  const size = outputSize(crop, scale, output);
  const canvas = new OffscreenCanvas(size.width, size.height);
  context2d(canvas).drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height);
  return { blob: await toPng(canvas), width: size.width, height: size.height, scale: output === 'css' ? 1 : scale };
}

/** Capture the visible tab and crop it to `rect` (viewport CSS px). */
async function captureRect(backend: ShotBackend, viewport: ShotViewport, rect: Rect, output: OutputScale) {
  const png = await backend.captureVisible();
  const bitmap = await createImageBitmap(png);
  try {
    const scale = captureScale(bitmap.width, viewport.innerWidth, viewport.devicePixelRatio);
    return await cropBitmap(bitmap, rect, scale, output);
  } finally {
    bitmap.close();
  }
}

/** The visible content area (no scrollbars). */
function contentRect(v: ShotViewport): Rect {
  return { x: 0, y: 0, width: v.clientWidth, height: v.clientHeight };
}

/** (a) Visible area of the page, overlay hidden. */
export async function captureVisibleArea(backend: ShotBackend, opts: CaptureOptions = {}): Promise<CaptureOutput> {
  return inSession(backend, async () => {
    const v = await backend.begin(true);
    checkAbort(opts.signal);
    const shot = await captureRect(backend, v, contentRect(v), opts.output ?? 'device');
    return { ...shot, mode: 'visible', host: v.host, pageRect: { x: v.scrollX, y: v.scrollY, width: v.clientWidth, height: v.clientHeight } };
  });
}

export interface PickOptions extends CaptureOptions {
  /**
   * Element picks: capture the picked element with this padding (CSS px) plus a spare margin for later re-crops
   * (captureArea); without it, exactly the element's visible box.
   */
  padding?: number;
}

/**
 * (b) / (c) Region or element picked on the page, overlay hidden. Null when the user cancelled. An element pick with
 * `padding` is a padded capture (AreaCapture: the element is measured again and may be scrolled / stitched).
 */
export async function capturePicked(backend: ShotBackend, mode: ShotPickMode, opts: PickOptions = {}): Promise<CaptureOutput | AreaCapture | null> {
  let cancelled = false;
  try {
    return await inSession(backend, async () => {
      await backend.begin(true);
      const picked = await backend.pick(mode);
      if (!picked) {
        cancelled = true;
        return null;
      }
      checkAbort(opts.signal);
      if (mode === 'element' && picked.ref && opts.padding !== undefined && backend.element) {
        const target: AreaTarget = { kind: 'element', ref: picked.ref };
        const shot = await areaPipeline(backend, target, { ...opts, padding: opts.padding, hideOverlay: 'always' });
        return picked.label ? { ...shot, label: picked.label } : shot;
      }
      // Metrics after the pick: the page may have scrolled / resized while picking.
      const v = await backend.begin(true);
      const shot = await captureRect(backend, v, picked.rect, opts.output ?? 'device');
      const pageRect = { x: picked.rect.x + v.scrollX, y: picked.rect.y + v.scrollY, width: picked.rect.width, height: picked.rect.height };
      return { ...shot, mode, host: v.host, pageRect, ...(picked.label ? { label: picked.label } : {}) };
    });
  } catch (err) {
    // The user cancelled the pick (Esc also ends the page session as 'cancelled').
    if (cancelled) return null;
    throw err;
  }
}

// ------------------------------------------------------------------------------------------ padded captures

/** What a padded capture is of: a located element (a page-side ref) or a region of the page (page CSS px). */
export type AreaTarget = { kind: 'element'; ref: string } | { kind: 'region'; rect: Rect };

/** The whole picture of a padded capture: the element / region plus padding plus spare margin, kept for re-crops. */
export interface AreaSource {
  blob: Blob;
  width: number;
  height: number;
  /** Image px per CSS px. */
  scale: number;
  /** What the picture shows (page CSS px). */
  area: Rect;
  /** The element / region (page CSS px). */
  element: Rect;
  /** Size of the page when captured. */
  doc: Size;
  /** What to capture again for a padding beyond the captured margin. */
  target: AreaTarget;
  /** A fixed element (stays put while the page scrolls): only what the viewport showed of the area. */
  fixed?: boolean;
}

/** A padded capture: the cropped picture (CaptureOutput) plus its source and how it was made. */
export interface AreaCapture extends CaptureOutput {
  source: AreaSource;
  /** The padding asked for (CSS px). */
  padding: number;
  /** The crop the picture is (page CSS px, image px, padding kept per side). */
  crop: AreaCrop;
  /** Captures stitched together. */
  tiles: number;
  /** "padding clipped at the page edge (left)", "stitched from 3 tiles"… */
  notes: string[];
}

export interface AreaCaptureOptions extends CaptureOptions {
  /** Space around the element / region (CSS px). */
  padding: number;
  /** Extra margin captured beyond the padding for re-crops (CSS px, default SHOT_SPARE_MARGIN). */
  spare?: number;
  /**
   * 'auto' (default): the overlay is hidden only for the captures it covers (one of its hit regions intersects the
   * part of the area in view); 'always': hidden for the whole capture (a pick).
   */
  hideOverlay?: 'auto' | 'always';
  /** Where the overlay paints (default: the hit regions the panel last reported, src/ui/panel/hit.ts). */
  regions?: () => readonly HitRect[] | 'all' | null;
  /** Open the page session only when the page is free (refused as busy otherwise, see isShotBusy). */
  exclusive?: boolean;
}

const ELEMENT_GONE = 'The element is no longer on the page';

/**
 * (g) A located element (or a page region) with `padding` around it: the element is scrolled into view (its scroll
 * containers too; the session restores them), the area — element + padding + spare margin, clamped to the page — is
 * captured in one shot when it fits the viewport, else in viewport tiles stitched together (fixed / sticky elements
 * hidden), and the picture is cropped to element + padding. The full area stays in `source` for re-crops
 * (cropSource). The overlay is hidden only while it covers the part being captured (or always, `hideOverlay`).
 */
export async function captureArea(backend: ShotBackend, target: AreaTarget, opts: AreaCaptureOptions): Promise<AreaCapture> {
  return inSession(backend, () => areaPipeline(backend, target, opts));
}

async function areaPipeline(backend: ShotBackend, target: AreaTarget, opts: AreaCaptureOptions): Promise<AreaCapture> {
  const output = opts.output ?? 'device';
  const padding = Math.max(0, Number.isFinite(opts.padding) ? opts.padding : 0);
  const spare = Math.max(0, opts.spare ?? SHOT_SPARE_MARGIN);
  const hideAll = opts.hideOverlay === 'always';
  const regions = opts.regions ?? reportedHitRegions;
  let hidden = hideAll;
  let v = await backend.begin(hideAll, opts.exclusive ? { exclusive: true } : {});
  checkAbort(opts.signal);

  let element: Rect;
  let fixed = false;
  if (target.kind === 'element') {
    if (!backend.element) throw new Error('Element captures are not available here');
    const geometry = await backend.element(target.ref, true);
    if (!geometry) throw new Error(ELEMENT_GONE);
    v = geometry.viewport;
    fixed = geometry.fixed === true;
    const r = geometry.rect;
    if (!(r.width > 0 && r.height > 0)) throw new Error('The element is not visible (it has no size)');
    element = { x: r.x + v.scrollX, y: r.y + v.scrollY, width: r.width, height: r.height };
  } else {
    element = normalizeRect(target.rect);
    if (!(element.width > 0 && element.height > 0)) throw new Error('The region is empty');
  }
  checkAbort(opts.signal);

  const doc = pageSizeOf(v);
  const view = { width: v.clientWidth, height: v.clientHeight };
  const planned = captureAreaFor(element, padding, spare, doc, v.devicePixelRatio);
  if (!planned) throw new Error(target.kind === 'element' ? 'The element is outside the page' : 'The region is outside the page');
  const notes: string[] = [];
  let area = planned.area;
  let tiles: AreaTile[];
  if (fixed) {
    // It does not move with the page: what the viewport shows of the area, from where the page is.
    const shown = intersectRect(area, { x: v.scrollX, y: v.scrollY, ...view });
    if (!shown) throw new Error('The element is not in view');
    if (shown.width < area.width - 0.5 || shown.height < area.height - 0.5) notes.push('fixed element: only what the viewport shows around it was captured');
    area = shown;
    tiles = [{ cell: area, scrollX: v.scrollX, scrollY: v.scrollY }];
  } else {
    tiles = planAreaTiles(area, view, doc, { x: v.scrollX, y: v.scrollY });
  }
  const multi = tiles.length > 1;

  let canvas: OffscreenCanvas | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  let scale = 1;
  let missing = false;
  for (let i = 0; i < tiles.length; i++) {
    checkAbort(opts.signal);
    const tile = tiles[i]!;
    // Several tiles: fixed / sticky elements (headers, cookie bars) would repeat on every tile and cover the area —
    // hidden from the first one (the page side restores them).
    if (Math.abs(tile.scrollX - v.scrollX) > 0.5 || Math.abs(tile.scrollY - v.scrollY) > 0.5 || (multi && i === 0)) {
      v = await backend.scroll(tile.scrollY, multi, tile.scrollX);
      checkAbort(opts.signal);
    }
    const copy = tileCopy(tile.cell, area, { x: v.scrollX, y: v.scrollY }, view);
    if (!copy) {
      missing = true;
      continue;
    }
    if (!hideAll) {
      const cover = overlayCovers(copy.src, regions());
      if (cover !== hidden) {
        v = await backend.begin(cover);
        hidden = cover;
      }
    }
    const bitmap = await createImageBitmap(await backend.captureVisible());
    try {
      if (!canvas) {
        scale = captureScale(bitmap.width, v.innerWidth, v.devicePixelRatio);
        canvas = new OffscreenCanvas(Math.max(1, Math.round(area.width * scale)), Math.max(1, Math.round(area.height * scale)));
        ctx = context2d(canvas);
      }
      const px = tilePixels(copy, scale, bitmap);
      if (px) ctx!.drawImage(bitmap, px.sx, px.sy, px.sw, px.sh, px.dx, px.dy, px.dw, px.dh);
      if (copy.dest.width < tile.cell.width - 0.5 || copy.dest.height < tile.cell.height - 0.5) missing = true;
    } finally {
      bitmap.close();
    }
    opts.onProgress?.(i + 1, tiles.length);
  }
  if (!canvas) throw new Error('Nothing of the area could be scrolled into view');

  // The kept picture at the requested output scale (1× output: one pixel per CSS px).
  let picture = canvas;
  let pictureScale = scale;
  if (output === 'css' && Math.abs(scale - 1) > 1e-6) {
    picture = new OffscreenCanvas(Math.max(1, Math.round(area.width)), Math.max(1, Math.round(area.height)));
    context2d(picture).drawImage(canvas, 0, 0, picture.width, picture.height);
    pictureScale = 1;
  }
  const source: AreaSource = { blob: await toPng(picture), width: picture.width, height: picture.height, scale: pictureScale, area, element, doc, target };
  if (fixed) source.fixed = true;
  const cropped = await cropPicture(picture, source, padding);

  const clipped = clippedNote(cropped.crop.clipped);
  if (clipped) notes.push(clipped);
  if (multi) notes.push(`stitched from ${tiles.length} tiles`);
  if (planned.capped) notes.push('the area was cut to the size limit (20 000 px tall, canvas limits)');
  if (missing) notes.push('part of the area could not be scrolled into view (left blank)');
  return {
    blob: cropped.blob,
    width: cropped.width,
    height: cropped.height,
    scale: pictureScale,
    mode: target.kind === 'element' ? 'element' : 'region',
    host: v.host,
    pageRect: cropped.crop.rect,
    ...(planned.capped ? { capped: true } : {}),
    source,
    padding,
    crop: cropped.crop,
    tiles: tiles.length,
    notes,
  };
}

/** Crop a decoded area picture to its element / region with `padding`. */
async function cropPicture(picture: CanvasImageSource, source: AreaSource, padding: number): Promise<{ blob: Blob; width: number; height: number; crop: AreaCrop }> {
  const crop = cropArea(source, source.element, padding, source.doc);
  if (!crop) throw new Error('The element is outside the captured area');
  const canvas = new OffscreenCanvas(crop.image.width, crop.image.height);
  context2d(canvas).drawImage(picture, crop.image.x, crop.image.y, crop.image.width, crop.image.height, 0, 0, crop.image.width, crop.image.height);
  return { blob: await toPng(canvas), width: canvas.width, height: canvas.height, crop };
}

/**
 * The picture of a padded capture with another `padding`, cropped from its source (no new capture). `bitmap`: the
 * source already decoded (the result view keeps it while the padding is being changed).
 */
export async function cropSource(source: AreaSource, padding: number, bitmap?: ImageBitmap): Promise<{ blob: Blob; width: number; height: number; crop: AreaCrop }> {
  const decoded = bitmap ?? (await createImageBitmap(source.blob));
  try {
    return await cropPicture(decoded, source, padding);
  } finally {
    if (!bitmap) decoded.close();
  }
}

/**
 * (d) Full page: scroll in viewport steps, capture each tile (≤ 2 / s, the worker paces them), stitch on an
 * OffscreenCanvas. Fixed / sticky elements are hidden after the first tile; the scroll position is restored.
 */
export async function captureFullPage(backend: ShotBackend, opts: CaptureOptions = {}): Promise<CaptureOutput> {
  return inSession(backend, () => fullPage(backend, opts));
}

async function fullPage(backend: ShotBackend, opts: CaptureOptions): Promise<CaptureOutput> {
  const output = opts.output ?? 'device';
  await backend.begin(true);
  const bitmaps: ImageBitmap[] = [];
  try {
    let v = await backend.scroll(0, false);
    const first = await createImageBitmap(await backend.captureVisible());
    bitmaps.push(first);
    const scale = captureScale(first.width, v.innerWidth, v.devicePixelRatio);
    const plan = planStitch({
      contentHeight: v.scrollHeight,
      viewportHeight: v.clientHeight,
      viewportWidth: v.clientWidth,
      scale,
      maxHeight: opts.maxHeight ?? DEFAULT_MAX_PAGE_HEIGHT,
    });
    const width = Math.min(first.width, Math.round(v.clientWidth * scale));
    const canvas = new OffscreenCanvas(width, Math.max(1, Math.round(plan.height * scale)));
    const ctx = context2d(canvas);
    let filled = 0;
    const total = plan.steps.length;
    for (let i = 0; i < total; i++) {
      checkAbort(opts.signal);
      let bitmap = first;
      if (i > 0) {
        v = await backend.scroll(plan.steps[i]!, true);
        checkAbort(opts.signal);
        bitmap = await createImageBitmap(await backend.captureVisible());
        bitmaps.push(bitmap);
      }
      const slice = tileSlice(v.scrollY, filled, v.clientHeight, plan.height);
      if (slice) {
        const src = imageSpan(slice.srcY, slice.height, scale);
        const dst = imageSpan(slice.destY, slice.height, scale);
        const srcLength = Math.min(src.length, bitmap.height - src.start);
        if (srcLength > 0 && dst.length > 0) ctx.drawImage(bitmap, 0, src.start, width, srcLength, 0, dst.start, width, dst.length);
        filled = slice.destY + slice.height;
      }
      // Tiles are decoded one at a time: release each as soon as it is drawn.
      if (bitmap !== first) {
        bitmap.close();
        bitmaps.pop();
      }
      opts.onProgress?.(i + 1, total);
      // The page could not scroll that far (it got shorter): later steps would add nothing.
      if (i > 0 && v.scrollY < plan.steps[i]! - 1) break;
    }
    const filledPx = Math.max(1, Math.min(canvas.height, Math.round(filled * scale)));
    let result = canvas;
    if (filledPx < canvas.height || output === 'css') {
      const size = output === 'css' ? outputSize({ width, height: filledPx }, scale, 'css') : { width, height: filledPx };
      result = new OffscreenCanvas(size.width, size.height);
      context2d(result).drawImage(canvas, 0, 0, width, filledPx, 0, 0, size.width, size.height);
    }
    return {
      blob: await toPng(result),
      width: result.width,
      height: result.height,
      scale: output === 'css' ? 1 : scale,
      mode: 'fullpage',
      host: v.host,
      pageRect: { x: 0, y: 0, width: v.clientWidth, height: Math.round(filledPx / scale) },
      ...(plan.capped ? { capped: true } : {}),
    };
  } finally {
    for (const b of bitmaps) b.close();
  }
}

/**
 * (e) A kineReqLens panel element (e.g. the response view): the overlay stays visible, the visible tab is
 * captured and cropped to the element's rect (the panel frame covers the page viewport 1:1).
 */
export async function captureComponent(backend: ShotBackend, element: Element, opts: CaptureOptions = {}): Promise<CaptureOutput> {
  return inSession(backend, async () => {
    const v = await backend.begin(false);
    const rect = normalizeElementRect(element.getBoundingClientRect(), { width: v.clientWidth, height: v.clientHeight });
    if (!rect) throw new Error('That part of the panel is not on screen');
    const shot = await captureRect(backend, v, rect, opts.output ?? 'device');
    return { ...shot, mode: 'component', host: v.host };
  });
}

/** An Errors view capture: the failing request's component area, or the visible page as a fallback. */
export interface ErrorAreaCapture extends CaptureOutput {
  area: 'component' | 'viewport';
  /** The component whose instances were captured. */
  component?: string;
  /** What was captured, in viewport CSS px. */
  rect: Rect;
}

export interface ErrorAreaOptions extends CaptureOptions {
  /** Scroll the component's first instance into view before capturing (default true; automatic captures pass false). */
  scroll?: boolean;
  /**
   * Automatic captures: decides, once the rect to capture is known (viewport CSS px, measured with the overlay
   * shown; `viewport` also says when the page last saw the pointer), whether the overlay must be hidden ('hide') or
   * can stay ('visible': it does not cover the rect). Throw to give up (the session is ended, nothing was hidden).
   * Without it the overlay is hidden right away (manual captures).
   */
  overlay?(rect: Rect, viewport: ShotViewport): 'visible' | 'hide';
  /**
   * Hard cap of the hidden window (ms, from the hiding begin): past it the capture is abandoned with a
   * ShotTimeoutError, the session ended at once (overlay shown) and the late picture dropped. The page side enforces
   * the same cap by itself.
   */
  maxHiddenMs?: number;
  /** Open the page session only when the page is free (refused as busy otherwise, see isShotBusy). */
  exclusive?: boolean;
  /** Component lookup budget (default LOCATE_TIMEOUT_MS); past it the visible page is captured instead. */
  locateTimeoutMs?: number;
}

/** Where the component is: its name and instance rects (empty when not found / not visible / no lookup). */
async function locateArea(
  locate: ((query: ComponentQuery) => Promise<ComponentLocateResult>) | null,
  names: readonly string[],
  opts: ErrorAreaOptions,
): Promise<{ component?: string; rects: Rect[] }> {
  if (!locate || !names.length) return { rects: [] };
  try {
    const result = await withTimeout(locate({ names: [...names], scroll: opts.scroll ?? true, highlight: false }), opts.locateTimeoutMs ?? LOCATE_TIMEOUT_MS, 'Component lookup timed out');
    const match = result.matches.find((m) => m.instances.some((i) => i.rect && i.rect.width > 0 && i.rect.height > 0));
    if (match) {
      return { component: match.name, rects: match.instances.map((i) => i.rect).filter((r): r is Rect => !!r && r.width > 0 && r.height > 0) };
    }
  } catch {
    /* fall back to the viewport */
  }
  return { rects: [] };
}

/**
 * (f) Errors view: find the initiator component's instances on the page (`locate`, scrolling the first into view
 * unless `scroll: false`), capture the union of their rects padded by 16 px and clamped to the viewport — or the
 * visible page when no component (or no visible instance) is found. Manual captures hide the overlay; automatic ones
 * (`overlay`) measure first and hide it only when it covers the area, for at most `maxHiddenMs`.
 */
export async function captureErrorArea(
  backend: ShotBackend,
  locate: ((query: ComponentQuery) => Promise<ComponentLocateResult>) | null,
  names: readonly string[],
  opts: ErrorAreaOptions = {},
): Promise<ErrorAreaCapture> {
  const { component, rects } = await locateArea(locate, names, opts);
  const output = opts.output ?? 'device';
  const areaIn = (v: ShotViewport): Rect | null => (component ? errorAreaRect(rects, { width: v.clientWidth, height: v.clientHeight }) : null);
  const result = (shot: Awaited<ReturnType<typeof captureRect>>, v: ShotViewport, area: Rect | null, rect: Rect): ErrorAreaCapture => {
    const out: ErrorAreaCapture = { ...shot, mode: area ? 'element' : 'visible', host: v.host, area: area ? 'component' : 'viewport', rect };
    if (area && component) {
      out.component = component;
      out.label = component;
    }
    return out;
  };
  const cap = opts.maxHiddenMs && opts.maxHiddenMs > 0 ? opts.maxHiddenMs : null;
  /** The hidden part of a capture, abandoned past the cap (the session's end then shows the overlay again). */
  const capped = <T>(work: Promise<T>): Promise<T> =>
    cap === null ? work : withTimeout(work, cap, () => new ShotTimeoutError(`The page could not be captured within ${cap / 1000} s — the overlay was shown again`));
  const exclusive = opts.exclusive ? { exclusive: true } : {};
  const hiddenOpts = cap === null ? {} : { maxHiddenMs: cap };

  return inSession(backend, async () => {
    if (!opts.overlay) {
      return capped(
        (async () => {
          const v = await backend.begin(true, { ...exclusive, ...hiddenOpts });
          checkAbort(opts.signal);
          const area = areaIn(v);
          const rect = area ?? contentRect(v);
          return result(await captureRect(backend, v, rect, output), v, area, rect);
        })(),
      );
    }
    // Automatic: measure with the overlay shown, then hide it only if it covers the area.
    const v = await backend.begin(false, exclusive);
    checkAbort(opts.signal);
    const area = areaIn(v);
    const rect = area ?? contentRect(v);
    if (opts.overlay(rect, v) === 'visible') return result(await captureRect(backend, v, rect, output), v, area, rect);
    return capped(
      (async () => {
        const hidden = await backend.begin(true, hiddenOpts);
        checkAbort(opts.signal);
        return result(await captureRect(backend, hidden, rect, output), hidden, area, rect);
      })(),
    );
  });
}
