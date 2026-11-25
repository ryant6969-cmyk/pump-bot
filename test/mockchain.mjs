// A small fake Solana network for tests. It answers the RPC methods the app
// uses and actually executes our transactions: it checks signatures, fees,
// blockhashes, and every pump.fun account against the official IDL
// (test/fixtures/idl-subset.json), then applies the trade to its state.
import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import { b58decode, b58encode } from '../js/b58.js';
import { concat, fromBase64, readU64, toBase64, u32le, u64le } from '../js/bytes.js';
import { associatedTokenAddress, findProgramAddress } from '../js/pda.js';
import * as pump from '../js/pump.js';
import { buildLegacyTransaction, setComputeUnitLimit, setComputeUnitPrice, systemTransfer } from '../js/tx.js';

const IDL = JSON.parse(fs.readFileSync(new URL('./fixtures/idl-subset.json', import.meta.url)));
const SYSTEM = '11111111111111111111111111111111';
const CB = 'ComputeBudget111111111111111111111111111111';
const RENT = { [pump.TOKEN]: 2_039_280n, [pump.TOKEN_2022]: 2_074_080n };
const RENT_UVA = 1_844_400n;
const RENT_MIN = 890_880n;
export const PUMPPORTAL_FEE_WALLET = 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM';

class Custom extends Error { constructor(code) { super('custom program error ' + code); this.code = code; } }

function readCU16(buf, o) {
  let v = 0, s = 0;
  for (;;) { const b = buf[o++]; v |= (b & 0x7f) << s; if (!(b & 0x80)) break; s += 7; }
  return [v, o];
}

// Independent legacy parser (does not reuse the app's parser).
export function parseLegacy(buf) {
  let o = 0, n;
  [n, o] = readCU16(buf, o);
  const sigs = [];
  for (let i = 0; i < n; i++) { sigs.push(buf.slice(o, o + 64)); o += 64; }
  const msgStart = o;
  if (buf[o] & 0x80) throw new Error('mock handles legacy transactions only');
  const header = [buf[o], buf[o + 1], buf[o + 2]]; o += 3;
  let nk; [nk, o] = readCU16(buf, o);
  const keys = [];
  for (let i = 0; i < nk; i++) { keys.push(b58encode(buf.slice(o, o + 32))); o += 32; }
  const blockhash = b58encode(buf.slice(o, o + 32)); o += 32;
  let ni; [ni, o] = readCU16(buf, o);
  const ixs = [];
  for (let i = 0; i < ni; i++) {
    const p = buf[o++];
    let na; [na, o] = readCU16(buf, o);
    const accts = Array.from(buf.slice(o, o + na)); o += na;
    let dl; [dl, o] = readCU16(buf, o);
    const data = buf.slice(o, o + dl); o += dl;
    ixs.push({ program: keys[p], accts, data });
  }
  if (o !== buf.length) throw new Error('trailing bytes');
  const nsig = header[0];
  const isSigner = (i) => i < nsig;
  const isWritable = (i) => (i < nsig ? i < nsig - header[1] : i < keys.length - header[2]);
  return { sigs, message: buf.slice(msgStart), header, keys, blockhash, ixs, isSigner, isWritable };
}

export function encodeMint(supply = 1_000_000_000_000_000n, decimals = 6) {
  const d = new Uint8Array(82);
  new DataView(d.buffer).setBigUint64(36, supply, true);
  d[44] = decimals; d[45] = 1;
  return d;
}

export function encodeTokenAccount(mint, owner, amount) {
  const d = new Uint8Array(165);
  d.set(b58decode(mint), 0); d.set(b58decode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, BigInt(amount), true);
  d[108] = 1;
  return d;
}

export function encodeCurve(c) {
  const d = new Uint8Array(166);
  d.set([23, 183, 248, 55, 96, 216, 172, 96], 0);
  const v = new DataView(d.buffer);
  v.setBigUint64(8, c.virtualTokenReserves, true);
  v.setBigUint64(16, c.virtualQuoteReserves, true);
  v.setBigUint64(24, c.realTokenReserves, true);
  v.setBigUint64(32, c.realQuoteReserves, true);
  v.setBigUint64(40, c.tokenTotalSupply ?? 1_000_000_000_000_000n, true);
  d[48] = c.complete ? 1 : 0;
  d.set(b58decode(c.creator || SYSTEM), 49);
  d[81] = c.isMayhemMode ? 1 : 0;
  d[82] = c.isCashbackCoin ? 1 : 0;
  d.set(b58decode(c.quoteMint || SYSTEM), 83);
  return d;
}

export function encodePool(p) {
  const d = new Uint8Array(287);
  d.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
  d.set(b58decode(p.creator), 11);
  d.set(b58decode(p.baseMint), 43);
  d.set(b58decode(pump.WSOL), 75);
  d.set(b58decode(p.poolBaseTokenAccount), 139);
  d.set(b58decode(p.poolQuoteTokenAccount), 171);
  d.set(b58decode(p.coinCreator || SYSTEM), 211);
  return d;
}

function decodeCurveFull(data) { return pump.decodeBondingCurve(data); }

