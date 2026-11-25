// Real trades on Solana. Every transaction goes through the same steps:
//   1. read the coin's live state and work out a safe minimum price
//   2. build the transaction (or get one from PumpPortal as a fallback)
//   3. test-run it on the network and check exactly how the wallet's SOL and
//      tokens would change; refuse to sign if anything looks wrong
//   4. sign, send, re-send until confirmed, then read the exact result.

import { fromBase64, readU32, readU64, toBase64 } from './bytes.js';
import { associatedTokenAddress } from './pda.js';
import * as pump from './pump.js';
import {
  buildLegacyTransaction, parseTransaction, signTransaction, transactionId,
  setComputeUnitLimit, setComputeUnitPrice, systemTransfer, SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM,
} from './tx.js';
import { SPEEDS } from './strategy.js';

const PUMPPORTAL_TRADE = 'https://pumpportal.fun/api/trade-local';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
// Sell instructions a PumpPortal fallback may contain (idl/pump.json, idl/pump_amm.json):
// discriminator -> index of the `user` and mint accounts, and the minimum account count.
const PUMP_SELLS = new Map([
  ['51,230,133,164,1,127,131,173', { user: 6, mint: 2, min: 14 }], // sell
  ['93,246,130,60,231,233,64,178', { user: 13, mint: 1, min: 26 }], // sell_v2
  ['28,146,222,119,38,196,105,213', { user: 8, mint: 1, min: 17 }], // sell_v3
]);
const AMM_SELLS = new Map([
  ['51,230,133,164,1,127,131,173', { user: 1, mint: 3, min: 21 }], // sell
  ['93,246,130,60,231,233,64,178', { user: 1, mint: 3, min: 17 }], // sell_v2
]);
// Rent for the token account (refunded when the bot closes it after selling),
// pump.fun's one-time volume account, network fee and margin. 0.008 SOL max.
const BUY_EXTRA_ALLOWANCE = 8_000_000n;
const FEE_ALLOWANCE = 300_000n; // base + priority fee margin when nothing else is paid
const MAX_CU = 400_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TradeError extends Error {
  /** kind: slippage | graduated | waiting | funds | unsupported | network | guard | expired | failed | gone */
  constructor(message, { kind = 'failed', sig = null, detail = null } = {}) {
    super(message);
    this.name = 'TradeError';
    this.kind = kind;
    this.sig = sig;
    this.detail = detail;
  }
}

/** Plain-English meaning of a Solana transaction error. */
export function explainTxError(err, programAt = () => null) {
  if (!err) return null;
  if (typeof err === 'string') {
    if (/InsufficientFunds|AccountNotFound/.test(err)) return { kind: 'funds', message: 'Not enough SOL in the bot wallet for this trade plus fees.' };
    if (/BlockhashNotFound/.test(err)) return { kind: 'expired', message: 'The network was busy. Trying again.' };
    return { kind: 'failed', message: 'The network rejected the trade (' + err + ').' };
  }
  const ie = err.InstructionError;
  if (Array.isArray(ie)) {
    const [idx, inner] = ie;
    const program = programAt(idx);
    const code = inner && typeof inner === 'object' && 'Custom' in inner ? inner.Custom : null;
    if (program === pump.PUMP) {
      if (code === 6002 || code === 6042) return { kind: 'slippage', message: 'The price jumped before the buy landed.' };
      if (code === 6003) return { kind: 'slippage', message: 'The price dropped before the sell landed.' };
      if (code === 6005 || code === 6081) return { kind: 'graduated', message: 'This coin just moved from pump.fun to PumpSwap.' };
      if (code === 6021) return { kind: 'unsupported', message: 'This coin is about to graduate. Skipping the buy.' };
      if (code === 6094) return { kind: 'unsupported', message: "This coin type can't be traded by the bot." };
      if (code === 6040 || code === 6041) return { kind: 'funds', message: 'Not enough SOL for this trade plus fees.' };
      if (code === 6023) return { kind: 'gone', message: 'The wallet no longer holds these tokens.' };
    }
    if (program === pump.PUMP_AMM) {
      if (code === 6004 || code === 6040) return { kind: 'slippage', message: 'The price moved before the trade landed.' };
      if (code === 6020 || code === 6021) return { kind: 'waiting', message: 'PumpSwap has trading paused for this coin. Will retry.' };
      if (code === 6079) return { kind: 'unsupported', message: "This coin type can't be traded by the bot." };
    }
    if (program === SYSTEM_PROGRAM && code === 1) return { kind: 'funds', message: 'Not enough SOL in the bot wallet.' };
    if ((program === pump.TOKEN || program === pump.TOKEN_2022) && code === 1) return { kind: 'gone', message: 'The wallet no longer holds these tokens.' };
    if (inner === 'InsufficientFunds' || inner === 'InsufficientFundsForRent') return { kind: 'funds', message: 'Not enough SOL in the bot wallet.' };
    return { kind: 'failed', message: 'The trade failed on-chain' + (code !== null ? ` (error ${code})` : '') + '.' };
  }
  if (err.InsufficientFundsForRent) return { kind: 'funds', message: 'Not enough SOL left to cover account rent.' };
  return { kind: 'failed', message: 'The trade failed on-chain.' };
}

