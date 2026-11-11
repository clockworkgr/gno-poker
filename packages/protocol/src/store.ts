/** Minimal async key-value store used to persist hand secrets and recorded passes. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** All keys starting with prefix. */
  keys(prefix: string): Promise<string[]>;
}

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async keys(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

/** The subset of the DOM Storage interface used by WebStorageStore. */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** KeyValueStore over localStorage/sessionStorage (or anything shaped like them). */
export class WebStorageStore implements KeyValueStore {
  private readonly storage: StorageLike;
  constructor(storage: StorageLike) {
    this.storage = storage;
  }
  async get(key: string): Promise<string | null> {
    return this.storage.getItem(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.storage.setItem(key, value);
  }
  async delete(key: string): Promise<void> {
    this.storage.removeItem(key);
  }
  async keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k !== null && k.startsWith(prefix)) out.push(k);
    }
    return out;
  }
}