const i64le = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), true); return b; };
const bstr = (s) => { const b = new TextEncoder().encode(s); return concat(u32le(b.length), b); };
const ZERO = new Uint8Array(32);

/** A pump.fun TradeEvent, byte for byte as in idl/pump.json. */
export function encodeTradeEvent(e) {
  return concat(
    Uint8Array.from([189, 219, 127, 211, 78, 230, 97, 238]),
    b58decode(e.mint), u64le(BigInt(e.solAmount)), u64le(BigInt(e.tokenAmount)), Uint8Array.of(e.isBuy ? 1 : 0),
    b58decode(e.user), i64le(e.timestamp ?? 1_800_000_000),
    u64le(BigInt(e.virtualSolReserves)), u64le(BigInt(e.virtualTokenReserves)), u64le(BigInt(e.realSolReserves)), u64le(BigInt(e.realTokenReserves)),
    b58decode(pump.BUYBACK_FEE_RECIPIENTS[0]), u64le(95n), u64le(1000n), b58decode(e.creator || SYSTEM), u64le(30n), u64le(300n),
    Uint8Array.of(1), u64le(0n), u64le(0n), u64le(0n), i64le(0),
    bstr(e.isBuy ? 'buy_exact_quote_in_v3' : 'sell_v3'), Uint8Array.of(e.mayhem ? 1 : 0),
    u64le(0n), u64le(0n), u64le(0n), u64le(0n),
    u32le(0), e.quoteMint ? b58decode(e.quoteMint) : ZERO, u64le(BigInt(e.solAmount)), u64le(BigInt(e.virtualSolReserves)), u64le(BigInt(e.realSolReserves)),
    u64le(0n), u64le(0n), u64le(0n),
  );
}

/** A PumpSwap BuyEvent / SellEvent with the fields the app reads (the rest zero). */
export function encodeAmmTradeEvent({ isBuy, baseAmount, userBaseBefore, solAmount, pool, user }) {
  const d = new Uint8Array(420);
  d.set(isBuy ? [103, 244, 82, 31, 44, 245, 119, 119] : [62, 47, 55, 10, 165, 3, 220, 42], 0);
  const v = new DataView(d.buffer);
  v.setBigUint64(16, BigInt(baseAmount), true);
  v.setBigUint64(32, BigInt(userBaseBefore), true);
  v.setBigUint64(112, BigInt(solAmount), true);
  d.set(b58decode(pool), 120);
  d.set(b58decode(user), 152);
  return d;
}

/** Transaction logs that carry pump.fun events, emitted the way the program emits them. */
export function pumpLogs(events, { program = pump.PUMP } = {}) {
  const lines = [`Program ${program} invoke [1]`, 'Program log: Instruction: Trade'];
  for (const e of events) lines.push('Program data: ' + toBase64(e instanceof Uint8Array ? e : encodeTradeEvent(e)));
  lines.push(`Program ${program} success`);
  return lines;
}

export class MockChain {
  constructor(opts = {}) {
    this.accounts = new Map();
    this.landed = new Map();
    this.sends = 0;
    this.height = 1000;
    this.blockhashes = new Map();
    this.opts = { dropSends: 0, confirmAfterPolls: 1, lastValidOffset: 150, heightStepPerCheck: 0, ...opts };
    this.pollCount = new Map();
    this.calls = [];
    this.hooks = { beforeLand: null };
    this.pumpPortal = 'ok';
    this.rejectPumpV3 = false;
    this.set(pump.WSOL, { lamports: 1_000_000_000n, owner: pump.TOKEN, data: encodeMint(0n, 9) });
    this.newBlockhash();
  }

  newBlockhash() {
    this.blockhash = b58encode(nodeCrypto.randomBytes(32));
    this.blockhashes.set(this.blockhash, this.height + this.opts.lastValidOffset);
    return this.blockhash;
  }

  get(addr) { return this.accounts.get(addr) || null; }
  set(addr, acc) { this.accounts.set(addr, acc); }
  lamports(addr) { return this.get(addr)?.lamports ?? 0n; }
  tokenAmount(addr) { const a = this.get(addr); return a ? readU64(a.data, 64) : 0n; }

  addWallet(addr, sol) { this.set(addr, { lamports: BigInt(Math.round(sol * 1e9)), owner: SYSTEM, data: new Uint8Array(0) }); }

  async addCoin({ mint, tokenProgram = pump.TOKEN_2022, curve = {}, creator = null }) {
    const curveAddr = await pump.bondingCurveAddress(mint);
    const c = {
      virtualTokenReserves: pump.INITIAL_VIRTUAL_TOKEN_RESERVES,
      virtualQuoteReserves: pump.INITIAL_VIRTUAL_SOL_RESERVES,
      realTokenReserves: pump.INITIAL_REAL_TOKEN_RESERVES,
      realQuoteReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: false,
      creator: creator || b58encode(nodeCrypto.randomBytes(32)),
      ...curve,
    };
    this.set(mint, { lamports: 1_461_600n, owner: tokenProgram, data: encodeMint() });
    this.set(curveAddr, { lamports: 1_500_000n + c.realQuoteReserves, owner: pump.PUMP, data: encodeCurve(c) });
    const curveAta = await associatedTokenAddress(curveAddr, mint, tokenProgram);
    this.set(curveAta, { lamports: RENT[tokenProgram], owner: tokenProgram, data: encodeTokenAccount(mint, curveAddr, c.realTokenReserves + 206_900_000_000_000n) });
    return { curveAddr, curveAta, creator: c.creator };
  }

