/**
 * "Send to Claude" of the screenshot tool (docs/CLAUDE_INTEGRATION.md "Send a screenshot to Claude"): the annotated
 * PNG travels panel → worker → hub in base64 chunks (`shot-save`), the hub writes it to $REQLENS_HOME/shots/<id>.png
 * (folder 0700, file 0600; kept 24 h, ≤ 200 files / 200 MB) and answers the absolute path (`shot-saved`). The path
 * then goes to a Claude Code session (InboxItem.images) or is typed into an embedded terminal.
 *
 *   panel ──panel link──► worker (src/background/claude/shots.ts, ShotRelay: worker ids, bounds, timeouts)
 *         shot-save {id, seq, total, data}      │ native messaging (each chunk < 1 MB)
 *                                               ▼
 *                     hub (mcp/src/shots.ts, ShotStore: assemble, PNG check, write, retention)
 *         shot-saved {id, path, bytes} / shot-error {id, error} ◄──
 *
 * Pure: no chrome.* / node APIs (shared by the panel, the worker, the hub and the MCP server).
 */
import { isPtyId } from './pty';

/** Feature the hub announces in its hello when it serves `shot-save` (older hubs drop it). */
export const HUB_FEATURE_SHOTS = 'shots';
/** Max PNG size (bytes). */
export const SHOT_MAX_BYTES = 20 * 1024 * 1024;
/** Max base64 chars of a PNG of SHOT_MAX_BYTES. */
export const SHOT_MAX_B64_CHARS = 4 * Math.ceil(SHOT_MAX_BYTES / 3);
/** base64 chars per chunk (a multiple of 4: every chunk but the last decodes on its own). */
export const SHOT_CHUNK_CHARS = 512 * 1024;
/** Max chunks of one image. */
export const SHOT_MAX_CHUNKS = Math.ceil(SHOT_MAX_B64_CHARS / SHOT_CHUNK_CHARS);
/** The hub keeps saved screenshots this long… */
export const SHOT_RETENTION_MS = 24 * 60 * 60_000;
/** …and at most this many / this many bytes (oldest go first). */
export const SHOT_MAX_FILES = 200;
export const SHOT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** The hub prunes old screenshots this often (and on start). */
export const SHOT_PRUNE_INTERVAL_MS = 60 * 60_000;
/** An upload whose next chunk does not arrive within this is dropped (hub) / failed (worker). */
export const SHOT_UPLOAD_TIMEOUT_MS = 60_000;
/** Images of one inbox item. */
export const INBOX_MAX_IMAGES = 4;
/** Max chars of an image name. */
export const SHOT_MAX_NAME_CHARS = 200;
/** The MCP `inbox` tool returns images up to this size inline (bigger: the path, to Read). */
export const INBOX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** Max chars of an error message. */
export const SHOT_MAX_ERROR_CHARS = 2000;
/** The worker answers this when the hub is too old to save screenshots. */
export const SHOT_UNSUPPORTED_ERROR = 'Sending screenshots needs an updated kineReqLens bridge — run `npm run mcp:install` in your reqlens checkout';

/** extension → hub: one chunk of a PNG (base64). `name` (display name) only matters on the first chunk. */
export interface ShotToHost {
  t: 'shot-save';
  id: string;
  /** 0-based chunk index. */
  seq: number;
  /** Number of chunks. */
  total: number;
  data: string;
  name?: string;
}

/** hub → extension: the PNG was written (absolute `path`), or why not. */
export type ShotFromHost = { t: 'shot-saved'; id: string; path: string; bytes: number } | { t: 'shot-error'; id: string; error: string };

/** A screenshot attached to an inbox item ("Send to Claude" of the screenshot tool). */
export interface InboxImage {
  /** Absolute path of the PNG the hub saved ($REQLENS_HOME/shots/<id>.png). */
  path: string;
  /** Display name. */
  name: string;
  /** Pixel size. */
  width: number;
  height: number;
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const FILE_ID_RE = /^shot-[A-Za-z0-9_-]{1,64}$/;
const ABSOLUTE_RE = /^(?:\/|[A-Za-z]:[\\/])/;
const MAX_PATH_CHARS = 8192;
const MAX_DIM = 100_000;

export function isShotMessageType(t: unknown): boolean {
  return typeof t === 'string' && t.startsWith('shot-');
}

/** The id the hub names the file after (worker-chosen): `shot-[A-Za-z0-9_-]{1,64}`. */
export function isShotFileId(value: unknown): value is string {
  return typeof value === 'string' && FILE_ID_RE.test(value);
}

/** A display name: 1..SHOT_MAX_NAME_CHARS chars without control characters. */
export function isShotName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= SHOT_MAX_NAME_CHARS && !CONTROL_RE.test(value);
}

