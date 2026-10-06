// Display helpers of the WebSocket inspector (pure).
import type { WsConnection } from '../../lib/ws';

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Time since the connection started: +86ms, +1.204s, +2m 03.4s, +1h 02m. */
export function relTime(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const v = Math.max(0, ms);
  if (v < 1000) return `+${Math.round(v)}ms`;
  if (v < 60_000) return `+${(v / 1000).toFixed(3)}s`;
  if (v < 3_600_000) {
    const m = Math.floor(v / 60_000);
    return `+${m}m ${pad(Math.floor((v % 60_000) / 1000))}.${Math.floor((v % 1000) / 100)}s`;
  }
  const h = Math.floor(v / 3_600_000);
  return `+${h}h ${pad(Math.floor((v % 3_600_000) / 60_000))}m`;
}

/** Compact age: now, 4s, 2m, 3h, 2d. */
export function ago(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 1500) return 'now';
  if (v < 60_000) return `${Math.round(v / 1000)}s`;
  if (v < 3_600_000) return `${Math.floor(v / 60_000)}m`;
  if (v < 86_400_000) return `${Math.floor(v / 3_600_000)}h`;
  return `${Math.floor(v / 86_400_000)}d`;
}

/** Live duration: 42s, 2m 03s, 1h 02m. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

/** 1,234 */
export function count(n: number): string {
  return n.toLocaleString('en-US');
}

/** Host and path (+ query) of a ws:// URL for the sidebar. */
export function wsUrlParts(url: string): { host: string; path: string; secure: boolean } {
  try {
    const u = new URL(url);
    return { host: u.host, path: `${u.pathname}${u.search}`, secure: u.protocol === 'wss:' || u.protocol === 'https:' };
  } catch {
    return { host: url, path: '', secure: false };
  }
}

/** Human connection state, with the close code when closed. */
export function stateLabel(conn: WsConnection): string {
  switch (conn.state) {
    case 'connecting':
      return 'Connecting';
    case 'open':
      return 'Open';
    case 'closing':
      return 'Closing';
    case 'closed':
      return conn.closeCode !== undefined ? `Closed · ${conn.closeCode}${conn.closeReason ? ` ${conn.closeReason}` : ''}` : 'Closed';
  }
}

/** Dot tone of a connection: open / connecting / closing / closed / error. */
export function stateTone(conn: WsConnection): 'open' | 'connecting' | 'closing' | 'closed' | 'error' {
  if (conn.state === 'closed') return conn.wasClean === false && (conn.errors > 0 || conn.closeCode === 1006) ? 'error' : 'closed';
  return conn.state;
}

/** Index of the frame with `id` in an id-sorted array (binary search), or -1. */
export function indexOfId(frames: readonly { id: number }[], id: number | null): number {
  if (id === null) return -1;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = frames[mid]!.id;
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
