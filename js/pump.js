// pump.fun on-chain details: program addresses, account decoding, price math
// and the trade instructions (bonding curve v3 and PumpSwap v2), following
// github.com/pump-fun/pump-public-docs (IDL as of November 2026).

import { b58encode, isAddress } from './b58.js';
import { concat, fromBase64, readI128, readI64, readU32, readU64, textDecoder, u64le } from './bytes.js';
import { associatedTokenAddress, pda, toBytes } from './pda.js';
import { SYSTEM_PROGRAM } from './tx.js';

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMP_FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const WSOL = 'So11111111111111111111111111111111111111112';
export const DEFAULT_PUBKEY = SYSTEM_PROGRAM; // 32 zero bytes

export const PUMP_GLOBAL = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
export const PUMP_FEE_CONFIG = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';
export const AMM_GLOBAL_CONFIG = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw';
export const AMM_FEE_CONFIG = '5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx';

// docs/FEE_RECIPIENTS.md: "For all coins, choose one of the buyback fee recipients".
export const BUYBACK_FEE_RECIPIENTS = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
  '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
  'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
  'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW',
];

// Anchor discriminators from idl/pump.json and idl/pump_amm.json
const DISC = {
  bondingCurve: [23, 183, 248, 55, 96, 216, 172, 96],
  pool: [241, 154, 109, 4, 17, 177, 109, 188],
  buyExactQuoteInV3: [225, 247, 80, 30, 213, 179, 132, 136],
  sellV3: [28, 146, 222, 119, 38, 196, 105, 213],
  ammSellV2: [93, 246, 130, 60, 231, 233, 64, 178],
  createEvent: [27, 114, 169, 77, 222, 235, 99, 118],
};

// Standard pump.fun curve: 1,073,000,000 virtual tokens, 30 virtual SOL,
// 793,100,000 real tokens for sale, 1,000,000,000 supply, 6 decimals.
export const TOKEN_DECIMALS = 6;
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
export const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;
export const INITIAL_VIRTUAL_SOL_RESERVES = 30_000_000_000n;
// Total trading fee on the bonding curve and on young PumpSwap pools (docs/fees.png):
// 0.95% protocol + 0.30% creator. Only used for estimates; slippage limits cover the rest.
export const FEE_BPS = 125n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

function hasDisc(data, disc) {
  if (!data || data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) return false;
  return true;
}

const addr = (data, off) => b58encode(data.subarray(off, off + 32));

// ---------- Account decoding ----------

/** BondingCurve account (older, shorter accounts read missing fields as 0 / false / default). */
export function decodeBondingCurve(data) {
  if (!hasDisc(data, DISC.bondingCurve) || data.length < 49) return null;
  const has = (end) => data.length >= end;
  return {
    virtualTokenReserves: readU64(data, 8),
    virtualQuoteReserves: readU64(data, 16),
    realTokenReserves: readU64(data, 24),
    realQuoteReserves: readU64(data, 32),
    tokenTotalSupply: readU64(data, 40),
    complete: data[48] !== 0,
    creator: has(81) ? addr(data, 49) : DEFAULT_PUBKEY,
    isMayhemMode: has(82) ? data[81] !== 0 : false,
    isCashbackCoin: has(83) ? data[82] !== 0 : false,
    quoteMint: has(115) ? addr(data, 83) : DEFAULT_PUBKEY,
    creatorFeeBps: has(123) ? readU64(data, 115) : 0n,
    isHolderReward: has(125) ? data[124] !== 0 : false,
    depth: has(142) ? data[141] : 0,
  };
}

export function isSolPaired(curve) {
  return curve.quoteMint === DEFAULT_PUBKEY || curve.quoteMint === WSOL;
}

/** PumpSwap Pool account. */
export function decodePool(data) {
  if (!hasDisc(data, DISC.pool) || data.length < 243) return null;
  const has = (end) => data.length >= end;
  return {
    index: data[9] | (data[10] << 8),
    creator: addr(data, 11),
    baseMint: addr(data, 43),
    quoteMint: addr(data, 75),
    poolBaseTokenAccount: addr(data, 139),
    poolQuoteTokenAccount: addr(data, 171),
    coinCreator: addr(data, 211),
    isMayhemMode: has(244) ? data[243] !== 0 : false,
    isCashbackCoin: has(245) ? data[244] !== 0 : false,
    virtualQuoteReserves: has(261) ? readI128(data, 245) : 0n,
  };
}

