// Per-table session keys, kept in this browser's localStorage. A session key can sign protocol
// and betting transactions for its seat but cannot withdraw: Join, TopUp and Leave are owner only.

import { type KeyPair, generateKeyPair, keyPairFromPrivate } from "../chain/keys.ts";
import { toHex } from "@gno-poker/protocol";

export interface StoredSessionKey {
  privateKeyHex: string;
  address: string;
  tableId: number;
  owner: string;
  createdAt: number;
}

function k(chainId: string, realm: string, tableId: number, owner: string): string {
  return `gno-poker:session:${chainId}:${realm}:${tableId}:${owner}`;
}

export function loadSessionKey(chainId: string, realm: string, tableId: number, owner: string): (StoredSessionKey & { key: KeyPair }) | null {
  try {
    const raw = localStorage.getItem(k(chainId, realm, tableId, owner));
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSessionKey;
    return { ...s, key: keyPairFromPrivate(s.privateKeyHex) };
  } catch {
    return null;
  }
}

/** Generates and stores a new session key for a table, replacing any previous one. */
export function createSessionKey(chainId: string, realm: string, tableId: number, owner: string): StoredSessionKey & { key: KeyPair } {
  const key = generateKeyPair();
  const s: StoredSessionKey = { privateKeyHex: toHex(key.privateKey), address: key.address, tableId, owner, createdAt: Date.now() };
  localStorage.setItem(k(chainId, realm, tableId, owner), JSON.stringify(s));
  return { ...s, key };
}

export function forgetSessionKey(chainId: string, realm: string, tableId: number, owner: string): void {
  localStorage.removeItem(k(chainId, realm, tableId, owner));
}
