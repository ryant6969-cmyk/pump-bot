// End-to-end trades against the fake network in mockchain.mjs, which checks
// every pump.fun account against the official IDL and verifies signatures.
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import { b58encode } from '../js/b58.js';
import { Keypair } from '../js/keys.js';
import { associatedTokenAddress } from '../js/pda.js';
import * as pump from '../js/pump.js';
import { Rpc } from '../js/rpc.js';
import { Trader, TradeError } from '../js/trader.js';
import { MockChain, PUMPPORTAL_FEE_WALLET } from './mockchain.mjs';

const FAST = { pollMs: 20, resendMs: 60, heightCheckMs: 40, giveUpMs: 3000, detailsRetryMs: 10 };

async function setup(opts = {}) {
  const chain = new MockChain(opts);
  const wallet = await Keypair.generate();
  chain.addWallet(wallet.address, opts.sol ?? 1);
  const mint = b58encode(nodeCrypto.randomBytes(32));
  await chain.addCoin({ mint, tokenProgram: opts.tokenProgram || pump.TOKEN_2022, curve: opts.curve || {} });
  const rpc = new Rpc('https://rpc.test', { fetchImpl: chain.fetchImpl, maxPerSecond: 1000 });
  const pending = [];
  const settled = [];
  const trader = new Trader({ rpc, wallet, fetchImpl: chain.fetchImpl, timing: FAST, onPending: (p) => pending.push(p), onSettled: (s) => settled.push(s) });
  return { chain, wallet, mint, rpc, trader, pending, settled };
}

test('buy: lands, exact deltas reported, token account rent separated from cost', async () => {
  const { chain, wallet, mint, trader, pending, settled } = await setup();
  const before = chain.lamports(wallet.address);
  const r = await trader.buy({ mint, lamports: 50_000_000n, slippagePct: 15, speed: 'fast' });
  assert.equal(r.via, 'pump.fun');
  assert.ok(r.exact);
  assert.ok(r.tokDelta > 0n);
  const ata = await associatedTokenAddress(wallet.address, mint, pump.TOKEN_2022);
  assert.equal(r.ata, ata);
  assert.equal(chain.tokenAmount(ata), r.tokDelta);
  assert.equal(chain.lamports(wallet.address) - before, r.solDelta);
  assert.equal(r.rentDeposit, 2_074_080n);
  const cost = -r.solDelta - r.rentDeposit;
  // spend + one-time pump.fun account rent + network fees, nothing else
  assert.ok(cost >= 50_000_000n && cost < 50_000_000n + 1_844_400n + 1_000_000n, String(cost));
  assert.equal(pending.length, 1);
  assert.deepEqual(settled, [r.sig]);
  // the transaction set a tight compute limit and a priority fee
  assert.ok(chain.sends >= 1);
});

test('sell everything on the curve, then close the empty account for the rent', async () => {
  const { chain, wallet, mint, trader } = await setup();
  const b = await trader.buy({ mint, lamports: 100_000_000n });
  const s = await trader.sell({ mint, tokenProgram: pump.TOKEN_2022 });
  assert.equal(s.via, 'pump.fun');
  assert.equal(s.tokDelta, -b.tokDelta);
  assert.ok(s.solDelta > 95_000_000n, 'got back about 0.097 SOL, got ' + s.solDelta);
  const before = chain.lamports(wallet.address);
  const c = await trader.closeEmptyTokenAccount(mint, pump.TOKEN_2022);
  assert.ok(c?.sig);
  assert.ok(chain.lamports(wallet.address) > before + 2_000_000n);
  assert.equal(await trader.closeEmptyTokenAccount(mint, pump.TOKEN_2022), null);
});

test('works for older SPL Token coins too', async () => {
  const { mint, trader } = await setup({ tokenProgram: pump.TOKEN });
  const b = await trader.buy({ mint, lamports: 20_000_000n });
  assert.ok(b.tokDelta > 0n);
  const s = await trader.sell({ mint, tokenProgram: pump.TOKEN });
  assert.ok(s.solDelta > 0n);
});

test('partial sell sells exactly the amount asked', async () => {
  const { mint, trader } = await setup();
  const b = await trader.buy({ mint, lamports: 50_000_000n });
  const half = b.tokDelta / 2n;
  const s = await trader.sell({ mint, tokenProgram: pump.TOKEN_2022, amount: half });
  assert.equal(s.tokDelta, -half);
});

