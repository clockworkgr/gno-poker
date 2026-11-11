// Durable KeyValueStore for bots: one JSON file, rewritten atomically on every change.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KeyValueStore } from "@gno-poker/protocol";

export class FileStore implements KeyValueStore {
  private readonly data: Map<string, string>;
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    let init: Record<string, string> = {};
    try {
      init = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    } catch {
      // new store
    }
    this.data = new Map(Object.entries(init));
  }
  private flush(): void {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data)));
    renameSync(tmp, this.path);
  }
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
    this.flush();
  }
  async delete(key: string): Promise<void> {
    if (this.data.delete(key)) this.flush();
  }
  async keys(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}
