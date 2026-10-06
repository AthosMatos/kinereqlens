// Recent captures of the screenshot tool: in panel memory only (never persisted), newest first, at most
// MAX_RECENT. Module-level so the strip survives the tool being unmounted / remounted (sidebar toggles).
//
// Padded element / region captures (engine.ts captureArea) keep their whole captured area: setShotPadding crops it
// again with another padding (no new capture; annotations move with the picture), replaceShotArea installs a new
// capture of the same element (a padding beyond the captured margin). Who wants a capture shown (the MCP `screenshot`
// tool, the response viewer's camera button) asks with requestShotSelection; the tool takes the request when it
// mounts or right away.
import { useEffect, useState } from 'preact/hooks';
import { recropLimit } from '../../lib/elementShot';
import type { AreaCrop } from '../../lib/elementShot';
import { shiftAnnotations } from './annotate';
import type { Annotation } from './annotate';
import { cropSource } from './engine';
import type { AreaCapture, AreaSource, CaptureOutput } from './engine';

export const MAX_RECENT = 10;
const THUMB_W = 96;
const THUMB_H = 64;

/** A padded capture's padding state (the result view's padding control). */
export interface ShotArea {
  /** The whole captured area (element + padding + spare margin). */
  source: AreaSource;
  /** The padding asked for (CSS px). */
  padding: number;
  /** The crop shown now. */
  crop: AreaCrop;
  /** Most padding a re-crop can show (Infinity: the page edge limits every side). */
  limit: number;
  /** Notes of the capture ("stitched from 2 tiles"…; whether the padding is clipped depends on the crop: `crop.clipped`). */
  notes: string[];
}

export interface ShotItem extends CaptureOutput {
  id: string;
  createdAt: number;
  /** Object URL of a small PNG preview (revoked when the item goes). */
  thumbUrl: string | null;
  annotations: Annotation[];
  /** Padded element / region captures: what the padding control re-crops. */
  padded?: ShotArea;
}

let items: ShotItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of [...listeners]) fn();
}

function release(item: ShotItem): void {
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  if (item.padded) dropSourceBitmap(item.padded.source.blob);
}

/** Small preview: the top of the image at the thumbnail's aspect ratio. */
export async function thumbnail(blob: Blob, width: number, height: number): Promise<string | null> {
  try {
    const aspect = THUMB_W / THUMB_H;
    const sw = width;
    const sh = Math.min(height, Math.round(width / aspect));
    const scale = Math.min(1, THUMB_W / sw, THUMB_H / sh);
    const bitmap = await createImageBitmap(blob, 0, 0, sw, sh, {
      resizeWidth: Math.max(1, Math.round(sw * scale)),
      resizeHeight: Math.max(1, Math.round(sh * scale)),
      resizeQuality: 'medium',
    });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
  } catch {
    return null;
  }
}

function isAreaCapture(output: CaptureOutput | AreaCapture): output is AreaCapture {
  return 'source' in output && !!(output as AreaCapture).source;
}

/** The ShotArea of a padded capture. */
function areaOf(capture: AreaCapture): ShotArea {
  const { source } = capture;
  return {
    source,
    padding: capture.padding,
    crop: capture.crop,
    limit: recropLimit(source.area, source.element, source.doc),
    notes: capture.notes.filter((n) => !n.startsWith('padding clipped')),
  };
}

/** The item's CaptureOutput fields (a padded capture's extra fields live in `area`). */
function outputOf(output: CaptureOutput | AreaCapture): CaptureOutput {
  if (!isAreaCapture(output)) return output;
  const { source: _source, padding: _padding, crop: _crop, tiles: _tiles, notes: _notes, ...rest } = output;
  return rest;
}

/** Add a capture (newest first); the oldest beyond MAX_RECENT is dropped. */
export async function addShot(output: CaptureOutput | AreaCapture): Promise<ShotItem> {
  const item: ShotItem = {
    ...outputOf(output),
    id: `shot-${Date.now().toString(36)}-${++seq}`,
    createdAt: Date.now(),
    thumbUrl: await thumbnail(output.blob, output.width, output.height),
    annotations: [],
  };
  if (isAreaCapture(output)) item.padded = areaOf(output);
  items = [item, ...items];
  for (const old of items.slice(MAX_RECENT)) release(old);
  items = items.slice(0, MAX_RECENT);
  emit();
  return item;
}

export function getShots(): readonly ShotItem[] {
  return items;
}

export function getShot(id: string | null): ShotItem | null {
  return (id && items.find((i) => i.id === id)) || null;
}

/** Replace an item's annotations (kept per capture while it is in the strip). */
export function setAnnotations(id: string, annotations: Annotation[]): void {
  let changed = false;
  items = items.map((i) => {
    if (i.id !== id || i.annotations === annotations) return i;
    changed = true;
    return { ...i, annotations };
  });
  if (changed) emit();
}

export function removeShot(id: string): void {
  const gone = items.find((i) => i.id === id);
  if (!gone) return;
  release(gone);
  items = items.filter((i) => i.id !== id);
  emit();
}

export function clearShots(): void {
  for (const i of items) release(i);
  items = [];
  emit();
}