  async setCurve(mint, patch) {
    const curveAddr = await pump.bondingCurveAddress(mint);
    const cur = decodeCurveFull(this.get(curveAddr).data);
    this.get(curveAddr).data = encodeCurve({ ...cur, ...patch });
  }

  async addPool({ mint, tokenProgram = pump.TOKEN_2022, base = 200_000_000_000_000n, quote = 85_000_000_000n }) {
    const pool = await pump.canonicalPoolAddress(mint);
    const authority = (await findProgramAddress(['pool-authority', b58decode(mint)], pump.PUMP))[0];
    const baseTa = await associatedTokenAddress(pool, mint, tokenProgram);
    const quoteTa = await associatedTokenAddress(pool, pump.WSOL, pump.TOKEN);
    this.set(pool, { lamports: 3_000_000n, owner: pump.PUMP_AMM, data: encodePool({ creator: authority, baseMint: mint, poolBaseTokenAccount: baseTa, poolQuoteTokenAccount: quoteTa }) });
    this.set(baseTa, { lamports: RENT[tokenProgram], owner: tokenProgram, data: encodeTokenAccount(mint, pool, base) });
    this.set(quoteTa, { lamports: RENT[pump.TOKEN] + quote, owner: pump.TOKEN, data: encodeTokenAccount(pump.WSOL, pool, quote) });
    return pool;
  }

  /**
   * Someone else trades a coin on its curve. Updates the curve, the curve's
   * token account and the trader's token account, and returns the TradeEvent
   * the program would emit (send it to subscribers with pumpLogs()).
   */
  async trade(mint, { user = b58encode(nodeCrypto.randomBytes(32)), sol = null, tokens = null, isBuy = true, tokenProgram = pump.TOKEN_2022 } = {}) {
    const curveAddr = await pump.bondingCurveAddress(mint);
    const curveAta = await associatedTokenAddress(curveAddr, mint, tokenProgram);
    const c = decodeCurveFull(this.get(curveAddr).data);
    const userAta = await associatedTokenAddress(user, mint, tokenProgram);
    const held = this.get(userAta) ? pump.decodeTokenAccount(this.get(userAta).data).amount : 0n;
    let solAmount, tokenAmount, next;
    if (isBuy) {
      const net = BigInt(Math.round(sol * 1e9));
      tokenAmount = (net * c.virtualTokenReserves) / (c.virtualQuoteReserves + net);
      if (tokenAmount > c.realTokenReserves) tokenAmount = c.realTokenReserves;
      solAmount = net;
      next = { ...c, virtualQuoteReserves: c.virtualQuoteReserves + net, realQuoteReserves: c.realQuoteReserves + net, virtualTokenReserves: c.virtualTokenReserves - tokenAmount, realTokenReserves: c.realTokenReserves - tokenAmount };
      this.get(curveAddr).lamports += net;
    } else {
      tokenAmount = tokens === null ? held : BigInt(tokens);
      if (tokenAmount > held) tokenAmount = held;
      solAmount = (tokenAmount * c.virtualQuoteReserves) / (c.virtualTokenReserves + tokenAmount);
      next = { ...c, virtualQuoteReserves: c.virtualQuoteReserves - solAmount, realQuoteReserves: c.realQuoteReserves - solAmount, virtualTokenReserves: c.virtualTokenReserves + tokenAmount, realTokenReserves: c.realTokenReserves + tokenAmount };
      this.get(curveAddr).lamports -= solAmount;
    }
    this.get(curveAddr).data = encodeCurve(next);
    const ataAcc = this.get(curveAta);
    const curveHeld = pump.decodeTokenAccount(ataAcc.data).amount;
    ataAcc.data = encodeTokenAccount(mint, curveAddr, isBuy ? curveHeld - tokenAmount : curveHeld + tokenAmount);
    this.set(userAta, { lamports: RENT[tokenProgram], owner: tokenProgram, data: encodeTokenAccount(mint, user, isBuy ? held + tokenAmount : held - tokenAmount) });
    return {
      mint, user, isBuy, solAmount, tokenAmount, creator: next.creator, mayhem: next.isMayhemMode,
      virtualSolReserves: next.virtualQuoteReserves, virtualTokenReserves: next.virtualTokenReserves,
      realSolReserves: next.realQuoteReserves, realTokenReserves: next.realTokenReserves,
    };
  }

  async giveTokens(owner, mint, amount, tokenProgram = pump.TOKEN_2022) {
    const ata = await associatedTokenAddress(owner, mint, tokenProgram);
    this.set(ata, { lamports: RENT[tokenProgram], owner: tokenProgram, data: encodeTokenAccount(mint, owner, amount) });
    return ata;
  }

  // ---------- execution ----------

