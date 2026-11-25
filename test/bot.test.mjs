// The whole bot against the fake network: a coin launches, other people buy
// it, the bot studies it, buys, and sells by its rules. Practice and Real.
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import { b58encode } from '../js/b58.js';
import { Bot } from '../js/bot.js';
import { Keypair } from '../js/keys.js';
import { Store } from '../js/store.js';
import { associatedTokenAddress } from '../js/pda.js';
import * as pump from '../js/pump.js';
import { pumpLogs } from './mockchain.mjs';
import { TestWS, SilentWS, FAST, sleep, until, bots, setup, launch, launchAndPump } from './harness.mjs';

test('practice: buys a rising coin after the holder check, then takes profit', async () => {
  const t = await setup({ mode: 'practice' });
  const start = t.bot.practice.balance;
  await launchAndPump(t);
  assert.equal(t.bot.positions.size, 1, 'bought: ' + JSON.stringify(t.bot.coins.get(t.mint)?.eval));
  const pos = [...t.bot.positions.values()][0];
  assert.equal(pos.mode, 'practice');
  assert.equal(pos.symbol, 'RDOG');
  const coin = t.bot.coins.get(t.mint);
  assert.ok(coin.holders.ok);
  // it really studied the trades first: 45 s of them, and the score passed
  assert.ok(pos.openedAt - coin.studyStart >= 45_000, 'studied for 45 s');
  assert.ok(coin.verdict.ok && coin.verdict.score >= coin.verdict.need, JSON.stringify(coin.verdict.vetoes));
  assert.ok(coin.verdict.m.uniqueBuyers >= 8);
  assert.equal(pos.score, coin.verdict.score);
  assert.ok(t.bot.practice.balance < start);
  // the coin keeps flying -> take profit at +50%
  for (let i = 0; i < 30 && t.bot.positions.size; i++) { await t.othersBuy(2.5); await t.step(); await t.settle(); }
  assert.equal(t.bot.positions.size, 0);
  const h = t.bot.history[0];
  assert.equal(h.reason, 'Take profit');
  assert.ok(h.pnlLamports > 0n);
  assert.ok(t.bot.practice.balance > start, 'practice balance grew');
  assert.equal(t.chain.sends, 0, 'practice mode never sends a transaction');
  assert.ok(t.bot.stats('practice').wins === 1);
});

test('real: buys and sells on-chain, records exact cost and profit, reclaims rent', async () => {
  const t = await setup({ mode: 'real', sol: 1 });
  await launchAndPump(t);
  assert.equal(t.bot.positions.size, 1);
  const pos = [...t.bot.positions.values()][0];
  assert.equal(pos.mode, 'real');
  assert.ok(pos.buySig);
  const ata = await associatedTokenAddress(t.bot.wallet.address, t.mint, pump.TOKEN_2022);
  assert.equal(t.chain.tokenAmount(ata), pos.tokens, 'position matches the chain');
  assert.ok(pos.costLamports >= 50_000_000n && pos.costLamports < 53_000_000n, 'cost ~0.05 SOL + fees: ' + pos.costLamports);
  for (let i = 0; i < 30 && t.bot.positions.size; i++) { await t.othersBuy(2.5); await t.step(); await t.settle(); }
  assert.equal(t.bot.positions.size, 0);
  const h = t.bot.history[0];
  assert.equal(h.mode, 'real');
  assert.equal(h.reason, 'Take profit');
  assert.ok(h.sellSig && h.buySig);
  assert.ok(h.pnlLamports > 20_000_000n, 'profit recorded: ' + h.pnlLamports);
  await sleep(50); await t.settle();
  assert.equal(t.chain.get(ata), null, 'empty token account closed, rent returned');
  assert.equal(t.bot.stats('real').todayLamports, h.pnlLamports);
});

test('real: stop loss sells a falling coin', async () => {
  const t = await setup({ mode: 'real', sol: 1 });
  await launchAndPump(t);
  assert.equal(t.bot.positions.size, 1);
  await t.othersSell(0.35);
  await t.step();
  await t.settle();
  assert.equal(t.bot.positions.size, 0);
  assert.equal(t.bot.history[0].reason, 'Stop loss');
  assert.ok(t.bot.history[0].pnlLamports < 0n);
});

test('skips a coin when one wallet holds too much', async () => {
  const t = await setup({ mode: 'practice' });
  const whale = b58encode(nodeCrypto.randomBytes(32));
  await t.chain.giveTokens(whale, t.mint, 150_000_000_000_000n); // 15% of supply
  await launchAndPump(t);
  assert.equal(t.bot.positions.size, 0);
  const c = t.bot.coins.get(t.mint);
  assert.ok(c.holders && !c.holders.ok && /One wallet holds/.test(c.holders.reason), JSON.stringify(c.holders));
});