/** SPL Token / Token-2022 account: mint, owner, amount. */
export function decodeTokenAccount(data) {
  if (!data || data.length < 72) return null;
  return { mint: addr(data, 0), owner: addr(data, 32), amount: readU64(data, 64) };
}

/** SPL Token / Token-2022 mint: supply and decimals. */
export function decodeMint(data) {
  if (!data || data.length < 82) return null;
  return { supply: readU64(data, 36), decimals: data[44] };
}

/**
 * Name and symbol from a Token-2022 mint's TokenMetadata extension (how
 * pump.fun stores them for coins made since 2025). Returns null if absent.
 */
export function decodeToken2022Metadata(data) {
  try {
    if (!data || data.length <= 166 || data[165] !== 1) return null; // 1 = Mint account type
    let off = 166;
    while (off + 4 <= data.length) {
      const type = data[off] | (data[off + 1] << 8);
      const len = data[off + 2] | (data[off + 3] << 8);
      off += 4;
      if (type === 0) break;
      if (type === 19 && off + len <= data.length) {
        let o = off + 64; // update authority + mint
        const [name, o2] = readString(data, o);
        const [symbol] = readString(data, o2);
        return { name: cleanText(name, 40), symbol: cleanText(symbol, 16) };
      }
      off += len;
    }
  } catch {}
  return null;
}

// ---------- Price math (BigInt, smallest units) ----------

/** Tokens received for spending `lamportsIn` (fees included) on the curve. */
export function curveBuyTokensOut(curve, lamportsIn, feeBps = FEE_BPS) {
  const net = (lamportsIn * 10000n) / (10000n + feeBps);
  if (net <= 0n || curve.virtualTokenReserves <= 0n) return 0n;
  let out = (net * curve.virtualTokenReserves) / (curve.virtualQuoteReserves + net);
  if (out > curve.realTokenReserves) out = curve.realTokenReserves;
  return out;
}

/** Lamports received for selling `tokens` to the curve, after fees. */
export function curveSellLamportsOut(curve, tokens, feeBps = FEE_BPS) {
  if (tokens <= 0n || curve.virtualTokenReserves <= 0n) return 0n;
  const gross = (tokens * curve.virtualQuoteReserves) / (curve.virtualTokenReserves + tokens);
  const fee = (gross * feeBps + 9999n) / 10000n;
  return gross > fee ? gross - fee : 0n;
}

export function curveMarketCapLamports(curve) {
  if (curve.virtualTokenReserves <= 0n) return 0n;
  return (curve.virtualQuoteReserves * curve.tokenTotalSupply) / curve.virtualTokenReserves;
}

/** 0..1, how far along the curve is towards graduating to PumpSwap. */
export function curveProgress(curve) {
  if (curve.complete) return 1;
  const sold = INITIAL_REAL_TOKEN_RESERVES - curve.realTokenReserves;
  const p = Number(sold) / Number(INITIAL_REAL_TOKEN_RESERVES);
  return Math.max(0, Math.min(1, p));
}

/** Lamports received for selling `tokens` into a PumpSwap pool, after fees. */
export function poolSellLamportsOut(baseReserve, effectiveQuoteReserve, tokens, feeBps = FEE_BPS) {
  if (tokens <= 0n || baseReserve <= 0n || effectiveQuoteReserve <= 0n) return 0n;
  const gross = (tokens * effectiveQuoteReserve) / (baseReserve + tokens);
  const fee = (gross * feeBps + 9999n) / 10000n;
  return gross > fee ? gross - fee : 0n;
}

export function poolMarketCapLamports(baseReserve, effectiveQuoteReserve, supply) {
  if (baseReserve <= 0n) return 0n;
  return (effectiveQuoteReserve * supply) / baseReserve;
}

