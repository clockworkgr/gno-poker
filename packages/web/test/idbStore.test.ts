import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IndexedDbStore } from "../src/engine/idbStore.ts";

(globalThis as unknown as { IDBKeyRange: unknown }).IDBKeyRange = IDBKeyRange;

describe("IndexedDbStore", () => {
  it("stores, lists by prefix, survives reopening and deletes", async () => {
    const factory = new IDBFactory();
    const a = new IndexedDbStore("t", factory);
    const big = "x".repeat(13312 * 4 / 3);
    await a.set("ns/1/3/seed", "ab");
    await a.set("ns/1/3/pass/0", big);
    await a.set("ns/1/4/seed", "cd");
    await a.set("ns/10/1/seed", "ef");
    const b = new IndexedDbStore("t", factory); // a reload opens the database again
    expect(await b.get("ns/1/3/seed")).toBe("ab");
    expect((await b.get("ns/1/3/pass/0"))?.length).toBe(big.length);
    expect((await b.keys("ns/1/")).sort()).toEqual(["ns/1/3/pass/0", "ns/1/3/seed", "ns/1/4/seed"]);
    await b.delete("ns/1/3/seed");
    expect(await b.get("ns/1/3/seed")).toBeNull();
    expect(await b.get("missing")).toBeNull();
  });
});
