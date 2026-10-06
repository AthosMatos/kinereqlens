// "Send to Claude" screenshots, hub side (src/shared/shot-protocol.ts): assembles the `shot-save` chunks of the
// extension, checks the PNG (signature, ≤ SHOT_MAX_BYTES), writes it to $REQLENS_HOME/shots/<id>.png (folder 0700,
// file 0600) and answers the absolute path (`shot-saved`) or the reason (`shot-error`).
//
// Retention: files are kept SHOT_RETENTION_MS (24 h) — a Claude Code session reads them later —, pruned on start and
// every SHOT_PRUNE_INTERVAL_MS, and capped at SHOT_MAX_FILES / SHOT_MAX_TOTAL_BYTES (oldest first). Only `shot-*.png`
// files are touched: the Errors view's run screenshots (`run-*`, `upload-*`, mcp/src/runs.ts) live next to them.
import fs from 'node:fs';
import path from 'node:path';
import {
  SHOT_MAX_BYTES,
  SHOT_MAX_FILES,
  SHOT_MAX_TOTAL_BYTES,
  SHOT_PRUNE_INTERVAL_MS,
  SHOT_RETENTION_MS,
  SHOT_UPLOAD_TIMEOUT_MS,
  isPngMagic,
  isShotFileId,
  type ShotFromHost,
  type ShotToHost,
} from '../../src/shared/shot-protocol';
import { type Logger, silentLogger } from './log';

/** Uploads assembled at the same time. */
export const SHOT_MAX_PENDING_UPLOADS = 4;
const FILE_RE = /^shot-[A-Za-z0-9_-]{1,64}\.png$/;

export interface ShotStoreOptions {
  /** <home>/shots */
  dir: string;
  send(message: ShotFromHost): void;
  logger?: Logger;
  platform?: NodeJS.Platform;
  now?(): number;
  retentionMs?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxBytes?: number;
  uploadTimeoutMs?: number;
  pruneIntervalMs?: number;
}

interface Upload {
  id: string;
  total: number;
  chunks: string[];
  chars: number;
  timer: NodeJS.Timeout | null;
}