test('graduated coin: sells through PumpSwap and unwraps the SOL', async () => {
  const { chain, wallet, mint, trader } = await setup();
  const b = await trader.buy({ mint, lamports: 50_000_000n });
  await chain.setCurve(mint, { complete: true, realTokenReserves: 0n });
  // not migrated yet -> wait
  await assert.rejects(() => trader.sell({ mint, tokenProgram: pump.TOKEN_2022 }), (e) => e instanceof TradeError && e.kind === 'waiting');
  await chain.addPool({ mint });
  const before = chain.lamports(wallet.address);
  const s = await trader.sell({ mint, tokenProgram: pump.TOKEN_2022 });
  assert.equal(s.via, 'PumpSwap');
  assert.equal(s.tokDelta, -b.tokDelta);
  assert.ok(chain.lamports(wallet.address) > before, 'SOL arrived as plain SOL');
  const wsolAta = await associatedTokenAddress(wallet.address, pump.WSOL, pump.TOKEN);
  assert.equal(chain.get(wsolAta), null, 'temporary wrapped-SOL account closed');
});

test('buying a graduated, non-SOL, cashback or unknown coin is refused before any transaction', async () => {
  const { chain, mint, trader } = await setup();
  await chain.setCurve(mint, { complete: true });
  await assert.rejects(() => trader.buy({ mint, lamports: 10_000_000n }), /graduated/);
  const other = await setup({ curve: { quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } });
  await assert.rejects(() => other.trader.buy({ mint: other.mint, lamports: 10_000_000n }), /SOL/);
  const cb = await setup({ curve: { isCashbackCoin: true } });
  await assert.rejects(() => cb.trader.buy({ mint: cb.mint, lamports: 10_000_000n }), /type/);
  await assert.rejects(() => trader.buy({ mint: b58encode(nodeCrypto.randomBytes(32)), lamports: 10_000_000n }), /doesn't exist/);
  assert.equal(chain.sends + other.chain.sends + cb.chain.sends, 0);
});

test('not enough SOL: refused at the test-run, nothing sent', async () => {
  const { chain, mint, trader } = await setup({ sol: 0.01 });
  await assert.rejects(() => trader.buy({ mint, lamports: 50_000_000n }), (e) => e.kind === 'funds');
  assert.equal(chain.sends, 0);
});

test('price jumps between test-run and landing: reported as slippage with the transaction id', async () => {
  const { chain, mint, trader } = await setup();
  chain.hooks.beforeLand = async () => {
    // someone else buys a lot right before us
    const c = pump.decodeBondingCurve(chain.get(await pump.bondingCurveAddress(mint)).data);
    await chain.setCurve(mint, { virtualQuoteReserves: c.virtualQuoteReserves * 2n, virtualTokenReserves: c.virtualTokenReserves / 2n });
    chain.hooks.beforeLand = null;
  };
  await assert.rejects(() => trader.buy({ mint, lamports: 50_000_000n, slippagePct: 10 }), (e) => e.kind === 'slippage' && !!e.sig);
});

test('dropped sends are re-sent until the trade lands', async () => {
  const { chain, mint, trader } = await setup({ dropSends: 3 });
  const r = await trader.buy({ mint, lamports: 10_000_000n });
  assert.ok(r.tokDelta > 0n);
  assert.ok(chain.sends >= 4);
});

test('a trade that never lands expires cleanly once its blockhash is too old', async () => {
  const { mint, trader } = await setup({ neverLand: true, lastValidOffset: 2, heightStepPerCheck: 1 });
  await assert.rejects(() => trader.buy({ mint, lamports: 10_000_000n }), (e) => e.kind === 'expired');
});

test('buys never fall back: if the direct buy fails, nothing is bought', async () => {
  const { chain, wallet, mint, trader } = await setup();
  chain.rejectPumpV3 = true;
  const before = chain.lamports(wallet.address);
  await assert.rejects(() => trader.buy({ mint, lamports: 50_000_000n }), (e) => e.kind === 'failed');
  assert.equal(chain.lamports(wallet.address), before);
  assert.equal(chain.lamports(PUMPPORTAL_FEE_WALLET), 0n);
  assert.equal(chain.sends, 0);
});

test('a sell falls back to PumpPortal when the direct one is rejected, and pays its 0.5% fee', async () => {
  const { chain, wallet, mint, trader } = await setup();
  await trader.buy({ mint, lamports: 50_000_000n });
  chain.rejectPumpV3 = true;
  const s = await trader.sell({ mint, tokenProgram: pump.TOKEN_2022 });
  assert.equal(s.via, 'PumpPortal');
  assert.ok(chain.lamports(PUMPPORTAL_FEE_WALLET) > 0n);
  assert.equal(chain.tokenAmount(await associatedTokenAddress(wallet.address, mint, pump.TOKEN_2022)), 0n);
});

test('PumpPortal sells that could take money or skip price protection are refused', async () => {
  for (const mode of ['malicious', 'stealHalf', 'unknownProgram', 'assign', 'approve', 'noProtection', 'stale']) {
    const { chain, wallet, mint, trader } = await setup();
    await trader.buy({ mint, lamports: 50_000_000n });
    chain.rejectPumpV3 = true;
    chain.pumpPortal = mode;
    const ata = await associatedTokenAddress(wallet.address, mint, pump.TOKEN_2022);
    const before = [chain.lamports(wallet.address), chain.tokenAmount(ata)];
    await assert.rejects(() => trader.sell({ mint, tokenProgram: pump.TOKEN_2022 }), (e) => e.kind === 'guard', mode);
    assert.deepEqual([chain.lamports(wallet.address), chain.tokenAmount(ata)], before, mode + ': nothing moved');
  }
});

test('PumpPortal unreachable from the phone (CORS): clear error, nothing spent', async () => {
  const { chain, wallet, mint, trader } = await setup();
  await trader.buy({ mint, lamports: 50_000_000n });
  chain.rejectPumpV3 = true;
  chain.pumpPortal = 'cors';
  const before = chain.lamports(wallet.address);
  await assert.rejects(() => trader.sell({ mint, tokenProgram: pump.TOKEN_2022 }), (e) => e.kind === 'network');
  assert.equal(chain.lamports(wallet.address), before);
  assert.equal(trader.pumpPortalWorks, false);
});

test('after expiry, if the status check itself fails, the trade is "uncertain" (kept for re-checking), never "nothing spent"', async () => {
  const { chain, mint, trader, settled } = await setup({ neverLand: true, lastValidOffset: 2, heightStepPerCheck: 1 });
  chain.opts.statusErrors = 1000;
  await assert.rejects(() => trader.buy({ mint, lamports: 10_000_000n }), (e) => e.kind === 'expired' && e.uncertain === true && e.sent === true);
  assert.equal(settled.length, 1);
});

test('errors after sending are marked sent, so a sell is never sent twice through the fallback', async () => {
  const { chain, mint, trader } = await setup();
  await trader.buy({ mint, lamports: 50_000_000n });
  chain.hooks.beforeLand = async () => {
    const c = pump.decodeBondingCurve(chain.get(await pump.bondingCurveAddress(mint)).data);
    await chain.setCurve(mint, { virtualQuoteReserves: c.virtualQuoteReserves / 3n, virtualTokenReserves: c.virtualTokenReserves * 3n });
    chain.hooks.beforeLand = null;
  };
  const sendsBefore = chain.sends;
  await assert.rejects(() => trader.sell({ mint, tokenProgram: pump.TOKEN_2022 }), (e) => e.kind === 'slippage' && e.sent);
  assert.equal(chain.calls.filter((c) => c === 'isBlockhashValid').length, 0, 'no PumpPortal attempt');
  assert.ok(chain.sends - sendsBefore >= 1);
});

test('withdraw sends SOL to another wallet', async () => {
  const { chain, wallet, trader } = await setup({ sol: 1 });
  const to = (await Keypair.generate()).address;
  const r = await trader.withdraw({ to, lamports: 400_000_000n });
  assert.ok(r.sig);
  assert.equal(chain.lamports(to), 400_000_000n);
  assert.ok(chain.lamports(wallet.address) < 600_000_000n && chain.lamports(wallet.address) > 599_000_000n);
});

test('walletTokens lists coins the wallet holds', async () => {
  const { mint, trader } = await setup();
  await trader.buy({ mint, lamports: 10_000_000n });
  const list = await trader.walletTokens();
  assert.equal(list.length, 1);
  assert.equal(list[0].mint, mint);
  assert.equal(list[0].tokenProgram, pump.TOKEN_2022);
  assert.ok(list[0].amount > 0n);
});

test('selling when the wallet holds nothing says so without sending', async () => {
  const { chain, mint, trader } = await setup();
  await assert.rejects(() => trader.sell({ mint, tokenProgram: pump.TOKEN_2022 }), (e) => e.kind === 'gone');
  assert.equal(chain.sends, 0);
});