  async _validateAgainstIdl(programName, ixName, tx, ix, state) {
    const def = IDL[programName].instructions.find((i) => i.name === ixName);
    if (!def) throw new Error('no idl for ' + ixName);
    if (ix.accts.length !== def.accounts.length) throw new Custom(3005); // AccountNotEnoughKeys
    const byName = {};
    def.accounts.forEach((a, i) => { byName[a.name] = tx.keys[ix.accts[i]]; });
    for (let i = 0; i < def.accounts.length; i++) {
      const a = def.accounts[i];
      const idx = ix.accts[i];
      const key = tx.keys[idx];
      if (!!a.signer !== tx.isSigner(idx)) throw new Custom(2002); // ConstraintSigner
      if (a.writable && !tx.isWritable(idx)) throw new Custom(2000); // ConstraintMut
      if (a.address && a.address !== key) throw new Custom(2012); // ConstraintAddress
      if (a.pda) {
        const seeds = a.pda.seeds.map((s) => {
          if (s.kind === 'const') return Uint8Array.from(s.value);
          if (s.kind === 'account') return b58decode(byName[s.path]);
          throw new Error('unsupported seed kind ' + s.kind);
        });
        const prog = a.pda.program ? (a.pda.program.kind === 'const' ? b58encode(Uint8Array.from(a.pda.program.value)) : byName[a.pda.program.path]) : IDL[programName].address;
        const [expected] = await findProgramAddress(seeds, prog);
        if (expected !== key) throw new Custom(2006); // ConstraintSeeds
      }
    }
    return byName;
  }