export class ShotStore {
  readonly dir: string;
  private readonly uploads = new Map<string, Upload>();
  private readonly logger: Logger;
  private pruneTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: ShotStoreOptions) {
    this.dir = path.resolve(options.dir);
    this.logger = options.logger ?? silentLogger;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** Prune now and every SHOT_PRUNE_INTERVAL_MS. */
  start(): void {
    if (this.stopped || this.pruneTimer) return;
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), this.options.pruneIntervalMs ?? SHOT_PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  /** Stop pruning and drop partial uploads (saved files stay: sessions may still read them). */
  stop(): void {
    this.stopped = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    for (const upload of this.uploads.values()) if (upload.timer) clearTimeout(upload.timer);
    this.uploads.clear();
  }

  /** Uploads being assembled. */
  get pending(): number {
    return this.uploads.size;
  }

  /** A validated chunk from the extension. */
  handle(message: ShotToHost): void {
    const fail = (error: string): void => {
      const upload = this.uploads.get(message.id);
      if (upload) this.drop(upload);
      this.options.send({ t: 'shot-error', id: message.id, error });
    };
    if (this.stopped) return fail('The kineReqLens bridge is stopping');
    if (!isShotFileId(message.id)) return fail('Invalid screenshot id');
    let upload = this.uploads.get(message.id);
    if (message.seq === 0) {
      if (upload) return fail('A screenshot with this id is already being saved');
      if (this.uploads.size >= SHOT_MAX_PENDING_UPLOADS) return fail('Too many screenshots at once — try again');
      upload = { id: message.id, total: message.total, chunks: [], chars: 0, timer: null };
      this.uploads.set(upload.id, upload);
    } else if (!upload) {
      return fail('Unknown screenshot upload');
    }
    if (message.seq !== upload.chunks.length || message.total !== upload.total) return fail('Screenshot chunks out of order');
    upload.chunks.push(message.data);
    upload.chars += message.data.length;
    const maxBytes = this.options.maxBytes ?? SHOT_MAX_BYTES;
    if (upload.chars > 4 * Math.ceil(maxBytes / 3)) return fail(`The screenshot is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    if (upload.chunks.length < upload.total) {
      this.arm(upload);
      return;
    }
    this.drop(upload);
    this.write(upload);
  }

  private arm(upload: Upload): void {
    if (upload.timer) clearTimeout(upload.timer);
    upload.timer = setTimeout(() => {
      if (this.uploads.get(upload.id) !== upload) return;
      this.drop(upload);
      this.logger.warn(`screenshot ${upload.id} dropped: incomplete`);
    }, this.options.uploadTimeoutMs ?? SHOT_UPLOAD_TIMEOUT_MS);
    upload.timer.unref?.();
  }

  private drop(upload: Upload): void {
    if (upload.timer) clearTimeout(upload.timer);
    upload.timer = null;
    if (this.uploads.get(upload.id) === upload) this.uploads.delete(upload.id);
  }

  private write(upload: Upload): void {
    const fail = (error: string): void => this.options.send({ t: 'shot-error', id: upload.id, error });
    const bytes = Buffer.from(upload.chunks.join(''), 'base64');
    const maxBytes = this.options.maxBytes ?? SHOT_MAX_BYTES;
    if (bytes.length > maxBytes) return fail(`The screenshot is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    if (!isPngMagic(bytes)) return fail('Not a PNG image');
    const file = path.join(this.dir, `${upload.id}.png`);
    try {
      this.ensureDir();
      // `wx`: never follow / overwrite something already there.
      fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
      if ((this.options.platform ?? process.platform) !== 'win32') fs.chmodSync(file, 0o600);
    } catch (err) {
      this.logger.warn(`screenshot ${upload.id} not saved: ${err instanceof Error ? err.message : String(err)}`);
      return fail(`Could not save the screenshot: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.logger.info(`screenshot ${upload.id} saved (${bytes.length} bytes)`);
    this.prune(file);
    this.options.send({ t: 'shot-saved', id: upload.id, path: file, bytes: bytes.length });
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if ((this.options.platform ?? process.platform) === 'win32') return;
    const stat = fs.lstatSync(this.dir);
    if (!stat.isDirectory()) throw new Error(`${this.dir} is not a directory`);
    if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(this.dir, 0o700);
  }

  /**
   * Delete screenshots older than the retention, then the oldest beyond the file / byte caps (`keep`: a file just
   * written, never deleted by the caps). Returns how many files were removed.
   */
  prune(keep?: string): number {
    let entries: Array<{ file: string; mtime: number; size: number }>;
    try {
      entries = fs
        .readdirSync(this.dir)
        .filter((name) => FILE_RE.test(name))
        .flatMap((name) => {
          const file = path.join(this.dir, name);
          try {
            const stat = fs.lstatSync(file);
            return stat.isFile() ? [{ file, mtime: stat.mtimeMs, size: stat.size }] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return 0; // no folder yet
    }
    const cutoff = this.now() - (this.options.retentionMs ?? SHOT_RETENTION_MS);
    let removed = 0;
    const remove = (file: string): void => {
      try {
        fs.rmSync(file, { force: true });
        removed++;
      } catch (err) {
        this.logger.warn(`cannot remove ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const fresh: typeof entries = [];
    for (const entry of entries) {
      if (entry.mtime < cutoff && entry.file !== keep) remove(entry.file);
      else fresh.push(entry);
    }
    // Oldest first.
    fresh.sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));
    const maxFiles = this.options.maxFiles ?? SHOT_MAX_FILES;
    const maxTotal = this.options.maxTotalBytes ?? SHOT_MAX_TOTAL_BYTES;
    let count = fresh.length;
    let total = fresh.reduce((sum, e) => sum + e.size, 0);
    for (const entry of fresh) {
      if (count <= maxFiles && total <= maxTotal) break;
      if (entry.file === keep) continue;
      remove(entry.file);
      count--;
      total -= entry.size;
    }
    if (removed) this.logger.info(`pruned ${removed} screenshot(s)`);
    return removed;
  }
}
