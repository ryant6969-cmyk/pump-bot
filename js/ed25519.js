// Minimal Ed25519 (RFC 8032) in plain JavaScript (BigInt).
// Used to derive a wallet address from its secret, to sign when the browser
// has no native Ed25519, and for the "is this point on the curve" check that
// Solana uses for program-derived addresses.
// test/crypto.test.mjs checks every function against Node's native Ed25519.

import { concat } from './bytes.js';

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const D2 = (2n * D) % P;
const BX = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const BY = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;

function mod(a, m = P) { const r = a % m; return r >= 0n ? r : r + m; }

function powMod(b, e, m = P) {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

function invert(a) { return powMod(a, P - 2n); }

// Points in extended coordinates [X, Y, Z, T] with x = X/Z, y = Y/Z, xy = T/Z.
const IDENTITY = [0n, 1n, 1n, 0n];
const BASE = [BX, BY, 1n, mod(BX * BY)];

// Complete addition formula for a = -1 twisted Edwards curves (add-2008-hwcd-3).
function add(p, q) {
  const [X1, Y1, Z1, T1] = p;
  const [X2, Y2, Z2, T2] = q;
  const A = mod((Y1 - X1) * (Y2 - X2));
  const B = mod((Y1 + X1) * (Y2 + X2));
  const C = mod(mod(T1 * D2) * T2);
  const Dd = mod(Z1 * 2n * Z2);
  const E = B - A, F = Dd - C, G = Dd + C, H = B + A;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}

// dbl-2008-hwcd for a = -1
function double(p) {
  const [X1, Y1, Z1] = p;
  const A = mod(X1 * X1);
  const B = mod(Y1 * Y1);
  const C = mod(2n * Z1 * Z1);
  const H = A + B;
  const E = mod(H - mod((X1 + Y1) * (X1 + Y1)));
  const G = A - B;
  const F = C + G;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}

function scalarMult(point, n) {
  let r = IDENTITY;
  let q = point;
  while (n > 0n) {
    if (n & 1n) r = add(r, q);
    q = double(q);
    n >>= 1n;
  }
  return r;
}

function numberToLE(n, len) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

function leToNumber(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

function encodePoint(p) {
  const [X, Y, Z] = p;
  const zi = invert(Z);
  const x = mod(X * zi);
  const y = mod(Y * zi);
  const out = numberToLE(y, 32);
  if (x & 1n) out[31] |= 0x80;
  return out;
}

async function sha512(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-512', data));
}

function clampedScalar(h) {
  const a = h.slice(0, 32);
  a[0] &= 248;
  a[31] &= 127;
  a[31] |= 64;
  return leToNumber(a);
}

/** Public key (32 bytes) for a 32-byte Ed25519 secret seed. */
export async function getPublicKey(seed) {
  if (seed.length !== 32) throw new Error('Secret seed must be 32 bytes');
  const h = await sha512(seed);
  return encodePoint(scalarMult(BASE, clampedScalar(h)));
}

/** Ed25519 signature (64 bytes) of `message` with a 32-byte secret seed. */
export async function sign(message, seed) {
  if (seed.length !== 32) throw new Error('Secret seed must be 32 bytes');
  const h = await sha512(seed);
  const a = clampedScalar(h);
  const prefix = h.subarray(32, 64);
  const A = encodePoint(scalarMult(BASE, a));
  const r = mod(leToNumber(await sha512(concat(prefix, message))), L);
  const R = encodePoint(scalarMult(BASE, r));
  const k = mod(leToNumber(await sha512(concat(R, A, message))), L);
  const S = mod(r + k * a, L);
  return concat(R, numberToLE(S, 32));
}

/**
 * True if 32 bytes decode to a point on the Ed25519 curve, using the same
 * rule as curve25519-dalek's CompressedEdwardsY::decompress (what Solana uses
 * to reject program-derived addresses): y is read mod p, the sign bit is
 * ignored, and the point exists iff (y^2 - 1) / (d*y^2 + 1) is a square.
 */
export function isOnCurve(bytes) {
  if (bytes.length !== 32) return false;
  const b = bytes.slice();
  b[31] &= 0x7f;
  const y = mod(leToNumber(b));
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const w = mod(u * invert(v));
  if (w === 0n) return true;
  return powMod(w, (P - 1n) / 2n) === 1n;
}