  async _exec(tx, state, sim) {
    const logs = [];
    let cuLimit = 200_000, cuPrice = 0n;
    const payer = tx.keys[0];
    const get = (a) => state.get(a) || null;
    const req = (a) => { const x = get(a); if (!x) throw new Custom(3012); return x; };
    const ensureSigner = (i) => { if (!tx.isSigner(i)) throw new Error('MissingRequiredSignature'); };
    const tokAmt = (a) => readU64(req(a).data, 64);
    const setTok = (a, amount) => { const acc = req(a); const d = acc.data.slice(); new DataView(d.buffer).setBigUint64(64, amount, true); acc.data = d; };
    for (const [n, ix] of tx.ixs.entries()) {
      try {
        logs.push(`Program ${ix.program} invoke [1]`);
        if (ix.program === CB) {
          if (ix.data[0] === 2 && ix.data.length === 5) cuLimit = new DataView(ix.data.buffer).getUint32(1, true);
          else if (ix.data[0] === 3 && ix.data.length === 9) cuPrice = readU64(ix.data, 1);
          else throw new Error('InvalidInstructionData');
        } else if (ix.program === SYSTEM) {
          const dv = new DataView(ix.data.buffer);
          if (dv.getUint32(0, true) !== 2) throw new Error('unsupported system ix');
          const amount = readU64(ix.data, 4);
          const from = tx.keys[ix.accts[0]], to = tx.keys[ix.accts[1]];
          ensureSigner(ix.accts[0]);
          const f = req(from);
          if (f.lamports < amount) throw new Custom(1);
          f.lamports -= amount;
          const t = get(to) || { lamports: 0n, owner: SYSTEM, data: new Uint8Array(0) };
          t.lamports += amount; state.set(to, t);
        } else if (ix.program === pump.ATA_PROGRAM) {
          if (ix.data.length !== 1 || ix.data[0] !== 1) throw new Error('only CreateIdempotent');
          const [p, ata, owner, mint, sys, tp] = ix.accts.map((i) => tx.keys[i]);
          ensureSigner(ix.accts[0]);
          if (sys !== SYSTEM) throw new Error('bad system program');
          if (req(mint).owner !== tp) throw new Error('IncorrectProgramId');
          if (ata !== await associatedTokenAddress(owner, mint, tp)) throw new Error('InvalidSeeds');
          if (!get(ata)) {
            const pay = req(p);
            if (pay.lamports < RENT[tp]) throw new Custom(1);
            pay.lamports -= RENT[tp];
            state.set(ata, { lamports: RENT[tp], owner: tp, data: encodeTokenAccount(mint, owner, 0n) });
          }
        } else if (ix.program === pump.TOKEN || ix.program === pump.TOKEN_2022) {
          if (ix.data[0] === 17 && ix.data.length === 1) {
            // SyncNative: a wrapped-SOL account's balance becomes its lamports above rent
            const a = req(tx.keys[ix.accts[0]]);
            const ta = pump.decodeTokenAccount(a.data);
            if (a.owner !== ix.program || ta.mint !== pump.WSOL) throw new Custom(3); // InvalidAccountData-ish
            setTok(tx.keys[ix.accts[0]], a.lamports - RENT[pump.TOKEN]);
            logs.push(`Program ${ix.program} success`);
            continue;
          }
          if (ix.data[0] !== 9) throw new Error('only CloseAccount');
          const [acct, dest, owner] = ix.accts.map((i) => tx.keys[i]);
          ensureSigner(ix.accts[2]);
          const a = req(acct);
          if (a.owner !== ix.program) throw new Error('IncorrectProgramId');
          const ta = pump.decodeTokenAccount(a.data);
          if (ta.owner !== owner) throw new Custom(4);
          if (ta.mint !== pump.WSOL && ta.amount !== 0n) throw new Custom(11); // NonNativeHasBalance
          const d = get(dest) || { lamports: 0n, owner: SYSTEM, data: new Uint8Array(0) };
          d.lamports += a.lamports; state.set(dest, d);
          state.delete(acct);
        } else if (ix.program === pump.PUMP) {
          const disc = Array.from(ix.data.slice(0, 8)).join(',');
          const isBuy = disc === '225,247,80,30,213,179,132,136';
          const isSell = disc === '28,146,222,119,38,196,105,213';
          if (!isBuy && !isSell) throw new Custom(101); // InstructionFallbackNotFound
          if (this.rejectPumpV3 && !tx.keys.includes(PUMPPORTAL_FEE_WALLET)) throw new Custom(2006);
          const acc = await this._validateAgainstIdl('pump', isBuy ? 'buy_exact_quote_in_v3' : 'sell_v3', tx, ix, state);
          if (req(acc.base_mint).owner !== acc.base_token_program) throw new Custom(2014); // ConstraintTokenProgram-ish
          if (acc.quote_mint !== pump.WSOL || acc.quote_token_program !== pump.TOKEN) throw new Custom(6063);
          if (!pump.BUYBACK_FEE_RECIPIENTS.includes(acc.buyback_fee_recipient)) throw new Custom(6057);
          if (acc.associated_base_user !== await associatedTokenAddress(acc.user, acc.base_mint, acc.base_token_program)) throw new Custom(2006);
          if (acc.associated_quote_user !== await associatedTokenAddress(acc.user, pump.WSOL, pump.TOKEN)) throw new Custom(2006);
          req(acc.associated_base_user);
          const curveAcc = req(acc.bonding_curve);
          const c = decodeCurveFull(curveAcc.data);
          if (c.complete) throw new Custom(6005);
          if (c.isCashbackCoin) throw new Custom(6094);
          const a1 = readU64(ix.data, 8), a2 = readU64(ix.data, 16);
          if (!get(acc.user_volume_accumulator)) {
            const u = req(acc.user);
            if (u.lamports < RENT_UVA) throw new Custom(6040);
            u.lamports -= RENT_UVA;
            state.set(acc.user_volume_accumulator, { lamports: RENT_UVA, owner: pump.PUMP, data: new Uint8Array(137) });
          }
          if (isBuy) {
            const spend = a1, minOut = a2;
            if (spend === 0n) throw new Custom(6020);
            const u = req(acc.user);
            if (u.lamports < spend) throw new Custom(6041);
            const net = (spend * 10000n) / 10125n;
            const out = (net * c.virtualTokenReserves) / (c.virtualQuoteReserves + net);
            if (out > c.realTokenReserves) throw new Custom(6021);
            if (out < minOut) throw new Custom(6042);
            u.lamports -= spend; curveAcc.lamports += spend;
            curveAcc.data = encodeCurve({ ...c, virtualQuoteReserves: c.virtualQuoteReserves + net, realQuoteReserves: c.realQuoteReserves + net,
              virtualTokenReserves: c.virtualTokenReserves - out, realTokenReserves: c.realTokenReserves - out });
            setTok(acc.associated_base_bonding_curve, tokAmt(acc.associated_base_bonding_curve) - out);
            setTok(acc.associated_base_user, tokAmt(acc.associated_base_user) + out);
          } else {
            const amount = a1, minSol = a2;
            if (amount === 0n) throw new Custom(6022);
            if (tokAmt(acc.associated_base_user) < amount) throw new Custom(6023);
            const gross = (amount * c.virtualQuoteReserves) / (c.virtualTokenReserves + amount);
            const fee = (gross * 125n + 9999n) / 10000n;
            const out = gross - fee;
            if (out < minSol) throw new Custom(6003);
            curveAcc.lamports -= out; req(acc.user).lamports += out;
            curveAcc.data = encodeCurve({ ...c, virtualQuoteReserves: c.virtualQuoteReserves - gross, realQuoteReserves: c.realQuoteReserves - gross,
              virtualTokenReserves: c.virtualTokenReserves + amount, realTokenReserves: c.realTokenReserves + amount });
            setTok(acc.associated_base_user, tokAmt(acc.associated_base_user) - amount);
            setTok(acc.associated_base_bonding_curve, tokAmt(acc.associated_base_bonding_curve) + amount);
          }
        } else if (ix.program === pump.PUMP_AMM) {
          const disc = Array.from(ix.data.slice(0, 8)).join(',');
          const isAmmBuy = disc === '194,171,28,70,104,77,91,47';
          if (disc !== '93,246,130,60,231,233,64,178' && !isAmmBuy) throw new Custom(101);
          const acc = await this._validateAgainstIdl('pump_amm', isAmmBuy ? 'buy_exact_quote_in_v2' : 'sell_v2', tx, ix, state);
          const p = pump.decodePool(req(acc.pool).data);
          if (p.poolBaseTokenAccount !== acc.pool_base_token_account || p.poolQuoteTokenAccount !== acc.pool_quote_token_account) throw new Custom(6014);
          const buybackAtas = await Promise.all(pump.BUYBACK_FEE_RECIPIENTS.map((b) => associatedTokenAddress(b, pump.WSOL, pump.TOKEN)));
          if (!buybackAtas.includes(acc.buyback_fee_recipient)) throw new Custom(6057);
          if (p.isCashbackCoin) throw new Custom(6079);
          if (isAmmBuy) {
            const spend = readU64(ix.data, 8), minBase = readU64(ix.data, 16);
            if (spend === 0n || minBase === 0n) throw new Custom(6000);
            req(acc.user_base_token_account);
            if (tokAmt(acc.user_quote_token_account) < spend) throw new Custom(1);
            const B = tokAmt(acc.pool_base_token_account), Q = tokAmt(acc.pool_quote_token_account) + p.virtualQuoteReserves;
            const net = (spend * 10000n) / 10125n;
            const out = (net * B) / (Q + net);
            if (out < minBase) throw new Custom(6040);
            setTok(acc.user_quote_token_account, tokAmt(acc.user_quote_token_account) - spend);
            req(acc.user_quote_token_account).lamports -= spend;
            setTok(acc.pool_quote_token_account, tokAmt(acc.pool_quote_token_account) + spend);
            req(acc.pool_quote_token_account).lamports += spend;
            setTok(acc.pool_base_token_account, B - out);
            setTok(acc.user_base_token_account, tokAmt(acc.user_base_token_account) + out);
            if (!get(acc.user_volume_accumulator)) state.set(acc.user_volume_accumulator, { lamports: RENT_UVA, owner: pump.PUMP_AMM, data: new Uint8Array(1) });
            logs.push(`Program ${ix.program} success`);
            continue;
          }
          const amount = readU64(ix.data, 8), minOut = readU64(ix.data, 16);
          if (tokAmt(acc.user_base_token_account) < amount) throw new Custom(1);
          req(acc.user_quote_token_account);
          const B = tokAmt(acc.pool_base_token_account), Q = tokAmt(acc.pool_quote_token_account) + p.virtualQuoteReserves;
          const gross = (amount * Q) / (B + amount);
          const out = gross - (gross * 125n + 9999n) / 10000n;
          if (out < minOut) throw new Custom(6004);
          setTok(acc.user_base_token_account, tokAmt(acc.user_base_token_account) - amount);
          setTok(acc.pool_base_token_account, B + amount);
          setTok(acc.pool_quote_token_account, tokAmt(acc.pool_quote_token_account) - out);
          req(acc.pool_quote_token_account).lamports -= out;
          setTok(acc.user_quote_token_account, tokAmt(acc.user_quote_token_account) + out);
          req(acc.user_quote_token_account).lamports += out;
          if (!get(acc.user_volume_accumulator)) state.set(acc.user_volume_accumulator, { lamports: RENT_UVA, owner: pump.PUMP_AMM, data: new Uint8Array(1) });
        } else {
          throw new Error('Unknown program ' + ix.program);
        }
        logs.push(`Program ${ix.program} success`);
      } catch (e) {
        logs.push(`Program ${ix.program} failed: ${e.message}`);
        if (e instanceof Custom) return { err: { InstructionError: [n, { Custom: e.code }] }, logs, cuLimit, cuPrice };
        return { err: { InstructionError: [n, String(e.message)] }, logs, cuLimit, cuPrice };
      }
    }
    return { err: null, logs, cuLimit, cuPrice };
  }

