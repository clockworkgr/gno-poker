// KeyValueStore over IndexedDB. Deck passes are 13 KB of base64 each (up to 12 per hand), which
// would crowd localStorage's ~5 MB quota; IndexedDB has room and works inside the Web Worker.

import type { KeyValueStore } from "@gno-poker/protocol";

const STORE = "kv";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IndexedDbStore implements KeyValueStore {
  private readonly db: Promise<IDBDatabase>;

  constructor(name = "gno-poker", factory: IDBFactory = indexedDB) {
    this.db = new Promise((resolve, reject) => {
      const open = factory.open(name, 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.db).transaction(STORE, mode).objectStore(STORE);
  }

  async get(key: string): Promise<string | null> {
    const v = await req((await this.tx("readonly")).get(key));
    return typeof v === "string" ? v : null;
  }

  async set(key: string, value: string): Promise<void> {
    // Resolve only once the transaction is durable: the seed must survive a reload.
    const store = await this.tx("readwrite");
    const done = new Promise<void>((resolve, reject) => {
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => reject(store.transaction.error);
      store.transaction.onabort = () => reject(store.transaction.error ?? new Error("IndexedDB write aborted"));
    });
    store.put(value, key);
    await done;
  }

  async delete(key: string): Promise<void> {
    await req((await this.tx("readwrite")).delete(key));
  }

  async keys(prefix: string): Promise<string[]> {
    const range = IDBKeyRange.bound(prefix, prefix + "￿");
    const ks = await req((await this.tx("readonly")).getAllKeys(range));
    return ks.map(String).filter((k) => k.startsWith(prefix));
  }
}
