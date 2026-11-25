// Solana transactions: build legacy transactions, and read + sign any
// transaction format (legacy, v0, v1) returned by an outside service.

import { b58decode, b58encode } from './b58.js?v=2.4.0';
import { compactU16, concat, readCompactU16, readU16, readU32, u32le, u64le } from './bytes.js?v=2.4.0';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

/**
 * Compile a legacy message.
 * instructions: [{ programId, keys: [{ pubkey, isSigner, isWritable }], data: Uint8Array }]
 */
export function compileLegacyMessage({ payer, recentBlockhash, instructions }) {
  const metas = new Map();
  let order = 0;
  const add = (pubkey, isSigner, isWritable) => {
    const m = metas.get(pubkey);
    if (m) { m.isSigner ||= isSigner; m.isWritable ||= isWritable; }
    else metas.set(pubkey, { pubkey, isSigner, isWritable, order: order++ });
  };
  add(payer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) add(k.pubkey, !!k.isSigner, !!k.isWritable);
    add(ix.programId, false, false);
  }
  const rank = (m) => (m.pubkey === payer ? -1 : m.isSigner ? (m.isWritable ? 0 : 1) : (m.isWritable ? 2 : 3));
  const keys = [...metas.values()].sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  if (keys.length > 256) throw new Error('Too many accounts in one transaction');
  const index = new Map(keys.map((k, i) => [k.pubkey, i]));
  const numSigners = keys.filter((k) => k.isSigner).length;
  const numReadonlySigners = keys.filter((k) => k.isSigner && !k.isWritable).length;
  const numReadonlyUnsigned = keys.filter((k) => !k.isSigner && !k.isWritable).length;

  const parts = [
    Uint8Array.of(numSigners, numReadonlySigners, numReadonlyUnsigned),
    compactU16(keys.length),
    ...keys.map((k) => b58decode(k.pubkey)),
    b58decode(recentBlockhash),
    compactU16(instructions.length),
  ];
  for (const ix of instructions) {
    parts.push(
      Uint8Array.of(index.get(ix.programId)),
      compactU16(ix.keys.length),
      Uint8Array.from(ix.keys.map((k) => index.get(k.pubkey))),
      compactU16(ix.data.length),
      ix.data,
    );
  }
  for (const k of keys) if (b58decode(k.pubkey).length !== 32) throw new Error('Bad account address ' + k.pubkey);
  if (b58decode(recentBlockhash).length !== 32) throw new Error('Bad blockhash');
  return { message: concat(...parts), accountKeys: keys.map((k) => k.pubkey), numSigners };
}

/** Unsigned legacy transaction bytes (signature slots filled with zeros). */
export function buildLegacyTransaction(opts) {
  const { message, numSigners } = compileLegacyMessage(opts);
  const tx = concat(compactU16(numSigners), new Uint8Array(64 * numSigners), message);
  if (tx.length > 1232) throw new Error('Transaction too large (' + tx.length + ' bytes)');
  return tx;
}

/** Parse any Solana transaction (legacy, v0 or v1). */
export function parseTransaction(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) throw new Error('Empty transaction');
  if (bytes[0] === 0x81) return parseV1(bytes);
  let [numSigs, off] = readCompactU16(bytes, 0);
  const sigOffsets = [];
  for (let i = 0; i < numSigs; i++) { sigOffsets.push(off); off += 64; }
  const messageOffset = off;
  if (off >= bytes.length) throw new Error('Truncated transaction');
  let version = 'legacy';
  if (bytes[off] & 0x80) {
    const v = bytes[off] & 0x7f;
    if (v !== 0) throw new Error('Unsupported transaction version ' + v);
    version = 'v0';
    off++;
  }
  const header = { numRequiredSignatures: bytes[off], numReadonlySigned: bytes[off + 1], numReadonlyUnsigned: bytes[off + 2] };
  off += 3;
  let numKeys;
  [numKeys, off] = readCompactU16(bytes, off);
  const staticKeys = [];
  for (let i = 0; i < numKeys; i++) { staticKeys.push(b58encode(bytes.subarray(off, off + 32))); off += 32; }
  const recentBlockhash = b58encode(bytes.subarray(off, off + 32));
  off += 32;
  let numIx;
  [numIx, off] = readCompactU16(bytes, off);
  const instructions = [];
  for (let i = 0; i < numIx; i++) {
    const programIdIndex = bytes[off++];
    let n;
    [n, off] = readCompactU16(bytes, off);
    const accountIndexes = Array.from(bytes.subarray(off, off + n));
    off += n;
    let dl;
    [dl, off] = readCompactU16(bytes, off);
    const data = bytes.slice(off, off + dl);
    off += dl;
    instructions.push({ programIdIndex, accountIndexes, data });
  }
  const lookups = [];
  if (version === 'v0') {
    let nl;
    [nl, off] = readCompactU16(bytes, off);
    for (let i = 0; i < nl; i++) {
      const table = b58encode(bytes.subarray(off, off + 32));
      off += 32;
      let nw, nr;
      [nw, off] = readCompactU16(bytes, off);
      const writable = Array.from(bytes.subarray(off, off + nw)); off += nw;
      [nr, off] = readCompactU16(bytes, off);
      const readonly = Array.from(bytes.subarray(off, off + nr)); off += nr;
      lookups.push({ table, writable, readonly });
    }
  }
  if (off !== bytes.length) throw new Error('Unexpected bytes at the end of the transaction');
  if (numSigs !== header.numRequiredSignatures) throw new Error('Signature count mismatch');
  return {
    version, header, staticKeys, recentBlockhash, instructions, lookups,
    sigOffsets, message: bytes.subarray(messageOffset), messageOffset,
  };
}

