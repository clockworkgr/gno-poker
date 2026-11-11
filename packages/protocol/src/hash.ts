import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "./bytes.ts";

/** SHA-256 of the concatenation of all parts. */
export function sha256(...parts: Uint8Array[]): Uint8Array {
  return nobleSha256(parts.length === 1 ? parts[0]! : concatBytes(...parts));
}