export class Trader {
  constructor({ rpc, wallet, onPending = () => {}, onSettled = () => {}, log = () => {}, fetchImpl, timing = {} } = {}) {
    this.timing = { pollMs: 800, resendMs: 2000, heightCheckMs: 4000, giveUpMs: 120000, detailsRetryMs: 700, expiryRecheckMs: 1500, ...timing };
    this.rpc = rpc;
    this.wallet = wallet;
    this.onPending = onPending;
    this.onSettled = onSettled;
    this.log = log;
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.blockhash = null;
    this.feeCache = new Map();
    this.pumpPortalWorks = null; // null = untested
  }

  // ---------- reads ----------

  async getAccounts(addresses) {
    const res = await this.rpc.call('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]);
    return res.value.map((a) => (a ? { data: fromBase64(a.data[0]), owner: a.owner, lamports: BigInt(a.lamports) } : null));
  }

  async getBalance() {
    const r = await this.rpc.call('getBalance', [this.wallet.address, { commitment: 'confirmed' }]);
    return BigInt(r.value);
  }

  /** Live curve + token program for a coin. */
  async coinState(mint) {
    const curveAddr = await pump.bondingCurveAddress(mint);
    const [curveAcc, mintAcc] = await this.getAccounts([curveAddr, mint]);
    if (!mintAcc) throw new TradeError("That coin address doesn't exist on Solana.", { kind: 'unsupported' });
    const tokenProgram = mintAcc.owner;
    if (tokenProgram !== pump.TOKEN && tokenProgram !== pump.TOKEN_2022) throw new TradeError("That address isn't a coin.", { kind: 'unsupported' });
    const curve = curveAcc && curveAcc.owner === pump.PUMP ? pump.decodeBondingCurve(curveAcc.data) : null;
    return { curve, curveAddr, tokenProgram, mintInfo: pump.decodeMint(mintAcc.data) };
  }

  async walletTokens() {
    const out = [];
    for (const programId of [pump.TOKEN, pump.TOKEN_2022]) {
      const r = await this.rpc.call('getTokenAccountsByOwner', [this.wallet.address, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      for (const it of r.value || []) {
        const info = it.account?.data?.parsed?.info;
        if (!info?.mint || !info.tokenAmount) continue;
        out.push({ ata: it.pubkey, mint: info.mint, amount: BigInt(info.tokenAmount.amount), tokenProgram: programId });
      }
    }
    return out;
  }

  async _blockhash() {
    if (this.blockhash && Date.now() - this.blockhash.at < 15000) return this.blockhash;
    const r = await this.rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    this.blockhash = { blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight, at: Date.now() };
    return this.blockhash;
  }

  async priorityPrice(speed, writableAccounts = []) {
    const s = SPEEDS[speed] || SPEEDS.fast;
    const key = speed + '|' + writableAccounts.join(',');
    const hit = this.feeCache.get(key);
    if (hit && Date.now() - hit.at < 10000) return hit.price;
    let price = s.microLamports;
    try {
      const fees = await this.rpc.call('getRecentPrioritizationFees', [writableAccounts.slice(0, 64)], { retries: 0, timeoutMs: 5000 });
      const vals = (fees || []).map((f) => Number(f.prioritizationFee)).filter((v) => v > 0).sort((a, b) => a - b);
      if (vals.length) price = Math.max(price, Math.min(vals[Math.floor(vals.length * 0.75)], s.maxMicroLamports));
    } catch { /* use the default for this speed */ }
    price = Math.round(price);
    this.feeCache.set(key, { price, at: Date.now() });
    return price;
  }

  // ---------- trades ----------

  /** maxPrice (SOL per raw token): don't buy if the coin already costs more than that (copy trading). */
  async buy({ mint, lamports, slippagePct = 15, speed = 'fast', maxPrice = null, refPrice = null }) {
    lamports = BigInt(lamports);
    const user = this.wallet.address;
    const st = await this.coinState(mint);
    const c = st.curve;
    if (!c) throw new TradeError("This isn't a pump.fun coin (or it's very old).", { kind: 'unsupported' });
    if (maxPrice && !c.complete && c.virtualTokenReserves > 0n) {
      const now = Number(c.virtualQuoteReserves) / Number(c.virtualTokenReserves);
      if (now > maxPrice) throw new TradeError(refPrice ? `the price is already up ${Math.round((now / refPrice - 1) * 100)}% since they bought` : 'the price ran away', { kind: 'skipped' });
    }
    if (c.complete) throw new TradeError('This coin already graduated to PumpSwap. The bot only buys coins still on pump.fun.', { kind: 'unsupported' });
    if (!pump.isSolPaired(c) || c.depth > 0) throw new TradeError("This coin isn't paired with SOL. The bot only trades SOL coins.", { kind: 'unsupported' });
    if (c.isCashbackCoin) throw new TradeError("This coin type can't be traded by the bot.", { kind: 'unsupported' });
    const expected = pump.curveBuyTokensOut(c, lamports);
    if (expected <= 0n) throw new TradeError('Nothing left to buy on this coin.', { kind: 'unsupported' });
    const minOut = (expected * BigInt(Math.round((100 - slippagePct) * 100))) / 10000n;
    const acc = await pump.curveTradeAccounts(user, mint, st.tokenProgram);
    const core = [
      pump.createAtaIdempotent(user, acc.associatedBaseUser, user, mint, st.tokenProgram),
      pump.buyExactQuoteInV3Ix(acc.keys, lamports, minOut > 0n ? minOut : 1n),
    ];
    const expect = { side: 'buy', maxSolDecrease: lamports + BUY_EXTRA_ALLOWANCE, minTokenIncrease: minOut > 0n ? minOut : 1n };
    // No fallback for buys: if the direct buy fails, the bot simply doesn't buy.
    const r = await this._execute({ kind: 'buy', mint, speed, core, tokenAccount: acc.associatedBaseUser, writable: [acc.bondingCurve], expect });
    return { ...r, tokenProgram: st.tokenProgram, ata: acc.associatedBaseUser, via: 'pump.fun' };
  }

  /** Sell `amount` raw tokens (or everything when amount is null). */
  async sell({ mint, tokenProgram, amount = null, slippagePct = 25, speed = 'fast', allowFallback = true }) {
    const user = this.wallet.address;
    // read the coin and our token account together (one round trip) when the token program is known
    const guessAta = tokenProgram ? await associatedTokenAddress(user, mint, tokenProgram) : null;
    const [st, guess] = await Promise.all([this.coinState(mint), guessAta ? this.getAccounts([guessAta]) : null]);
    const known = tokenProgram && st.tokenProgram === tokenProgram;
    tokenProgram = st.tokenProgram || tokenProgram;
    const ata = known ? guessAta : await associatedTokenAddress(user, mint, tokenProgram);
    const [tokAcc] = known ? guess : await this.getAccounts([ata]);
    const held = tokAcc ? pump.decodeTokenAccount(tokAcc.data)?.amount ?? 0n : 0n;
    if (held <= 0n) throw new TradeError('The wallet has none of this coin left.', { kind: 'gone' });
    const qty = amount === null || BigInt(amount) > held ? held : BigInt(amount);
    const slipBps = BigInt(Math.round((100 - slippagePct) * 100));
    const c = st.curve;
    let core, writable, expectedOut, venue;
    if (c && !c.complete) {
      expectedOut = pump.curveSellLamportsOut(c, qty);
      const minOut = (expectedOut * slipBps) / 10000n;
      const acc = await pump.curveTradeAccounts(user, mint, tokenProgram);
      core = [pump.sellV3Ix(acc.keys, qty, minOut)];
      writable = [acc.bondingCurve];
      venue = 'pump.fun';
    } else {
      const pool = await pump.canonicalPoolAddress(mint);
      const [poolAcc] = await this.getAccounts([pool]);
      const ps = poolAcc && poolAcc.owner === pump.PUMP_AMM ? pump.decodePool(poolAcc.data) : null;
      if (!ps) throw new TradeError('This coin is moving to PumpSwap. The bot will sell as soon as it opens.', { kind: 'waiting' });
      if (ps.isCashbackCoin) throw new TradeError("This coin type can't be sold by the bot. Import the wallet into Phantom to sell it.", { kind: 'unsupported' });
      const [baseAcc, quoteAcc] = await this.getAccounts([ps.poolBaseTokenAccount, ps.poolQuoteTokenAccount]);
      const baseReserve = pump.decodeTokenAccount(baseAcc?.data)?.amount ?? 0n;
      const quoteReserve = (pump.decodeTokenAccount(quoteAcc?.data)?.amount ?? 0n) + ps.virtualQuoteReserves;
      expectedOut = pump.poolSellLamportsOut(baseReserve, quoteReserve, qty);
      if (expectedOut <= 0n) throw new TradeError("Couldn't price this coin on PumpSwap right now. Will retry.", { kind: 'waiting' });
      const minOut = (expectedOut * slipBps) / 10000n;
      const a = await pump.ammSellAccounts(user, mint, tokenProgram, pool, ps);
      core = [
        pump.createAtaIdempotent(user, a.userQuote, user, pump.WSOL, pump.TOKEN),
        pump.ammSellV2Ix(a.keys, qty, minOut),
        pump.closeTokenAccount(a.userQuote, user, user, pump.TOKEN),
      ];
      writable = [pool];
      venue = 'PumpSwap';
    }
    const minGain = (expectedOut * slipBps) / 10000n;
    const expect = { side: 'sell', maxTokenDecrease: qty, minSolIncrease: minGain - FEE_ALLOWANCE - 3_000_000n };
    try {
      const r = await this._execute({ kind: 'sell', mint, speed, core, tokenAccount: ata, writable, expect });
      return { ...r, tokensSold: qty, via: venue, tokenProgram, ata };
    } catch (e) {
      if (!allowFallback || !this._shouldFallback(e)) throw e;
      // Last resort so a coin never gets stuck: PumpPortal's builder, under strict checks.
      this.log('warn', 'Direct sell failed (' + e.message + '). Trying PumpPortal.');
      const r = await this._viaPumpPortalSell({
        mint, qty, expectedOut, tokenAccount: ata,
        minOutRequired: (minGain * 9n) / 10n,
        body: { publicKey: user, action: 'sell', mint, amount: qty === held ? '100%' : String(Number(qty) / 10 ** pump.TOKEN_DECIMALS), denominatedInSol: 'false', slippage: slippagePct, priorityFee: 0.0005, pool: 'auto' },
      });
      return { ...r, tokensSold: qty, via: 'PumpPortal', tokenProgram, ata };
    }
  }

  /** Send SOL from the bot wallet to another wallet. */
  async withdraw({ to, lamports }) {
    lamports = BigInt(lamports);
    if (lamports <= 0n) throw new TradeError('Nothing to send.', { kind: 'funds' });
    const core = [systemTransfer(this.wallet.address, to, lamports)];
    return this._execute({ kind: 'withdraw', mint: null, speed: 'normal', core, tokenAccount: null, writable: [], cuLimit: 3000,
      expect: { side: 'withdraw', maxSolDecrease: lamports + FEE_ALLOWANCE } });
  }

  /** Close an empty token account to get its rent (~0.002 SOL) back. Best effort. */
  async closeEmptyTokenAccount(mint, tokenProgram) {
    const user = this.wallet.address;
    const ata = await associatedTokenAddress(user, mint, tokenProgram);
    const [acc] = await this.getAccounts([ata]);
    if (!acc) return null;
    const t = pump.decodeTokenAccount(acc.data);
    if (!t || t.amount !== 0n) return null;
    const core = [pump.closeTokenAccount(ata, user, user, tokenProgram)];
    return this._execute({ kind: 'close', mint, speed: 'normal', core, tokenAccount: null, writable: [], cuLimit: 10000,
      expect: { side: 'close', maxSolDecrease: FEE_ALLOWANCE } });
  }

  _shouldFallback(e) {
    if (e?.sent) return false; // our own transaction already went out: never risk a second sale
    if (e?.name === 'RpcError') return false; // connection problem: PumpPortal needs it too
    if (!(e instanceof TradeError)) return true;
    // Only when our own transaction failed its test-run for a reason we don't recognise
    // (for example after a pump.fun program upgrade).
    return e.kind === 'failed' && !e.sig;
  }

  // ---------- the shared pipeline ----------

  async _snapshot(tokenAccount) {
    const addrs = [this.wallet.address, ...(tokenAccount ? [tokenAccount] : [])];
    const accs = await this.getAccounts(addrs);
    const tok = tokenAccount ? accs[1] : null;
    return {
      lamports: accs[0]?.lamports ?? 0n,
      owner: accs[0]?.owner ?? SYSTEM_PROGRAM,
      tokens: tok ? pump.decodeTokenAccount(tok.data)?.amount ?? 0n : 0n,
      tokenExists: !!tok,
      tokenLamports: tok ? tok.lamports : 0n,
    };
  }

  async _simulate(txBytes, tokenAccount) {
    const addresses = [this.wallet.address, ...(tokenAccount ? [tokenAccount] : [])];
    const r = await this.rpc.call('simulateTransaction', [toBase64(txBytes), {
      encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed',
      accounts: { encoding: 'base64', addresses },
    }]);
    const v = r.value || {};
    const w = v.accounts?.[0];
    const t = tokenAccount ? v.accounts?.[1] : null;
    const post = {
      lamports: w ? BigInt(w.lamports) : null,
      owner: w ? w.owner : null,
      tokens: t ? pump.decodeTokenAccount(fromBase64(t.data[0]))?.amount ?? 0n : 0n,
    };
    return { err: v.err || null, logs: v.logs || [], unitsConsumed: Number(v.unitsConsumed || 0), post };
  }

  /** Refuse anything that would move more SOL or tokens than the trade should. */
  _guard(pre, post, expect, priorityLamports) {
    if (post.lamports === null) throw new TradeError('Safety check could not read the wallet. Trade cancelled.', { kind: 'guard' });
    // the wallet must still be a normal wallet afterwards (nothing may reassign it)
    if (post.owner && post.owner !== SYSTEM_PROGRAM) throw new TradeError('Safety check: this transaction would change who controls the wallet. Cancelled.', { kind: 'guard' });
    const solDelta = post.lamports - pre.lamports; // negative = SOL leaves the wallet
    const tokDelta = post.tokens - pre.tokens;
    const feeRoom = priorityLamports + FEE_ALLOWANCE;
    if (expect.maxSolDecrease !== undefined && -solDelta > expect.maxSolDecrease + feeRoom) {
      throw new TradeError(`Safety check: this trade would take ${(Number(-solDelta) / 1e9).toFixed(4)} SOL, more than expected. Cancelled.`, { kind: 'guard' });
    }
    if (expect.minTokenIncrease !== undefined && tokDelta < expect.minTokenIncrease) {
      throw new TradeError('Safety check: the buy would deliver fewer coins than allowed. Cancelled.', { kind: 'guard' });
    }
    if (expect.maxTokenDecrease !== undefined && -tokDelta > expect.maxTokenDecrease) {
      throw new TradeError('Safety check: the sell would remove more coins than asked. Cancelled.', { kind: 'guard' });
    }
    if (expect.minSolIncrease !== undefined && solDelta < expect.minSolIncrease - feeRoom) {
      throw new TradeError('Safety check: the sell would pay out less SOL than allowed. Cancelled.', { kind: 'guard' });
    }
    return { solDelta, tokDelta };
  }

  async _execute({ kind, mint, speed, core, tokenAccount, writable, expect, cuLimit = null }) {
    const user = this.wallet.address;
    const [bh, pre, price] = await Promise.all([this._blockhash(), this._snapshot(tokenAccount), this.priorityPrice(speed, writable)]);
    const build = (limit) => buildLegacyTransaction({
      payer: user, recentBlockhash: bh.blockhash,
      instructions: [setComputeUnitLimit(limit), setComputeUnitPrice(price), ...core],
    });
    const programAt = (txBytes) => {
      const p = parseTransaction(txBytes);
      return (i) => p.staticKeys[p.instructions[i]?.programIdIndex] ?? null;
    };
    const testTx = build(cuLimit || MAX_CU);
    const sim = await this._simulate(testTx, tokenAccount);
    if (sim.err) {
      const x = explainTxError(sim.err, programAt(testTx));
      throw new TradeError(x.message, { kind: x.kind, detail: { err: sim.err, logs: sim.logs.slice(-12) } });
    }
    const units = cuLimit || Math.min(MAX_CU, Math.max(30_000, Math.ceil(sim.unitsConsumed * 1.2) + 15_000));
    const priorityLamports = BigInt(Math.ceil((units * price) / 1e6));
    this._guard(pre, sim.post, expect, BigInt(Math.ceil((MAX_CU * price) / 1e6)));
    const tx = build(units);
    const signed = await signTransaction(tx, this.wallet);
    return this._sendAndSettle({ kind, mint, signed, lastValidBlockHeight: bh.lastValidBlockHeight, pre, tokenAccount, programAt: programAt(tx), priorityLamports });
  }

  async _viaPumpPortalSell({ mint, qty, expectedOut, minOutRequired, tokenAccount, body }) {
    const user = this.wallet.address;
    const guard = (why) => new TradeError('Safety check: PumpPortal\'s transaction ' + why + '. Cancelled.', { kind: 'guard' });
    let res;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), 10000);
    try {
      res = await this.fetch(PUMPPORTAL_TRADE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl?.signal });
    } catch {
      this.pumpPortalWorks = false;
      throw new TradeError("Couldn't reach PumpPortal from this phone.", { kind: 'network' });
    } finally {
      clearTimeout(timer);
    }
    if (res.status !== 200) throw new TradeError('PumpPortal refused the trade (' + res.status + ').', { kind: 'failed' });
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.pumpPortalWorks = true;
    let p;
    try { p = parseTransaction(bytes); } catch { throw guard('is unreadable'); }
    if (p.header.numRequiredSignatures !== 1 || p.staticKeys[0] !== user) throw guard('needs another signer');
    if (p.lookups.length) throw guard("uses account tables the bot can't check");
    // Every instruction must be one of a few exact shapes.
    const key = (ix, i) => { const k = ix.accountIndexes[i]; return k !== undefined && k < p.staticKeys.length ? p.staticKeys[k] : null; };
    let sells = 0, creates = 0, transfers = 0, transferred = 0n, cuLimit = 200_000n, cuPrice = 0n;
    for (const ix of p.instructions) {
      const prog = p.staticKeys[ix.programIdIndex];
      const d = ix.data;
      if (prog === COMPUTE_BUDGET_PROGRAM) {
        if (d[0] === 2 && d.length === 5) cuLimit = BigInt(readU32(d, 1));
        else if (d[0] === 3 && d.length === 9) cuPrice = readU64(d, 1);
        else if (!(d[0] === 4 && d.length === 5)) throw guard('has an unexpected compute setting');
      } else if (prog === SYSTEM_PROGRAM) {
        if (d.length !== 12 || readU32(d, 0) !== 2 || key(ix, 0) !== user) throw guard('has an unexpected system instruction');
        transferred += readU64(d, 4);
        transfers++;
      } else if (prog === pump.ATA_PROGRAM) {
        if (!(d.length === 0 || (d.length === 1 && (d[0] === 0 || d[0] === 1)))) throw guard('has an unexpected account instruction');
        if (key(ix, 0) !== user || key(ix, 2) !== user) throw guard('creates an account for someone else');
        creates++;
      } else if (prog === pump.TOKEN || prog === pump.TOKEN_2022) {
        if (d.length === 1 && d[0] === 9) { if (key(ix, 1) !== user || key(ix, 2) !== user) throw guard('closes an account to someone else'); }
        else if (!(d.length === 1 && d[0] === 17)) throw guard('moves tokens in an unexpected way');
      } else if (prog === pump.PUMP || prog === pump.PUMP_AMM) {
        const shape = (prog === pump.PUMP ? PUMP_SELLS : AMM_SELLS).get(Array.from(d.subarray(0, 8)).join(','));
        if (!shape || d.length < 24 || ix.accountIndexes.length < shape.min) throw guard('is not a plain sell');
        if (key(ix, shape.user) !== user || key(ix, shape.mint) !== mint) throw guard('sells the wrong coin or for someone else');
        const amount = readU64(d, 8), minOut = readU64(d, 16);
        if (amount <= 0n || amount > qty) throw guard('sells more than asked');
        if (minOut < minOutRequired) throw guard('has no price protection');
        sells++;
      } else if (prog !== MEMO_PROGRAM) {
        throw guard('calls an unknown program');
      }
    }
    if (sells !== 1 || creates > 2 || transfers > 2) throw guard('has an unexpected shape');
    if (transferred > (expectedOut * 6n) / 1000n + 500_000n) throw guard('takes too big a fee');
    if ((cuLimit * cuPrice) / 1_000_000n > 10_000_000n) throw guard('pays too big a network fee');
    // A normal recent blockhash (rules out transactions that never expire).
    const valid = await this.rpc.call('isBlockhashValid', [p.recentBlockhash, { commitment: 'confirmed' }]).catch(() => null);
    if (valid?.value !== true) throw guard('has an unusual or stale blockhash');
    const pre = await this._snapshot(tokenAccount);
    const sim = await this._simulate(bytes, tokenAccount);
    const programAt = (i) => p.staticKeys[p.instructions[i]?.programIdIndex] ?? null;
    if (sim.err) {
      const x = explainTxError(sim.err, programAt);
      throw new TradeError(x.message, { kind: x.kind, detail: { err: sim.err, logs: sim.logs.slice(-12) } });
    }
    this._guard(pre, sim.post, { side: 'sell', maxTokenDecrease: qty, minSolIncrease: minOutRequired - transferred - FEE_ALLOWANCE - 3_000_000n }, 10_000_000n);
    const signed = await signTransaction(bytes, this.wallet);
    let lastValidBlockHeight = null;
    // The blockhash was valid just now, so it expires within 150 blocks from here.
    try { lastValidBlockHeight = (await this.rpc.call('getBlockHeight', [{ commitment: 'confirmed' }])) + 151; } catch {}
    return this._sendAndSettle({ kind: 'sell', mint, signed, lastValidBlockHeight, pre, tokenAccount, programAt });
  }

