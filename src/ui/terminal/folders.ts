// Pure path helpers of the terminal's folder browser (FolderPicker.tsx). Paths come resolved from the hub
// (absolute, with the hub's separator); nothing here touches the file system.
import type { FsEntry } from '../../shared/claude-protocol';

export type PathSep = '/' | '\\';

export interface Crumb {
  /** Segment label ("/" or "C:" for a root). */
  label: string;
  /** Absolute path up to and including this segment. */
  path: string;
}

/** Breadcrumb segments of an absolute path: POSIX `/a/b`, Windows `C:\a\b` and UNC `\\server\share\a`. */
export function breadcrumbs(path: string, sep: PathSep): Crumb[] {
  if (sep === '/') {
    const parts = path.split('/').filter(Boolean);
    const out: Crumb[] = [{ label: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      out.push({ label: part, path: acc });
    }
    return out;
  }
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(path);
  let root: Crumb;
  let rest: string;
  if (unc) {
    root = { label: `\\\\${unc[1]}\\${unc[2]}`, path: `\\\\${unc[1]}\\${unc[2]}\\` };
    rest = path.slice(unc[0].length);
  } else {
    const drive = /^([A-Za-z]:)/.exec(path);
    const label = drive ? drive[1]!.toUpperCase() : '\\';
    root = { label, path: drive ? `${label}\\` : '\\' };
    rest = drive ? path.slice(2) : path;
  }
  const out: Crumb[] = [root];
  let acc = root.path.replace(/\\$/, '');
  for (const part of rest.split('\\').filter(Boolean)) {
    acc += `\\${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

/** Breadcrumbs with everything up to the home directory folded into one `~` segment. */
export function homeBreadcrumbs(path: string, sep: PathSep, home: string | null | undefined): Crumb[] {
  const crumbs = breadcrumbs(path, sep);
  if (!home) return crumbs;
  const h = home.replace(/[\\/]+$/, '');
  const same = sep === '\\' ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b;
  const at = crumbs.findIndex((c) => same(c.path, h));
  if (at <= 0) return crumbs;
  return [{ label: '~', path: crumbs[at]!.path }, ...crumbs.slice(at + 1)];
}

/** `dir` + `name` with the hub's separator. */
export function childPath(dir: string, name: string, sep: PathSep): string {
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** The folder a typed / recent path lives in, as text (`~/a/b` → `~/a`, `/a` → `/`, `C:\a` → `C:\`). */
export function parentOfTyped(path: string): string | null {
  const trimmed = path.trim().replace(/(.)[\\/]+$/, '$1');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut < 0) return null;
  let parent = trimmed.slice(0, cut);
  if (!parent) parent = trimmed[0] === '\\' ? '\\' : '/';
  if (/^[A-Za-z]:$/.test(parent)) parent += '\\';
  return parent === trimmed ? null : parent;
}

/** Last segment of a path (`/a/b` → `b`). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * Entries shown for a filter: dot-folders only with `showHidden` (or when the filter itself starts with "."),
 * then the case-insensitive substring matches — names starting with the filter first.
 */
export function filterEntries(entries: readonly FsEntry[], query: string, showHidden: boolean): FsEntry[] {
  const q = query.trim().toLowerCase();
  const hiddenOk = showHidden || q.startsWith('.');
  const visible = entries.filter((e) => hiddenOk || !e.hidden);
  if (!q) return visible;
  const starts: FsEntry[] = [];
  const contains: FsEntry[] = [];
  for (const entry of visible) {
    const name = entry.name.toLowerCase();
    if (name.startsWith(q)) starts.push(entry);
    else if (name.includes(q)) contains.push(entry);
  }
  return [...starts, ...contains];
}

/** `path` with the home directory shown as `~`. */
export function tildePath(path: string, home: string | null | undefined, sep: PathSep = '/'): string {
  if (!home) return path;
  const h = home.replace(/[\\/]+$/, '');
  if (!h) return path;
  const same = sep === '\\' ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b;
  if (same(path, h)) return '~';
  if (path.length > h.length && same(path.slice(0, h.length), h) && path[h.length] === sep) return `~${path.slice(h.length)}`;
  return path;
}
