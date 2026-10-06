/**
 * Errors view settings helpers (pure): `settings.projectFolders` (page host → project folder) sanitizing, equality
 * and updates, and the host key of a page.
 */
import { isPtyCwdInput } from './pty';

/** Hosts with a project folder kept at most. */
export const MAX_PROJECT_FOLDERS = 200;

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV6_RE = /^\[[0-9a-f:.]{2,45}\]$/;

/** A host key: lower-case host name, IPv4 or bracketed IPv6 (no port), ≤ 253 chars. */
export function isHostKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 253 && (HOST_RE.test(value) || IPV6_RE.test(value));
}

/** The project-folder key of a page URL (its host name), or null for non-http(s) pages. */
export function projectHostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    return isHostKey(host) ? host : null;
  } catch {
    return null;
  }
}

/** Valid hosts → valid folders (trimmed), ≤ MAX_PROJECT_FOLDERS. */
export function sanitizeProjectFolders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= MAX_PROJECT_FOLDERS) break;
    const host = key.trim().toLowerCase();
    if (!isHostKey(host) || typeof raw !== 'string') continue;
    const dir = raw.trim();
    if (!isPtyCwdInput(dir) || Object.prototype.hasOwnProperty.call(out, host)) continue;
    out[host] = dir;
    count++;
  }
  return out;
}

export function projectFoldersEqual(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] === a[k]);
}

/** `folders` with `host` mapped to `dir` (null removes it). Over the cap, new hosts are refused (unchanged). */
export function withProjectFolder(folders: Readonly<Record<string, string>>, host: string, dir: string | null): Record<string, string> {
  const next: Record<string, string> = { ...folders };
  if (dir === null) {
    delete next[host];
    return next;
  }
  if (!Object.prototype.hasOwnProperty.call(next, host) && Object.keys(next).length >= MAX_PROJECT_FOLDERS) return next;
  next[host] = dir.trim();
  return sanitizeProjectFolders(next);
}
