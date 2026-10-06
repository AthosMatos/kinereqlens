/** Insertion-ordered Map / Set that drop their oldest items beyond a fixed capacity. */

export class BoundedMap<K, V> {
  private readonly items = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.items.size;
  }

  get(key: K): V | undefined {
    return this.items.get(key);
  }

  has(key: K): boolean {
    return this.items.has(key);
  }

  /** Insert or refresh (moves the key to the newest position). */
  set(key: K, value: V): void {
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.capacity) {
      const oldest = this.items.keys().next();
      if (oldest.done) break;
      this.items.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.items.delete(key);
  }

  /** Get and remove. */
  take(key: K): V | undefined {
    const value = this.items.get(key);
    this.items.delete(key);
    return value;
  }

  keys(): IterableIterator<K> {
    return this.items.keys();
  }

  clear(): void {
    this.items.clear();
  }
}

/** Insertion-ordered Set that drops its oldest values beyond a fixed capacity. */
export class BoundedSet<T> {
  private readonly items: BoundedMap<T, true>;

  constructor(capacity: number) {
    this.items = new BoundedMap(capacity);
  }

  add(value: T): void {
    this.items.set(value, true);
  }

  has(value: T): boolean {
    return this.items.has(value);
  }

  delete(value: T): boolean {
    return this.items.delete(value);
  }

  clear(): void {
    this.items.clear();
  }
}