/** An absolute path of a PNG (bounded, no control characters). */
export function isShotPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PATH_CHARS && ABSOLUTE_RE.test(value) && /\.png$/i.test(value) && !CONTROL_RE.test(value);
}

function isDim(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_DIM;
}

function isChunkIndex(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < max;
}

/**
 * Validate a `shot-save` chunk (null = invalid). `fileIds`: the id must be a hub file id (hub side; the panel uses
 * terminal-style ids, the worker rewrites them). Chunks are whole base64 quads; only the last may carry padding.
 */
export function parseShotToHost(value: unknown, options: { fileIds?: boolean } = {}): ShotToHost | null {
  if (!isRecord(value) || value.t !== 'shot-save') return null;
  if (options.fileIds ? !isShotFileId(value.id) : !isPtyId(value.id)) return null;
  const { seq, total, data } = value;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 1 || total > SHOT_MAX_CHUNKS) return null;
  if (!isChunkIndex(seq, total)) return null;
  if (typeof data !== 'string' || data.length === 0 || data.length > SHOT_CHUNK_CHARS || data.length % 4 !== 0 || !BASE64_RE.test(data)) return null;
  if (seq < total - 1 && data.includes('=')) return null;
  const out: ShotToHost = { t: 'shot-save', id: value.id as string, seq, total, data };
  if (value.name !== undefined && value.name !== null) {
    if (!isShotName(value.name)) return null;
    out.name = value.name;
  }
  return out;
}

/** Validate a hub → extension screenshot answer (null = invalid). */
export function parseShotFromHost(value: unknown): ShotFromHost | null {
  if (!isRecord(value) || !(isShotFileId(value.id) || isPtyId(value.id))) return null;
  const id = value.id as string;
  if (value.t === 'shot-saved') {
    if (!isShotPath(value.path)) return null;
    const bytes = typeof value.bytes === 'number' && Number.isInteger(value.bytes) && value.bytes > 0 && value.bytes <= SHOT_MAX_BYTES ? value.bytes : null;
    return bytes === null ? null : { t: 'shot-saved', id, path: value.path, bytes };
  }
  if (value.t === 'shot-error') {
    const error = typeof value.error === 'string' && value.error ? value.error.slice(0, SHOT_MAX_ERROR_CHARS) : 'Could not save the screenshot';
    return { t: 'shot-error', id, error };
  }
  return null;
}

/** One validated inbox image (null = invalid). */
export function parseInboxImage(value: unknown): InboxImage | null {
  if (!isRecord(value) || !isShotPath(value.path) || !isShotName(value.name) || !isDim(value.width) || !isDim(value.height)) return null;
  return { path: value.path, name: value.name, width: value.width, height: value.height };
}

/**
 * The `images` of an inbox item: undefined / null → none ([]); otherwise every image must be valid and there are
 * at most INBOX_MAX_IMAGES (null = invalid).
 */
export function parseInboxImages(value: unknown): InboxImage[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > INBOX_MAX_IMAGES) return null;
  const out: InboxImage[] = [];
  for (const raw of value) {
    const image = parseInboxImage(raw);
    if (!image) return null;
    out.push(image);
  }
  return out;
}

/** Split base64 into SHOT_CHUNK_CHARS chunks (`size` is rounded down to a multiple of 4). */
export function chunkBase64(base64: string, size = SHOT_CHUNK_CHARS): string[] {
  const step = Math.max(4, size - (size % 4));
  const out: string[] = [];
  for (let i = 0; i < base64.length; i += step) out.push(base64.slice(i, i + step));
  return out;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Starts with the PNG signature. */
export function isPngMagic(bytes: ArrayLike<number>): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

/** A fresh worker-side file id (isShotFileId rules). */
export function newShotFileId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `shot-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The line a Claude Code session gets with a screenshot (channel notification, inbox). */
export function screenshotLine(path: string): string {
  return `Screenshot: ${path} (use the Read tool to view it)`;
}