  _clone() {
    const m = new Map();
    for (const [k, v] of this.accounts) m.set(k, { lamports: v.lamports, owner: v.owner, data: v.data.slice() });
    return m;
  }

  async _run(buf, { simulate, accounts = [] } = {}) {
    const tx = parseLegacy(buf);
    const state = this._clone();
    const payer = tx.keys[0];
    const pre = new Map(tx.keys.map((k) => [k, state.get(k)?.lamports ?? 0n]));
    const preTok = new Map(tx.keys.map((k) => { const a = state.get(k); return [k, a && (a.owner === pump.TOKEN || a.owner === pump.TOKEN_2022) ? pump.decodeTokenAccount(a.data) : null]; }));
    // fee is charged up front
    let cuLimit = 200_000, cuPrice = 0n;
    for (const ix of tx.ixs) if (ix.program === CB) {
      if (ix.data[0] === 2) cuLimit = new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(1, true);
      if (ix.data[0] === 3) cuPrice = readU64(ix.data, 1);
    }
    const fee = 5000n * BigInt(tx.header[0]) + (BigInt(cuLimit) * cuPrice + 999_999n) / 1_000_000n;
    const p = state.get(payer);
    if (!p || p.lamports < fee) return { err: 'InsufficientFundsForFee', logs: [], state: null, fee: 0n, tx };
    p.lamports -= fee;
    const afterFee = new Map([...state].map(([k, v]) => [k, { ...v, data: v.data.slice() }]));
    const r = await this._exec(tx, state, simulate);
    let err = r.err;
    if (!err) {
      const pl = state.get(payer)?.lamports ?? 0n;
      if (pl !== 0n && pl < RENT_MIN) err = { InsufficientFundsForRent: { account_index: 0 } };
    }
    const finalState = err ? afterFee : state;
    return { err, logs: r.logs, state: finalState, fee, tx, pre, preTok, unitsConsumed: err ? 20_000 : 68_000 };
  }

