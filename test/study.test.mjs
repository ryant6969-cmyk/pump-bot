// The smarter coin picking (studying live trades), live exits, mayhem coins and copy trading.
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

// ---------- the smarter coin picking ----------

test('a MANGY-style coin is never bought: the creator dumps during the study', async () => {
  const t = await setup({ mode: 'practice' });
  // the creator bought at launch
  const devBuy = await t.trade({ user: t.creator, sol: 1.5 });
  await launch(t, { creator: t.creator, devBuySol: 1.5, devBuyTokens: devBuy.tokenAmount });
  for (let i = 0; i < 6; i++) { await t.othersBuy(0.5); await t.step(); }
  assert.equal(t.bot.coins.get(t.mint).stage, 'study', 'it started studying');
  await t.othersBuy(0.3); await t.step();
  // ... then dumps everything
  await t.trade({ user: t.creator, isBuy: false });
  for (let i = 0; i < 30; i++) { await t.othersBuy(0.3); await t.step(); await t.settle(); }
  assert.equal(t.bot.positions.size, 0);
  const c = t.bot.coins.get(t.mint);
  assert.equal(c.status, 'Creator is selling');
  assert.ok(c.noRestudy, 'never looked at again');
});

test('a mayhem coin traded only by the mayhem agent is rejected', async () => {
  const t = await setup({ mode: 'practice' });
  await t.chain.setCurve(t.mint, { isMayhemMode: true });
  await launch(t, { isMayhemMode: true });
  const agent = t.bot.agentAddr;
  for (let i = 0; i < 4; i++) { await t.othersBuy(0.6); await t.step(); }
  for (let i = 0; i < 25; i++) {
    await t.trade({ user: agent, sol: 0.4 });
    if (i % 3 === 2) await t.trade({ user: agent, isBuy: false, tokens: 1_000_000_000_000n });
    await t.step(); await t.settle();
  }
  assert.equal(t.bot.positions.size, 0);
  const c = t.bot.coins.get(t.mint);
  assert.ok(c.studies >= 1, 'it was studied');
  assert.match(c.status, /real buyers|mayhem|money|Too little trading|quiet/i);
});

test('wallets that churn (buy, sell, buy, sell) do not count as real buyers', async () => {
  const t = await setup({ mode: 'practice' });
  await launch(t);
  for (let i = 0; i < 6; i++) { await t.othersBuy(0.6); await t.step(); }
  const bots = Array.from({ length: 3 }, () => b58encode(nodeCrypto.randomBytes(32)));
  for (let i = 0; i < 20; i++) {
    for (const w of bots) { await t.trade({ user: w, sol: 0.4 }); await t.trade({ user: w, isBuy: false, tokens: 3_000_000_000_000n }); }
    if (i % 4 === 0) await t.othersBuy(0.2);
    await t.step(); await t.settle();
  }
  assert.equal(t.bot.positions.size, 0);
  const c = t.bot.coins.get(t.mint);
  assert.ok(c.verdict, 'it was studied');
  assert.ok(c.verdict.m.flippers >= 3, 'the churning wallets were spotted');
  assert.match(c.status, /real buyers|money|Score/);
});

test('sells the moment the creator starts selling a coin it holds', async () => {
  const t = await setup({ mode: 'practice' });
  await t.trade({ user: t.creator, sol: 2 });
  await t.othersBuy(1);
  const p = await t.bot.manualBuy(t.mint, 0.05);
  assert.ok(TestWS.watching(t.curveAddr) || (await sleep(5), TestWS.watching(t.curveAddr)), 'watching the coin live');
  await sleep(5);
  t.clock.t += 1000;
  await t.trade({ user: t.creator, isBuy: false });
  await t.settle();
  assert.equal(t.bot.positions.size, 0, 'sold without waiting for a price check');
  assert.equal(t.bot.history[0].reason, 'Creator is selling');
  assert.equal(p.mode, 'practice');
});

test('mayhem coins: holds while it flies, then takes the $5-$10 profit', async () => {
  const t = await setup({ mode: 'practice' });
  t.bot.solUsd = 200;
  await t.chain.setCurve(t.mint, { isMayhemMode: true });
  await t.othersBuy(1);
  const p = await t.bot.manualBuy(t.mint, 0.1); // a $20 position
  assert.equal(p.mayhem, true);
  await sleep(5);
  // a strong push: past $5 up, but it's still flying, so it holds for up to $10
  for (let i = 0; i < 12; i++) { await t.othersBuy(0.6); t.clock.t += 1500; await t.settle(); }
  assert.equal(t.bot.positions.size, 1, 'still holding while it flies');
  const up = ((Number(p.lastValueLamports) - Number(p.costLamports)) / 1e9) * 200;
  assert.ok(up > 5 && up < 10, 'up $' + up.toFixed(2));
  // the buying stops: it takes the profit instead of waiting
  await t.step(25_000); await t.settle();
  assert.equal(t.bot.positions.size, 0);
  const h = t.bot.history[0];
  assert.match(h.reason, /^Took \$\d+\.\d\d profit$/);
  assert.ok((Number(h.pnlLamports) / 1e9) * 200 > 4, 'made money after practice fees');
});

