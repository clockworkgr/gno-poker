// secp256k1 keys and gno (bech32 "g") addresses, without Node built-ins.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { fromHex, randomBytes, toHex } from "@gno-poker/protocol";

/** The gnodev / gnoland test1 mnemonic. Public; for local development only. */
export const TEST1_MNEMONIC =
  "source bonus chronic canvas draft south burst lottery vacant surface solve popular case indicate oppose farm nothing bullet exhibit title speed wink action roast";

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array; // compressed, 33 bytes
  address: string;
}

export function addressOfPubKey(pub: Uint8Array, prefix = "g"): string {
  return bech32.encode(prefix, bech32.toWords(ripemd160(sha256(pub))));
}

export function keyPairFromPrivate(priv: Uint8Array | string): KeyPair {
  const privateKey = typeof priv === "string" ? fromHex(priv.trim()) : priv;
  if (privateKey.length !== 32) throw new Error("private key must be 32 bytes");
  if (!secp256k1.utils.isValidSecretKey(privateKey)) throw new Error("invalid secp256k1 private key");
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return { privateKey, publicKey, address: addressOfPubKey(publicKey) };
}

/** Derives m/44'/118'/0'/0/index, the path gnokey and Adena use. */
export function keyPairFromMnemonic(mnemonic: string, index = 0): KeyPair {
  const m = mnemonic.trim().split(/\s+/).join(" ");
  if (!validateMnemonic(m, wordlist)) throw new Error("invalid mnemonic");
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(m));
  const child = root.derive(`m/44'/118'/0'/0/${index}`);
  if (!child.privateKey) throw new Error("derivation failed");
  return keyPairFromPrivate(child.privateKey);
}

/** A fresh random key (session keys). */
export function generateKeyPair(): KeyPair {
  for (;;) {
    const k = randomBytes(32);
    if (secp256k1.utils.isValidSecretKey(k)) return keyPairFromPrivate(k);
  }
}

/** 64-byte r||s signature over sha256(data), low-S. */
export function signData(privateKey: Uint8Array, data: Uint8Array): Uint8Array {
  return secp256k1.sign(data, privateKey, { prehash: true, lowS: true, format: "compact" });
}

export function isValidAddress(a: string): boolean {
  try {
    const d = bech32.decode(a as `${string}1${string}`);
    return d.prefix === "g" && bech32.fromWords(d.words).length === 20;
  } catch {
    return false;
  }
}

export function privateKeyHex(k: KeyPair): string {
  return toHex(k.privateKey);
}