function parseV1(bytes) {
  let off = 1;
  const header = { numRequiredSignatures: bytes[off], numReadonlySigned: bytes[off + 1], numReadonlyUnsigned: bytes[off + 2] };
  off += 3;
  const configMask = readU32(bytes, off); off += 4;
  const recentBlockhash = b58encode(bytes.subarray(off, off + 32)); off += 32;
  const numIx = bytes[off++];
  const numAddr = bytes[off++];
  const staticKeys = [];
  for (let i = 0; i < numAddr; i++) { staticKeys.push(b58encode(bytes.subarray(off, off + 32))); off += 32; }
  let bits = 0;
  for (let m = configMask; m; m &= m - 1) bits++;
  const configValues = bytes.slice(off, off + 4 * bits); off += 4 * bits;
  const heads = [];
  for (let i = 0; i < numIx; i++) {
    heads.push({ programIdIndex: bytes[off], numAccounts: bytes[off + 1], dataLen: readU16(bytes, off + 2) });
    off += 4;
  }
  const instructions = [];
  for (const h of heads) {
    const accountIndexes = Array.from(bytes.subarray(off, off + h.numAccounts)); off += h.numAccounts;
    const data = bytes.slice(off, off + h.dataLen); off += h.dataLen;
    instructions.push({ programIdIndex: h.programIdIndex, accountIndexes, data });
  }
  const messageEnd = off;
  const sigOffsets = [];
  for (let i = 0; i < header.numRequiredSignatures; i++) { sigOffsets.push(off); off += 64; }
  if (off !== bytes.length) throw new Error('Bad v1 transaction length');
  return {
    version: 'v1', header, staticKeys, recentBlockhash, instructions, lookups: [], configMask, configValues,
    sigOffsets, message: bytes.subarray(0, messageEnd), messageOffset: 0,
  };
}

/** Returns a copy of the transaction signed by `keypair` (must be one of its signers). */
export async function signTransaction(bytes, keypair) {
  const tx = parseTransaction(bytes);
  const idx = tx.staticKeys.indexOf(keypair.address);
  if (idx < 0 || idx >= tx.header.numRequiredSignatures) throw new Error('This wallet is not a signer of the transaction');
  const sig = await keypair.sign(tx.message);
  const out = bytes.slice();
  out.set(sig, tx.sigOffsets[idx]);
  return out;
}

/** The transaction id: base58 of the first signature. */
export function transactionId(bytes) {
  const tx = parseTransaction(bytes);
  return b58encode(bytes.subarray(tx.sigOffsets[0], tx.sigOffsets[0] + 64));
}

// ---- Common instructions ----

export function setComputeUnitLimit(units) {
  return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat(Uint8Array.of(2), u32le(units)) };
}

export function setComputeUnitPrice(microLamports) {
  return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat(Uint8Array.of(3), u64le(microLamports)) };
}

export function systemTransfer(from, to, lamports) {
  return {
    programId: SYSTEM_PROGRAM,
    keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }],
    data: concat(u32le(2), u64le(lamports)),
  };
}