// ---------- Addresses ----------

export async function bondingCurveAddress(mint) {
  return pda(['bonding-curve', toBytes(mint)], PUMP);
}

export async function canonicalPoolAddress(mint) {
  const authority = await pda(['pool-authority', toBytes(mint)], PUMP);
  return pda(['pool', Uint8Array.of(0, 0), toBytes(authority), toBytes(mint), toBytes(WSOL)], PUMP_AMM);
}

export async function mintAuthorityAddress() {
  return pda(['mint-authority'], PUMP);
}

export function pickBuybackRecipient() {
  return BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * BUYBACK_FEE_RECIPIENTS.length)];
}

// ---------- Instructions ----------

export function createAtaIdempotent(payer, ata, owner, mint, tokenProgram) {
  return {
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1),
  };
}

export function closeTokenAccount(account, destination, owner, tokenProgram) {
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Uint8Array.of(9),
  };
}

/** The 17 accounts of buy_v3 / buy_exact_quote_in_v3 / sell_v3 (docs/instructions/TRADE_V3.md), SOL-paired coins. */
export async function curveTradeAccounts(user, mint, baseTokenProgram) {
  const bondingCurve = await bondingCurveAddress(mint);
  const [associatedBaseBondingCurve, associatedQuoteBondingCurve, associatedBaseUser, associatedQuoteUser,
    userVolumeAccumulator, eventAuthority, global] = await Promise.all([
    associatedTokenAddress(bondingCurve, mint, baseTokenProgram),
    associatedTokenAddress(bondingCurve, WSOL, TOKEN),
    associatedTokenAddress(user, mint, baseTokenProgram),
    associatedTokenAddress(user, WSOL, TOKEN),
    pda(['user_volume_accumulator', toBytes(user)], PUMP),
    pda(['__event_authority'], PUMP),
    pda(['global'], PUMP),
  ]);
  const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
  const keys = [
    r(global),
    r(mint),
    r(WSOL),
    r(baseTokenProgram),
    r(TOKEN),
    w(bondingCurve),
    w(associatedBaseBondingCurve),
    w(associatedQuoteBondingCurve),
    { pubkey: user, isSigner: true, isWritable: true },
    w(associatedBaseUser),
    w(associatedQuoteUser),
    w(userVolumeAccumulator),
    r(PUMP_FEE_CONFIG),
    w(pickBuybackRecipient()),
    r(SYSTEM_PROGRAM),
    r(eventAuthority),
    r(PUMP),
  ];
  return { keys, bondingCurve, associatedBaseUser };
}

export function buyExactQuoteInV3Ix(keys, spendableQuoteIn, minTokensOut) {
  if (spendableQuoteIn <= 0n) throw new Error('Buy amount must be above zero');
  if (minTokensOut <= 0n) throw new Error('Minimum tokens must be above zero');
  return { programId: PUMP, keys, data: concat(Uint8Array.from(DISC.buyExactQuoteInV3), u64le(spendableQuoteIn), u64le(minTokensOut)) };
}

export function sellV3Ix(keys, amount, minSolOutput) {
  if (amount <= 0n) throw new Error('Sell amount must be above zero');
  return { programId: PUMP, keys, data: concat(Uint8Array.from(DISC.sellV3), u64le(amount), u64le(minSolOutput)) };
}

/** The 17 accounts of PumpSwap sell_v2 (docs/instructions/PUMP_SWAP_TRADE_V2.md) for a SOL pool. */
export async function ammSellAccounts(user, mint, baseTokenProgram, pool, poolState) {
  const buyback = pickBuybackRecipient();
  const [userBase, userQuote, userVolumeAccumulator, eventAuthority, buybackAta] = await Promise.all([
    associatedTokenAddress(user, mint, baseTokenProgram),
    associatedTokenAddress(user, WSOL, TOKEN),
    pda(['user_volume_accumulator', toBytes(user)], PUMP_AMM),
    pda(['__event_authority'], PUMP_AMM),
    associatedTokenAddress(buyback, WSOL, TOKEN),
  ]);
  const w = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
  const keys = [
    w(pool),
    { pubkey: user, isSigner: true, isWritable: true },
    r(AMM_GLOBAL_CONFIG),
    r(mint),
    r(WSOL),
    w(userBase),
    w(userQuote),
    w(poolState.poolBaseTokenAccount),
    w(poolState.poolQuoteTokenAccount),
    r(baseTokenProgram),
    r(TOKEN),
    r(SYSTEM_PROGRAM),
    w(userVolumeAccumulator),
    r(AMM_FEE_CONFIG),
    w(buybackAta),
    r(eventAuthority),
    r(PUMP_AMM),
  ];
  return { keys, userBase, userQuote };
}

