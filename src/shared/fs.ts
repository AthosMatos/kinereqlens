/**
 * Folder browser messages of the embedded terminal (src/shared/claude-protocol.ts `FsToHost` / `FsFromHost`):
 * strict validation shared by the panel, the service worker and the hub. Pure, no chrome.* / node APIs.
 */
import { FS_MAX_ENTRIES, FS_MAX_NAME_CHARS, FS_MAX_PROJECTS, PTY_MAX_CWD_CHARS } from './claude-protocol';
import type { FsEntry, FsFromHost, FsProject, FsToHost } from './claude-protocol';
import { isPtyCwdInput, isPtyId } from './pty';

/** Max chars of an `fs-error` message. */
export const FS_MAX_ERROR_CHARS = 2000;
/** Paths from the hub are resolved (no `~`), so they may be a little longer than typed ones. */
const MAX_PATH_CHARS = PTY_MAX_CWD_CHARS * 2;

/** The worker answers this when the hub is too old to browse folders. */
export const FS_UNSUPPORTED_ERROR = 'The folder browser needs an updated kineReqLens bridge — run `npm run mcp:install` in your reqlens checkout';

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Is `t` the type of a folder browser message? */
export function isFsMessageType(t: unknown): boolean {
  return typeof t === 'string' && t.startsWith('fs-');
}

/** A folder name: 1..FS_MAX_NAME_CHARS chars, not `.` / `..`, without separators or control characters. */
export function isFsName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= FS_MAX_NAME_CHARS &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/]/.test(value) &&
    !CONTROL_RE.test(value)
  );
}

/** A path sent back by the hub: non-empty, bounded, without control characters. */
export function isFsPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_CHARS && !CONTROL_RE.test(value);
}

/** Validate an extension → hub folder request (null = invalid). */
export function parseFsToHost(value: unknown): FsToHost | null {
  if (!isRecord(value) || !isPtyId(value.id)) return null;
  const id = value.id;
  switch (value.t) {
    case 'fs-list':
      return isPtyCwdInput(value.path) ? { t: 'fs-list', id, path: value.path } : null;
    case 'fs-pick': {
      if (value.startPath === undefined || value.startPath === null || value.startPath === '') return { t: 'fs-pick', id };
      return isPtyCwdInput(value.startPath) ? { t: 'fs-pick', id, startPath: value.startPath } : null;
    }
    case 'fs-projects': {
      if (value.refresh !== undefined && typeof value.refresh !== 'boolean') return null;
      return value.refresh ? { t: 'fs-projects', id, refresh: true } : { t: 'fs-projects', id };
    }
    default:
      return null;
  }
}

function parseEntry(value: unknown): FsEntry | null {
  if (!isRecord(value) || !isFsName(value.name)) return null;
  const entry: FsEntry = { name: value.name, dir: true, hidden: value.hidden === true };
  if (value.git === true) entry.git = true;
  if (value.project === true) entry.project = true;
  return entry;
}

function parseProject(value: unknown): FsProject | null {
  if (!isRecord(value) || !isFsPath(value.path) || !isFsName(value.name)) return null;
  const project: FsProject = { path: value.path, name: value.name, git: value.git === true };
  if (value.project === true) project.project = true;
  return project;
}

/** Validate a hub → extension folder answer (null = invalid or not a folder message). Bad entries are dropped. */
export function parseFsFromHost(value: unknown): FsFromHost | null {
  if (!isRecord(value) || !isPtyId(value.id)) return null;
  const id = value.id;
  switch (value.t) {
    case 'fs-listed': {
      if (!isFsPath(value.path) || !isFsPath(value.home) || !Array.isArray(value.entries)) return null;
      if (value.parent !== null && !isFsPath(value.parent)) return null;
      const entries: FsEntry[] = [];
      for (const raw of value.entries.slice(0, FS_MAX_ENTRIES)) {
        const entry = parseEntry(raw);
        if (entry) entries.push(entry);
      }
      const out: FsFromHost = { t: 'fs-listed', id, path: value.path, parent: value.parent, entries, home: value.home, sep: value.sep === '\\' ? '\\' : '/' };
      if (value.truncated === true || value.entries.length > FS_MAX_ENTRIES) out.truncated = true;
      return out;
    }
    case 'fs-picked':
      if (value.path === null) return { t: 'fs-picked', id, path: null };
      return isFsPath(value.path) ? { t: 'fs-picked', id, path: value.path } : null;
    case 'fs-projects-listed': {
      if (!Array.isArray(value.projects) || !isFsPath(value.home)) return null;
      const projects: FsProject[] = [];
      for (const raw of value.projects.slice(0, FS_MAX_PROJECTS)) {
        const project = parseProject(raw);
        if (project) projects.push(project);
      }
      const out: FsFromHost = { t: 'fs-projects-listed', id, projects, home: value.home };
      if (value.truncated === true || value.projects.length > FS_MAX_PROJECTS) out.truncated = true;
      return out;
    }
    case 'fs-error': {
      const error = typeof value.error === 'string' && value.error ? value.error.slice(0, FS_MAX_ERROR_CHARS) : 'Folder browser error';
      return { t: 'fs-error', id, error };
    }
    default:
      return null;
  }
}
