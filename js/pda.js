// Program-derived addresses (PDAs) and associated token accounts.

import { b58decode, b58encode } from './b58.js?v=2.3.0';
import { concat, textEncoder } from './bytes.js?v=2.3.0';
import { isOnCurve } from './ed25519.js?v=2.3.0';

const MARKER = textEncoder.encode('ProgramDerivedAddress');
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export function toBytes(k) {
  if (k instanceof Uint8Array) return k;
  if (typeof k === 'string') {
    const b = b58decode(k);
    if (b.length !== 32) throw new Error('Not a 32-byte address: ' + k);
    return b;
  }
  throw new TypeError('Expected an address');
}

export function seed(s) {
  if (typeof s === 'string') return textEncoder.encode(s);
  return s;
}

export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export async function createProgramAddress(seeds, programId) {
  for (const s of seeds) if (s.length > 32) throw new Error('PDA seed longer than 32 bytes');
  const h = await sha256(concat(...seeds, toBytes(programId), MARKER));
  return isOnCurve(h) ? null : h;
}

const cache = new Map();

/** Returns [address (base58), bump]. */
export async function findProgramAddress(seeds, programId) {
  const parts = seeds.map(seed);
  const key = parts.map((p) => b58encode(p)).join('|') + '@' + (typeof programId === 'string' ? programId : b58encode(programId));
  const hit = cache.get(key);
  if (hit) return hit;
  for (let bump = 255; bump >= 0; bump--) {
    const addr = await createProgramAddress([...parts, Uint8Array.of(bump)], programId);
    if (addr) {
      const res = [b58encode(addr), bump];
      if (cache.size > 5000) cache.clear();
      cache.set(key, res);
      return res;
    }
  }
  throw new Error('Could not find a program address');
}

export async function pda(seeds, programId) {
  return (await findProgramAddress(seeds, programId))[0];
}

/** Associated token account of `owner` for `mint` under `tokenProgram`. */
export async function associatedTokenAddress(owner, mint, tokenProgram) {
  return pda([toBytes(owner), toBytes(tokenProgram), toBytes(mint)], ATA_PROGRAM);
}