  _acctJson(acc) {
    if (!acc) return null;
    return { lamports: Number(acc.lamports), owner: acc.owner, data: [toBase64(acc.data), 'base64'], executable: false, rentEpoch: 0, space: acc.data.length };
  }

  async handle(method, params) {
    this.calls.push(method);
    switch (method) {
      case 'getLatestBlockhash':
        return { context: { slot: this.height }, value: { blockhash: this.blockhash, lastValidBlockHeight: this.blockhashes.get(this.blockhash) } };
      case 'getBlockHeight':
        this.height += this.opts.heightStepPerCheck;
        return this.height;
      case 'getBalance':
        return { context: { slot: this.height }, value: Number(this.lamports(params[0])) };
      case 'getMultipleAccounts':
        return { context: { slot: this.height }, value: params[0].map((a) => this._acctJson(this.get(a))) };
      case 'getAccountInfo':
        return { context: { slot: this.height }, value: this._acctJson(this.get(params[0])) };
      case 'getRecentPrioritizationFees':
        return [{ slot: 1, prioritizationFee: 0 }, { slot: 2, prioritizationFee: 150_000 }, { slot: 3, prioritizationFee: 900_000 }];
      case 'getTokenLargestAccounts': {
        const mint = params[0];
        const list = [...this.accounts.entries()]
          .filter(([, a]) => (a.owner === pump.TOKEN || a.owner === pump.TOKEN_2022) && a.data.length >= 72 && pump.decodeTokenAccount(a.data).mint === mint)
          .map(([address, a]) => ({ address, amount: pump.decodeTokenAccount(a.data).amount }))
          .sort((x, y) => (y.amount > x.amount ? 1 : -1)).slice(0, 20);
        return { context: { slot: this.height }, value: list.map((h) => ({ address: h.address, amount: h.amount.toString(), decimals: 6, uiAmount: Number(h.amount) / 1e6, uiAmountString: String(Number(h.amount) / 1e6) })) };
      }
      case 'getTokenAccountsByOwner': {
        const [owner, { programId }] = params;
        const value = [...this.accounts.entries()]
          .filter(([, a]) => a.owner === programId && a.data.length >= 72 && pump.decodeTokenAccount(a.data).owner === owner)
          .map(([pubkey, a]) => { const t = pump.decodeTokenAccount(a.data); return { pubkey, account: { lamports: Number(a.lamports), owner: programId, data: { program: 'spl-token', parsed: { type: 'account', info: { mint: t.mint, owner: t.owner, tokenAmount: { amount: t.amount.toString(), decimals: 6, uiAmount: Number(t.amount) / 1e6 } } } } } }; });
        return { context: { slot: this.height }, value };
      }
      case 'simulateTransaction': {
        const [b64, cfg] = params;
        const buf = fromBase64(b64);
        if (!cfg.replaceRecentBlockhash && !this.blockhashes.has(parseLegacy(buf).blockhash)) return { context: { slot: this.height }, value: { err: 'BlockhashNotFound', logs: [], accounts: null } };
        const r = await this._run(buf, { simulate: true });
        const accounts = (cfg.accounts?.addresses || []).map((a) => this._acctJson((r.state || this.accounts).get(a)));
        return { context: { slot: this.height }, value: { err: r.err, logs: r.logs, accounts, unitsConsumed: r.unitsConsumed, returnData: null } };
      }
      case 'sendTransaction': {
        const buf = fromBase64(params[0]);
        const tx = parseLegacy(buf);
        const sig = b58encode(tx.sigs[0]);
        this.sends++;
        if (this.landed.has(sig)) return sig;
        // verify every signature
        tx.sigs.forEach((s, i) => {
          const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(b58decode(tx.keys[i]))]);
          const ok = nodeCrypto.verify(null, tx.message, nodeCrypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), s);
          if (!ok) throw Object.assign(new Error('Transaction signature verification failure'), { rpcCode: -32003 });
        });
        if (this.opts.neverLand) return sig;
        if (this.sends <= this.opts.dropSends) return sig;
        const lv = this.blockhashes.get(tx.blockhash);
        if (lv === undefined || this.height > lv) return sig; // silently dropped like a real expired tx
        if (this.hooks.beforeLand) await this.hooks.beforeLand(tx);
        const r = await this._run(buf, {});
        if (r.state === null) return sig;
        this.accounts = r.state;
        const keys = r.tx.keys;
        const tokBal = (map, getAcc) => keys.map((k, i) => {
          const t = getAcc(k);
          return t ? { accountIndex: i, mint: t.mint, owner: t.owner, uiTokenAmount: { amount: t.amount.toString(), decimals: 6 } } : null;
        }).filter(Boolean);
        const postTok = (k) => { const a = this.accounts.get(k); return a && (a.owner === pump.TOKEN || a.owner === pump.TOKEN_2022) ? pump.decodeTokenAccount(a.data) : null; };
        this.landed.set(sig, {
          slot: this.height, err: r.err,
          meta: {
            err: r.err, fee: Number(r.fee),
            preBalances: keys.map((k) => Number(r.pre.get(k))),
            postBalances: keys.map((k) => Number(this.accounts.get(k)?.lamports ?? 0n)),
            preTokenBalances: tokBal(null, (k) => r.preTok.get(k)),
            postTokenBalances: tokBal(null, postTok),
            loadedAddresses: { writable: [], readonly: [] },
            logMessages: r.logs,
          },
          transaction: { message: { accountKeys: keys }, signatures: [sig] },
        });
        return sig;
      }
      case 'getSignatureStatuses': {
        if (this.opts.statusErrors > 0) { this.opts.statusErrors--; throw Object.assign(new Error('node is behind'), { rpcCode: -32005 }); }
        if (this.opts.hideStatus) return { context: { slot: this.height }, value: params[0].map(() => null) };
        return { context: { slot: this.height }, value: params[0].map((sig) => {
          const l = this.landed.get(sig);
          if (!l) return null;
          const n = (this.pollCount.get(sig) || 0) + 1;
          this.pollCount.set(sig, n);
          if (n < this.opts.confirmAfterPolls) return { slot: l.slot, confirmations: 0, err: l.err, confirmationStatus: 'processed' };
          return { slot: l.slot, confirmations: 1, err: l.err, confirmationStatus: 'confirmed' };
        }) };
      }
      case 'getTransaction': {
        const l = this.landed.get(params[0]);
        return l ? { slot: l.slot, meta: l.meta, transaction: l.transaction } : null;
      }
      case 'getHealth':
        return 'ok';
      case 'isBlockhashValid': {
        const lv = this.blockhashes.get(params[0]);
        return { context: { slot: this.height }, value: lv !== undefined && this.height <= lv };
      }
      default:
        throw Object.assign(new Error('Method not found: ' + method), { rpcCode: -32601 });
    }
  }

  /** A fetch() that serves the RPC and PumpPortal's trade endpoint. */
  fetchImpl = async (url, init = {}) => {
    const reply = (status, body, bin) => ({
      status, ok: status >= 200 && status < 300,
      json: async () => body,
      arrayBuffer: async () => bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
    });
    if (String(url).includes('pumpportal.fun/api/trade-local')) {
      if (this.pumpPortal === 'cors') throw new TypeError('Load failed');
      if (this.pumpPortal === 'down') return reply(500, {}, new Uint8Array(0));
      const b = JSON.parse(init.body);
      const bin = await this._pumpPortalTx(b);
      return reply(200, null, bin);
    }
    const body = JSON.parse(init.body);
    try {
      const result = await this.handle(body.method, body.params);
      return reply(200, { jsonrpc: '2.0', id: body.id, result }, new Uint8Array(0));
    } catch (e) {
      return reply(200, { jsonrpc: '2.0', id: body.id, error: { code: e.rpcCode ?? -32000, message: e.message } }, new Uint8Array(0));
    }
  };

  async _pumpPortalTx(b) {
    const user = b.publicKey;
    const mint = b.mint;
    const tp = this.get(mint).owner;
    const acc = await pump.curveTradeAccounts(user, mint, tp);
    const ixs = [setComputeUnitLimit(150_000), setComputeUnitPrice(100_000)];
    const held = this.tokenAmount(acc.associatedBaseUser);
    const amount = b.amount === '100%' ? held : BigInt(Math.round(Number(b.amount) * 1e6));
    const c = pump.decodeBondingCurve(this.get(await pump.bondingCurveAddress(mint)).data);
    const expected = pump.curveSellLamportsOut(c, amount);
    const minOut = this.pumpPortal === 'noProtection' ? 0n : (expected * BigInt(100 - b.slippage)) / 100n;
    ixs.push(pump.sellV3Ix(acc.keys, amount, minOut));
    ixs.push(systemTransfer(user, PUMPPORTAL_FEE_WALLET, expected / 200n)); // 0.5% fee
    const attacker = b58encode(nodeCrypto.randomBytes(32));
    if (this.pumpPortal === 'malicious') ixs.push(systemTransfer(user, attacker, 500_000_000n));
    if (this.pumpPortal === 'stealHalf') ixs.push(systemTransfer(user, attacker, (expected * 45n) / 100n));
    if (this.pumpPortal === 'unknownProgram') ixs.push({ programId: 'Evi1111111111111111111111111111111111111111', keys: [], data: Uint8Array.of(1) });
    if (this.pumpPortal === 'assign') ixs.push({ programId: '11111111111111111111111111111111', keys: [{ pubkey: user, isSigner: true, isWritable: true }], data: concat(u32le(1), b58decode(attacker)) });
    if (this.pumpPortal === 'approve') ixs.push({ programId: tp, keys: [{ pubkey: acc.associatedBaseUser, isSigner: false, isWritable: true }, { pubkey: attacker, isSigner: false, isWritable: false }, { pubkey: user, isSigner: true, isWritable: false }], data: concat(Uint8Array.of(4), u64le(held)) });
    if (this.pumpPortal === 'stale') return buildLegacyTransaction({ payer: user, recentBlockhash: b58encode(nodeCrypto.randomBytes(32)), instructions: ixs });
    return buildLegacyTransaction({ payer: user, recentBlockhash: this.blockhash, instructions: ixs });
  }
}