  async _sendAndSettle({ kind, mint, signed, lastValidBlockHeight, pre, tokenAccount, programAt }) {
    const sig = transactionId(signed);
    const b64 = toBase64(signed);
    this.onPending({ sig, kind, mint, lastValidBlockHeight, at: Date.now() });
    let uncertain = false;
    try {
      const status = await this._sendUntilFinal(sig, b64, lastValidBlockHeight);
      if (status.err) {
        const x = explainTxError(status.err, programAt);
        throw new TradeError(x.message, { kind: x.kind, sig, detail: { err: status.err } });
      }
      const details = await this._details(sig, tokenAccount, pre);
      return { sig, ...details };
    } catch (e) {
      if (e && typeof e === 'object') e.sent = true;
      if (e instanceof TradeError && e.uncertain) uncertain = true;
      // An expired buy is re-checked for a few minutes anyway, in case a lagging node missed it.
      else if (e instanceof TradeError && e.kind === 'expired' && kind === 'buy') uncertain = true;
      else if (!(e instanceof TradeError)) uncertain = true; // unexpected error after sending: re-check later
      throw e;
    } finally {
      // Uncertain trades stay on the pending list so the bot re-checks them later.
      this.onSettled(sig, uncertain);
    }
  }

  async _sendUntilFinal(sig, b64, lastValidBlockHeight) {
    const send = () => this.rpc.call('sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }], { retries: 1, timeoutMs: 8000 });
    try { await send(); } catch (e) {
      // A send error can still mean it reached the network: keep checking.
      this.log('warn', 'Send error: ' + e.message);
    }
    const start = Date.now();
    let lastSend = start, lastHeightCheck = start;
    const T = this.timing;
    const uncertainError = () => Object.assign(new TradeError("Couldn't confirm the trade yet. The bot will check it again shortly.", { kind: 'expired', sig }), { uncertain: true });
    for (;;) {
      await sleep(T.pollMs);
      let st = null;
      try {
        const r = await this.rpc.call('getSignatureStatuses', [[sig], { searchTransactionHistory: false }], { retries: 1, timeoutMs: 6000 });
        st = r?.value?.[0] || null;
      } catch {}
      if (st) {
        if (st.err) return { err: st.err };
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { err: null };
      }
      const now = Date.now();
      if (now - lastSend > T.resendMs) { lastSend = now; send().catch(() => {}); }
      if (lastValidBlockHeight && now - lastHeightCheck > T.heightCheckMs) {
        lastHeightCheck = now;
        let h = null;
        try { h = await this.rpc.call('getBlockHeight', [{ commitment: 'confirmed' }], { retries: 0, timeoutMs: 5000 }); } catch {}
        if (h !== null && h > lastValidBlockHeight) {
          // Its blockhash is too old to land now. Make sure it didn't land before that:
          // ask a few times, a moment apart, and only call it "not sent" if every answer agrees.
          let unknown = false;
          for (let i = 0; i < 3; i++) {
            const f = await this._statusOf(sig);
            if (f.state === 'landed') return { err: f.err };
            if (f.state === 'unknown') unknown = true;
            await sleep(T.expiryRecheckMs);
          }
          if (unknown) throw uncertainError();
          throw new TradeError("The network didn't take the trade in time. Nothing was spent.", { kind: 'expired', sig });
        }
      }
      if (now - start > T.giveUpMs) {
        const f = await this._statusOf(sig);
        if (f.state === 'landed') return { err: f.err };
        throw uncertainError();
      }
    }
  }

  /** landed (with its error, if any) | missing | unknown (couldn't ask). */
  async _statusOf(sig) {
    try {
      const r = await this.rpc.call('getSignatureStatuses', [[sig], { searchTransactionHistory: true }], { retries: 1, timeoutMs: 8000 });
      const st = r?.value?.[0];
      if (!st) return { state: 'missing' };
      if (st.err || st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { state: 'landed', err: st.err || null };
      return { state: 'unknown' }; // seen but not confirmed yet
    } catch {
      return { state: 'unknown' };
    }
  }

  /** Exact SOL and token change of our own wallet from the confirmed transaction. Never throws. */
  async _details(sig, tokenAccount, pre) {
    for (let i = 0; i < 8; i++) {
      try {
        const t = await this.rpc.call('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
        if (t?.meta) return readMeta(t, this.wallet.address, tokenAccount);
      } catch (e) {
        if (e?.code === -32015 || /version/i.test(e?.message || '')) {
          try {
            const t = await this.rpc.call('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
            if (t?.meta) return readMeta(t, this.wallet.address, tokenAccount);
          } catch {}
        }
      }
      await sleep(this.timing.detailsRetryMs);
    }
    // Fall back to comparing balances before and after.
    for (let i = 0; i < 3; i++) {
      try {
        const post = await this._snapshot(tokenAccount);
        return {
          solDelta: post.lamports - pre.lamports, tokDelta: post.tokens - pre.tokens,
          rentDeposit: !pre.tokenExists && post.tokenExists ? post.tokenLamports : 0n, exact: false,
        };
      } catch { await sleep(this.timing.detailsRetryMs * 2); }
    }
    return { solDelta: null, tokDelta: null, rentDeposit: 0n, exact: false };
  }
}

/** SOL / token deltas for `owner` from a getTransaction result. */
export function readMeta(t, owner, tokenAccount) {
  const keys = (t.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const loaded = [...(t.meta.loadedAddresses?.writable || []), ...(t.meta.loadedAddresses?.readonly || [])];
  const all = [...keys, ...loaded];
  const wi = all.indexOf(owner);
  const solDelta = wi >= 0 ? BigInt(t.meta.postBalances[wi]) - BigInt(t.meta.preBalances[wi]) : 0n;
  let tokDelta = 0n, rentDeposit = 0n;
  if (tokenAccount) {
    const ti = all.indexOf(tokenAccount);
    const amt = (list) => {
      const e = (list || []).find((b) => b.accountIndex === ti);
      return e ? BigInt(e.uiTokenAmount.amount) : 0n;
    };
    if (ti >= 0) {
      tokDelta = amt(t.meta.postTokenBalances) - amt(t.meta.preTokenBalances);
      const preLamports = BigInt(t.meta.preBalances[ti] ?? 0);
      const postLamports = BigInt(t.meta.postBalances[ti] ?? 0);
      if (preLamports === 0n && postLamports > 0n) rentDeposit = postLamports; // token account opened by this trade
    }
  }
  return { solDelta, tokDelta, rentDeposit, fee: BigInt(t.meta.fee || 0), exact: true };
}

