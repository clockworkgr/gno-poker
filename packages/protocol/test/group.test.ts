import { describe, expect, it } from "vitest";
import { P, P_HEX, P_MINUS_1, Q, isProbablePrime, isQuadraticResidue, modInverse, modPow } from "../src/index.ts";

function naivePow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    e >>= 1n;
    b = (b * b) % m;
  }
  return r;
}

describe("group", () => {
  it("P is the 2048-bit RFC 3526 group 14 prime", () => {
    expect(P_HEX.length).toBe(512);
    expect(P.toString(2).length).toBe(2048);
    expect(P_HEX.startsWith("FFFFFFFFFFFFFFFFC90FDAA22168C234")).toBe(true);
    expect(P_HEX.endsWith("8AACAA68FFFFFFFFFFFFFFFF")).toBe(true);
  });

  it("P and Q are probable primes", () => {
    expect(isProbablePrime(P, 20)).toBe(true);
    expect(isProbablePrime(Q, 20)).toBe(true);
    expect(P).toBe(2n * Q + 1n);
  });

  it("primality test rejects composites", () => {
    expect(isProbablePrime(P * 3n)).toBe(false);
    expect(isProbablePrime(561n)).toBe(false); // Carmichael
    expect(isProbablePrime(2n ** 127n - 1n)).toBe(true);
    expect(isProbablePrime(P + 2n)).toBe(false);
  });

  it("modPow matches square-and-multiply for 256- and 2048-bit exponents", () => {
    const base = 0x1234567890abcdefn ** 20n % P;
    for (const e of [0n, 1n, 2n, 65537n, (1n << 255n) + 12345n, P_MINUS_1 - 7n]) {
      expect(modPow(base, e, P)).toBe(naivePow(base, e, P));
    }
    expect(modPow(3n, 100n, 1000n)).toBe(naivePow(3n, 100n, 1000n)); // even modulus path
    expect(modPow(5n, 3n, 1n)).toBe(0n);
  });

  it("modInverse", () => {
    const e = (1n << 255n) | 1n;
    const d = modInverse(e, P_MINUS_1);
    expect((e * d) % P_MINUS_1).toBe(1n);
    expect(() => modInverse(2n, P_MINUS_1)).toThrow();
  });

  it("quadratic residue test", () => {
    expect(isQuadraticResidue(4n)).toBe(true);
    expect(isQuadraticResidue(P - 1n)).toBe(false); // -1 is a non-residue since P = 3 mod 4
  });
});