test('limits: no buys past the daily loss limit; max open trades respected', async () => {
  const t = await setup({ mode: 'practice' });
  t.bot.daily.practice = -300_000_000n; // lost 0.3 SOL today, limit is 0.25
  await launchAndPump(t);
  assert.equal(t.bot.positions.size, 0);
  assert.equal(t.bot.entryBlock, 'Daily loss limit reached');
  assert.ok(t.bot.alerts.has('daily'));
});

test('coins already in the wallet are listed but never sold without a tap', async () => {
  const t = await setup({ mode: 'real', sol: 1 });
  await t.chain.giveTokens(t.bot.wallet.address, t.mint, 5_000_000_000_000n);
  await t.bot.reconcile();
  const p = t.bot.positions.get('real:' + t.mint);
  assert.ok(p && p.found && p.managed === false);
  await t.othersSell(0.5);
  for (let i = 0; i < 3; i++) { await t.step(); await t.settle(); }
  assert.ok(t.bot.positions.has('real:' + t.mint), 'not auto-sold');
  t.bot.sellNow('real:' + t.mint);
  await t.settle();
  assert.equal(t.bot.positions.size, 0);
  assert.equal(t.bot.history[0].reason, 'Sold by you');
});

test('withdraw to Phantom, and refuses bad addresses', async () => {
  const t = await setup({ mode: 'real', sol: 0.5 });
  const phantom = b58encode(nodeCrypto.randomBytes(32));
  await assert.rejects(() => t.bot.withdraw('not-an-address', 0.1), /isn't a Solana address/);
  await assert.rejects(() => t.bot.withdraw(t.bot.wallet.address, 0.1), /bot wallet itself/);
  await t.bot.withdraw(phantom, 'max');
  assert.ok(t.chain.lamports(phantom) > 490_000_000n);
  assert.ok(t.chain.lamports(t.bot.wallet.address) < 3_000_000n);
});

test('everything survives an app restart (positions, history, wallet)', async () => {
  const t = await setup({ mode: 'real', sol: 1 });
  await launchAndPump(t);
  assert.equal(t.bot.positions.size, 1);
  const addr = t.bot.wallet.address;
  t.bot.dispose();
  const bot2 = new Bot({ store: new Store(t.storage), fetchImpl: t.chain.fetchImpl, WebSocketImpl: SilentWS, now: () => t.clock.t, timing: FAST });
  bots.push(bot2);
  await bot2.init();
  assert.equal(bot2.wallet.address, addr);
  assert.equal(bot2.positions.size, 1);
  const p = [...bot2.positions.values()][0];
  assert.equal(typeof p.tokens, 'bigint');
  assert.equal(bot2.running, false, 'never auto-starts buying after a restart');
  assert.equal(bot2.wasRunning, true);
  // it still manages the open trade
  await t.othersSell(0.4);
  t.clock.t += 2500;
  await bot2._poll();
  await until(() => bot2.positions.size === 0, 10_000);
  assert.equal(bot2.positions.size, 0);
  assert.equal(bot2.history[0].reason, 'Stop loss');
});

test('manual buy validates input and refuses coins you already hold', async () => {
  const t = await setup({ mode: 'practice' });
  await assert.rejects(() => t.bot.manualBuy('nope', 0.05), /valid coin address/);
  await assert.rejects(() => t.bot.manualBuy(t.mint, 0), /how much SOL/);
  await t.othersBuy(1);
  const p = await t.bot.manualBuy(t.mint, 0.05);
  assert.equal(p.source, 'manual');
  await assert.rejects(() => t.bot.manualBuy(t.mint, 0.05), /already hold/);
});

test('a buy that lands while the app is closed is recovered as a managed trade with its exact cost', async () => {
  const t = await setup({ mode: 'real', sol: 1 });
  await t.othersBuy(1);
  // simulate: the trade was sent, then iOS closed the app before it confirmed
  const r = await t.bot.trader.buy({ mint: t.mint, lamports: 50_000_000n });
  t.bot.pending = [{ sig: r.sig, kind: 'buy', mint: t.mint, at: t.clock.t, lastValidBlockHeight: 99999 }];
  t.bot._save();
  t.bot.dispose();
  const bot2 = new Bot({ store: new Store(t.storage), fetchImpl: t.chain.fetchImpl, WebSocketImpl: SilentWS, now: () => t.clock.t, timing: FAST });
  bots.push(bot2);
  await bot2.init();
  await bot2.reconcile();
  const p = bot2.positions.get('real:' + t.mint);
  assert.ok(p, 'position recovered');
  assert.equal(p.managed, true);
  assert.equal(p.buySig, r.sig);
  assert.equal(p.costLamports, -r.solDelta - r.rentDeposit);
  assert.equal(bot2.pending.length, 0);
});

test('double tap: a second buy of the same coin is refused while the first runs', async () => {
  const t = await setup({ mode: 'real', sol: 1 });
  await t.othersBuy(1);
  const a = t.bot.manualBuy(t.mint, 0.05);
  await assert.rejects(() => t.bot.manualBuy(t.mint, 0.05), /Already buying/);
  await a;
  const ata = await associatedTokenAddress(t.bot.wallet.address, t.mint, pump.TOKEN_2022);
  assert.equal([...t.bot.positions.values()][0].tokens, t.chain.tokenAmount(ata));
});

test('only a real price move widens sell slippage (waiting for PumpSwap does not)', async () => {
  const t = await setup({ mode: 'real', sol: 1 });
  await t.othersBuy(1);
  const p = await t.bot.manualBuy(t.mint, 0.05);
  await t.chain.setCurve(t.mint, { complete: true, realTokenReserves: 0n });
  t.bot.sellNow(p.id);
  for (let i = 0; i < 3; i++) { await t.settle(); p.nextSellAt = 0; t.bot._sell(p, 'test'); }
  await t.settle();
  assert.ok(t.bot.positions.has(p.id), 'still waiting for the pool');
  assert.equal(p.slipSteps || 0, 0);
  await t.chain.addPool({ mint: t.mint });
  let minOut = null;
  t.chain.hooks.beforeLand = (tx) => {
    const ix = tx.ixs.find((i) => i.program === pump.PUMP_AMM);
    if (ix) minOut = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(16, true);
  };
  p.nextSellAt = 0;
  t.bot._sell(p, 'test');
  await t.settle();
  assert.equal(t.bot.positions.size, 0);
  const h = t.bot.history[0];
  // 25% slippage (Balanced): min out is ~75% of the quote, not 30%
  assert.ok(minOut !== null && Number(minOut) > Number(h.proceedsLamports) * 0.7, `minOut ${minOut} vs got ${h.proceedsLamports}`);
});

test('one empty read of the token account does not drop a position; two do', async () => {
  const t = await setup({ mode: 'real', sol: 1 });
  await t.othersBuy(1);
  const p = await t.bot.manualBuy(t.mint, 0.05);
  const ata = await associatedTokenAddress(t.bot.wallet.address, t.mint, pump.TOKEN_2022);
  const saved = t.chain.get(ata);
  t.chain.accounts.delete(ata); // a lagging node that hasn't seen the buy
  await t.bot._sell(p, 'test');
  assert.ok(t.bot.positions.has(p.id), 'kept after one empty read');
  t.chain.set(ata, saved);
  p.nextSellAt = 0;
  await t.bot._sell(p, 'test');
  await t.settle();
  assert.equal(t.bot.positions.size, 0);
  assert.equal(t.bot.history.length, 1);
  assert.equal(t.bot.history[0].reason, 'test');
});

test('a position is closed and counted once, even if two paths close it', async () => {
  const t = await setup({ mode: 'practice' });
  await t.othersBuy(1);
  const p = await t.bot.manualBuy(t.mint, 0.05);
  t.bot._close(p, { proceeds: 10_000_000n, reason: 'a', sig: null, via: 'x' });
  t.bot._close(p, { proceeds: 10_000_000n, reason: 'b', sig: null, via: 'x' });
  assert.equal(t.bot.history.length, 1);
  assert.equal(t.bot.daily.practice, 10_000_000n - p.costLamports);
});

test('a funded wallet is never replaced; an unreadable one only after confirming the backup', async () => {
  const t = await setup({ mode: 'real', sol: 0.5 });
  await assert.rejects(() => t.bot.createWallet({ confirmedBackup: true }), /still holds/);
  const other = (await Keypair.generate()).exportSecret();
  await assert.rejects(() => t.bot.importWallet(other, { confirmedBackup: true }), /still holds/);
  t.chain.opts.statusErrors = 0;
  const addr = t.bot.wallet.address;
  t.chain.accounts.delete(addr); // empty wallet now
  await t.bot.createWallet();
  assert.notEqual(t.bot.wallet.address, addr);
});