export function ammSellV2Ix(keys, baseAmountIn, minQuoteAmountOut) {
  if (baseAmountIn <= 0n) throw new Error('Sell amount must be above zero');
  return { programId: PUMP_AMM, keys, data: concat(Uint8Array.from(DISC.ammSellV2), u64le(baseAmountIn), u64le(minQuoteAmountOut)) };
}

// ---------- New-coin events in transaction logs ----------

function cleanText(s, max) {
  return String(s).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max);
}

function readString(data, off) {
  const len = readU32(data, off);
  if (len > 1000 || off + 4 + len > data.length) throw new Error('bad string');
  return [textDecoder.decode(data.subarray(off + 4, off + 4 + len)), off + 4 + len];
}

/** Decode a pump.fun CreateEvent from base64 "Program data" bytes, or null. */
export function decodeCreateEvent(bytes) {
  if (!hasDisc(bytes, DISC.createEvent)) return null;
  try {
    let off = 8;
    let name, symbol, uri;
    [name, off] = readString(bytes, off);
    [symbol, off] = readString(bytes, off);
    [uri, off] = readString(bytes, off);
    if (off + 4 * 32 + 8 > bytes.length) return null;
    const mint = addr(bytes, off); off += 32;
    const bondingCurve = addr(bytes, off); off += 32;
    const user = addr(bytes, off); off += 32;
    const creator = addr(bytes, off); off += 32;
    const timestamp = Number(readI64(bytes, off)); off += 8;
    const ev = { name: cleanText(name, 40), symbol: cleanText(symbol, 16), uri: cleanText(uri, 300), mint, bondingCurve, user, creator, timestamp };
    // virtual_token_reserves, virtual_sol_reserves, real_token_reserves, token_total_supply
    off += 32;
    if (off + 32 <= bytes.length) { ev.tokenProgram = addr(bytes, off); off += 32; }
    if (off + 2 <= bytes.length) { ev.isMayhemMode = bytes[off] !== 0; ev.isCashback = bytes[off + 1] !== 0; off += 2; }
    if (off + 32 <= bytes.length) { ev.quoteMint = addr(bytes, off); off += 32; }
    return ev;
  } catch {
    return null;
  }
}

/**
 * Find CreateEvents in a transaction's logs. Only "Program data" lines
 * emitted directly by the pump program count, so another program in the
 * same transaction can't fake one.
 */
export function createEventsFromLogs(logs) {
  const out = [];
  const stack = [];
  for (const line of logs || []) {
    let m;
    if ((m = /^Program (\w+) invoke \[\d+\]$/.exec(line))) { stack.push(m[1]); continue; }
    if ((m = /^Program (\w+) (success|failed)/.exec(line))) { if (stack[stack.length - 1] === m[1]) stack.pop(); continue; }
    if (line.startsWith('Program data: ') && stack[stack.length - 1] === PUMP) {
      let bytes;
      try { bytes = fromBase64(line.slice(14).trim()); } catch { continue; }
      const ev = decodeCreateEvent(bytes);
      if (ev && isAddress(ev.mint)) out.push(ev);
    }
  }
  return out;
}

// ---------- Display helpers ----------

export function lamportsToSol(l) { return Number(l) / 1e9; }
export function solToLamports(sol) { return BigInt(Math.round(Number(sol) * 1e9)); }
export function tokensToUi(raw) { return Number(raw) / 10 ** TOKEN_DECIMALS; }