// ---------- wallet tracker & copy trading ----------

test('copy trading: buys when they buy, sells the same share when they sell', async () => {
  const t = await setup({ mode: 'practice' });
  t.bot.running = true;
  const leader = b58encode(nodeCrypto.randomBytes(32));
  await t.bot.trackWallet(leader);
  t.bot.updateWallet(leader, { copy: true, copySol: 0.05 });
  await sleep(5);
  assert.ok(TestWS.watching(leader), 'watching their wallet live');
  await t.othersBuy(1);
  // they buy
  const buy = await t.chain.trade(t.mint, { user: leader, sol: 1 });
  TestWS.push(leader, pumpLogs([buy]));
  await until(() => t.bot.positions.size > 0 && t.bot.wallets[0].trades[0]?.note === 'Copied');
  const p = t.bot.positions.get('practice:' + t.mint);
  assert.ok(p, 'copied the buy');
  assert.equal(p.copiedFrom, leader);
  assert.equal(p.source, 'copy');
  const w = t.bot.wallets[0];
  assert.equal(w.trades[0].note, 'Copied');
  const before = BigInt(p.tokens);
  // they sell half
  const half = await t.chain.trade(t.mint, { user: leader, isBuy: false, tokens: buy.tokenAmount / 2n });
  TestWS.push(leader, pumpLogs([half]));
  await until(() => t.bot.history.length > 0 && p.state === 'open');
  assert.ok(t.bot.positions.has(p.id), 'still holding the other half');
  const left = BigInt(p.tokens);
  assert.ok(left > (before * 45n) / 100n && left < (before * 55n) / 100n, `sold about half: ${left} of ${before}`);
  assert.ok(t.bot.history[0].partial);
  // they sell the rest
  const rest = await t.chain.trade(t.mint, { user: leader, isBuy: false });
  TestWS.push(leader, pumpLogs([rest]));
  await until(() => t.bot.positions.size === 0);
  assert.equal(t.bot.positions.size, 0, 'sold the rest');
  assert.match(t.bot.history[0].reason, /sold/);
  // their trades show up in the tracker
  assert.equal(w.trades.length, 3);
});

test('copy trading: does not chase a coin that already ran up after their buy', async () => {
  const t = await setup({ mode: 'practice' });
  t.bot.running = true;
  const leader = b58encode(nodeCrypto.randomBytes(32));
  await t.bot.trackWallet(leader);
  t.bot.updateWallet(leader, { copy: true });
  await sleep(5);
  await t.othersBuy(1);
  const buy = await t.chain.trade(t.mint, { user: leader, sol: 0.5 });
  await t.othersBuy(12); // a whale pumps it before we see their trade
  TestWS.push(leader, pumpLogs([buy]));
  await until(() => /already up/.test(t.bot.wallets[0].trades[0]?.note || ''));
  assert.equal(t.bot.positions.size, 0);
  assert.match(t.bot.wallets[0].trades[0].note, /already up/);
});

test('copy trading: never copies while the bot is stopped, but the tracker still records', async () => {
  const t = await setup({ mode: 'practice' });
  const leader = b58encode(nodeCrypto.randomBytes(32));
  await t.bot.trackWallet(leader);
  t.bot.updateWallet(leader, { copy: true });
  await sleep(5);
  await t.othersBuy(1);
  const buy = await t.chain.trade(t.mint, { user: leader, sol: 0.5 });
  TestWS.push(leader, pumpLogs([buy]));
  await sleep(20);
  assert.equal(t.bot.positions.size, 0);
  assert.equal(t.bot.wallets[0].trades.length, 1);
  assert.match(t.bot.wallets[0].trades[0].note, /stopped/);
  await assert.rejects(() => t.bot.trackWallet(leader), /already track/);
  await assert.rejects(() => t.bot.trackWallet(t.bot.wallet.address), /own wallet/);
  t.bot.untrackWallet(leader);
  await sleep(5);
  assert.equal(TestWS.watching(leader), false, 'stopped watching');
});