export function subscribeShots(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The recent captures; re-renders on change. */
export function useShots(): readonly ShotItem[] {
  const [value, setValue] = useState(items);
  useEffect(() => {
    setValue(items);
    return subscribeShots(() => setValue(items));
  }, []);
  return value;
}

// ------------------------------------------------------------------------------------------ padding

/** Decoded sources of padded captures (the last two used: re-crops while a padding control is dragged). */
const bitmaps = new Map<Blob, Promise<ImageBitmap>>();
const BITMAPS_KEPT = 2;

function sourceBitmap(blob: Blob): Promise<ImageBitmap> {
  let bitmap = bitmaps.get(blob);
  if (bitmap) {
    bitmaps.delete(blob);
    bitmaps.set(blob, bitmap);
    return bitmap;
  }
  bitmap = createImageBitmap(blob);
  bitmaps.set(blob, bitmap);
  bitmap.catch(() => bitmaps.delete(blob));
  for (const old of [...bitmaps.keys()].slice(0, Math.max(0, bitmaps.size - BITMAPS_KEPT))) dropSourceBitmap(old);
  return bitmap;
}

function dropSourceBitmap(blob: Blob): void {
  const bitmap = bitmaps.get(blob);
  if (!bitmap) return;
  bitmaps.delete(blob);
  void bitmap.then(
    (b) => b.close(),
    () => undefined,
  );
}

/** Replace an item (same id), releasing what the old one held that the new one does not. */
function replaceItem(next: ShotItem): void {
  const old = items.find((i) => i.id === next.id);
  if (!old) {
    if (next.thumbUrl) URL.revokeObjectURL(next.thumbUrl);
    return;
  }
  if (old.thumbUrl && old.thumbUrl !== next.thumbUrl) URL.revokeObjectURL(old.thumbUrl);
  if (old.padded && old.padded.source.blob !== next.padded?.source.blob) dropSourceBitmap(old.padded.source.blob);
  items = items.map((i) => (i.id === next.id ? next : i));
  emit();
}

/** Re-crops in progress per item: the latest padding asked for wins (a dragged slider asks for many). */
const recrops = new Map<string, { padding: number; running: Promise<ShotItem | null> }>();

async function recrop(id: string, padding: number): Promise<ShotItem | null> {
  const item = getShot(id);
  const area = item?.padded;
  if (!item || !area) return null;
  if (padding === area.padding) return item;
  const cropped = await cropSource(area.source, padding, await sourceBitmap(area.source.blob));
  const current = getShot(id);
  if (!current?.padded || current.padded.source !== area.source) return current;
  // The page content under the annotations moved by the change of the crop's origin.
  const dx = area.crop.image.x - cropped.crop.image.x;
  const dy = area.crop.image.y - cropped.crop.image.y;
  const next: ShotItem = {
    ...current,
    blob: cropped.blob,
    width: cropped.width,
    height: cropped.height,
    pageRect: cropped.crop.rect,
    thumbUrl: await thumbnail(cropped.blob, cropped.width, cropped.height),
    annotations: shiftAnnotations(current.annotations, dx, dy),
    padded: { ...current.padded, padding, crop: cropped.crop },
  };
  replaceItem(next);
  return getShot(id);
}

/**
 * Show a padded capture with another padding, cropped from what was captured (no new capture). Beyond the captured
 * margin the crop stops at it (`padded.crop.short`): replaceShotArea with a new capture shows more. Resolves with the
 * updated item (null when it is gone or not a padded capture).
 */
export function setShotPadding(id: string, padding: number): Promise<ShotItem | null> {
  const pending = recrops.get(id);
  if (pending) {
    pending.padding = padding;
    return pending.running;
  }
  const entry = { padding, running: Promise.resolve<ShotItem | null>(null) };
  entry.running = (async () => {
    try {
      let done: number | null = null;
      let result: ShotItem | null = null;
      // Keep going until the latest asked padding is shown.
      while (done !== entry.padding) {
        done = entry.padding;
        result = await recrop(id, done);
      }
      return result;
    } finally {
      recrops.delete(id);
    }
  })();
  recrops.set(id, entry);
  return entry.running;
}

/** Install a new capture of the same element / region in an item (a padding beyond the captured margin). */
export async function replaceShotArea(id: string, capture: AreaCapture): Promise<ShotItem | null> {
  const current = getShot(id);
  if (!current) return null;
  const old = current.padded;
  // Annotations stay where they were relative to the element.
  const scale = capture.source.scale;
  const dx = old ? Math.round((capture.crop.sides.left - old.crop.sides.left) * scale) : 0;
  const dy = old ? Math.round((capture.crop.sides.top - old.crop.sides.top) * scale) : 0;
  const next: ShotItem = {
    ...current,
    ...outputOf(capture),
    label: capture.label ?? current.label,
    id: current.id,
    createdAt: current.createdAt,
    thumbUrl: await thumbnail(capture.blob, capture.width, capture.height),
    annotations: shiftAnnotations(current.annotations, dx, dy),
    padded: areaOf(capture),
  };
  replaceItem(next);
  return getShot(id);
}

// ------------------------------------------------------------------------------------------ selection

let selection: string | null = null;
const selectionListeners = new Set<() => void>();

/** Ask the screenshot tool to show capture `id` (taken when it mounts, or right away when it is mounted). */
export function requestShotSelection(id: string): void {
  selection = id;
  for (const fn of [...selectionListeners]) fn();
}

/** The capture the tool was asked to show (consumed), or null. */
export function takeShotSelection(): string | null {
  const id = selection;
  selection = null;
  return id;
}

export function onShotSelection(fn: () => void): () => void {
  selectionListeners.add(fn);
  return () => {
    selectionListeners.delete(fn);
  };
}
