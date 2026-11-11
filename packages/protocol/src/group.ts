// Arithmetic in Z_P^* for the RFC 3526 group 14 prime.

/**
 * RFC 3526 2048-bit MODP group (group 14) prime.
 * Copied from golang.org/x/crypto/ssh/kex.go (oakleyGroup14).
 */
export const P_HEX =
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF";

export const P: bigint = BigInt("0x" + P_HEX);
/** (P-1)/2, prime. */
export const Q: bigint = (P - 1n) / 2n;
/** Group order of Z_P^*; exponents live mod P-1. */
export const P_MINUS_1: bigint = P - 1n;

function bitLength(x: bigint): number {
  return x === 0n ? 0 : x.toString(2).length;
}

/** Inverse of a modulo m, or throws if gcd(a, m) != 1. */
export function modInverse(a: bigint, m: bigint): bigint {
  a %= m;
  if (a < 0n) a += m;
  let [r0, r1] = [m, a];
  let [t0, t1] = [0n, 1n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [t0, t1] = [t1, t0 - q * t1];
  }
  if (r0 !== 1n) throw new Error("modular inverse does not exist");
  return t0 < 0n ? t0 + m : t0;
}

/** Montgomery context for an odd modulus; about twice as fast as plain BigInt % for 2048 bits. */
class Montgomery {
  readonly m: bigint;
  private readonly bits: bigint;
  private readonly mask: bigint;
  private readonly mPrime: bigint;
  private readonly r2: bigint;
  private readonly one: bigint;

  constructor(m: bigint) {
    if ((m & 1n) === 0n || m < 3n) throw new Error("Montgomery modulus must be odd");
    this.m = m;
    this.bits = BigInt(bitLength(m));
    const R = 1n << this.bits;
    this.mask = R - 1n;
    this.mPrime = (R - modInverse(m, R)) & this.mask;
    this.r2 = (R * R) % m;
    this.one = R % m;
  }

  private reduce(t: bigint): bigint {
    const u = (t + (((t & this.mask) * this.mPrime) & this.mask) * this.m) >> this.bits;
    return u >= this.m ? u - this.m : u;
  }

  pow(base: bigint, exp: bigint): bigint {
    const m = this.m;
    base %= m;
    if (base < 0n) base += m;
    if (exp === 0n) return 1n % m;
    const W = 5;
    const b = this.reduce(base * this.r2);
    const b2 = this.reduce(b * b);
    const table: bigint[] = [b];
    for (let i = 1; i < 1 << (W - 1); i++) table.push(this.reduce(table[i - 1]! * b2));
    const bits = exp.toString(2);
    const n = bits.length;
    let r = this.one;
    let i = 0;
    while (i < n) {
      if (bits.charCodeAt(i) === 48) {
        r = this.reduce(r * r);
        i++;
        continue;
      }
      let j = Math.min(i + W, n);
      while (bits.charCodeAt(j - 1) === 48) j--;
      const v = parseInt(bits.slice(i, j), 2);
      for (let k = i; k < j; k++) r = this.reduce(r * r);
      r = this.reduce(r * table[(v - 1) >> 1]!);
      i = j;
    }
    return this.reduce(r);
  }
}

const montCache = new Map<bigint, Montgomery>();

/** base^exp mod m for exp >= 0. Odd moduli use a cached Montgomery context. */
export function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  if (exp < 0n) throw new Error("negative exponent");
  if (m === 1n) return 0n;
  if ((m & 1n) === 1n) {
    let ctx = montCache.get(m);
    if (!ctx) {
      ctx = new Montgomery(m);
      if (montCache.size < 16) montCache.set(m, ctx);
    }
    return ctx.pow(base, exp);
  }
  let r = 1n;
  base %= m;
  if (base < 0n) base += m;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % m;
    exp >>= 1n;
    base = (base * base) % m;
  }
  return r;
}

/** Miller-Rabin with deterministic small-prime bases plus random bases. */
export function isProbablePrime(n: bigint, rounds = 32): boolean {
  if (n < 2n) return false;
  const small = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
  for (const p of small) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s++;
  }
  const bases: bigint[] = [...small];
  const byteLen = Math.ceil(bitLength(n) / 8);
  while (bases.length < rounds) {
    const buf = new Uint8Array(byteLen);
    globalThis.crypto.getRandomValues(buf);
    let a = 0n;
    for (const x of buf) a = (a << 8n) | BigInt(x);
    a = 2n + (a % (n - 3n));
    bases.push(a);
  }
  outer: for (const a of bases) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let r = 1; r < s; r++) {
      x = (x * x) % n;
      if (x === n - 1n) continue outer;
    }
    return false;
  }
  return true;
}

/** Legendre symbol test: true iff x is a nonzero quadratic residue mod P. */
export function isQuadraticResidue(x: bigint): boolean {
  return x % P !== 0n && modPow(x, Q, P) === 1n;
}
