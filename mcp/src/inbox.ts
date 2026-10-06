// Items the user sent from the overlay ("Send to Claude Code") that this session has not read yet. Kept in
// memory only (bounded), oldest first; the `inbox` tool returns the unseen ones and marks them seen.
import type { InboxItem } from '../../src/shared/claude-protocol';

export const INBOX_MAX_ITEMS = 20;

export class Inbox {
  private items: Array<{ item: InboxItem; seen: boolean }> = [];

  constructor(private readonly max: number = INBOX_MAX_ITEMS) {}

  /** Queue an item (ignored when its id is already queued). Drops the oldest beyond the limit. */
  add(item: InboxItem): boolean {
    if (this.items.some((entry) => entry.item.id === item.id)) return false;
    this.items.push({ item, seen: false });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    return true;
  }

  get unseenCount(): number {
    return this.items.filter((entry) => !entry.seen).length;
  }

  /** Unseen items, oldest first; they are marked seen. */
  takeUnseen(): InboxItem[] {
    const out: InboxItem[] = [];
    for (const entry of this.items) {
      if (entry.seen) continue;
      entry.seen = true;
      out.push(entry.item);
    }
    return out;
  }

  /** Remove everything; returns how many items were dropped. */
  clear(): number {
    const count = this.items.length;
    this.items = [];
    return count;
  }
}
