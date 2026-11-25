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
  assert.match(c.status, /real buyers|money|Score|One wallet/);
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

test('copy trading: copies right away even when the bot is not started; the tracker records it', async () => {
  const t = await setup({ mode: 'practice' });
  assert.equal(t.bot.running, false);
  const leader = b58encode(nodeCrypto.randomBytes(32));
  await t.bot.trackWallet(leader);
  t.bot.updateWallet(leader, { copy: true });
  await sleep(5);
  assert.ok(TestWS.all.some((ws) => !ws.closed && ws.subs.has(leader)));
  await t.othersBuy(1);
  const buy = await t.chain.trade(t.mint, { user: leader, sol: 0.5 });
  TestWS.push(leader, pumpLogs([buy]));
  await until(() => t.bot.positions.size === 1);
  assert.equal([...t.bot.positions.values()][0].copiedFrom, leader);
  assert.equal(t.bot.wallets[0].trades.length, 1);
  await assert.rejects(() => t.bot.trackWallet(leader), /already track/);
  await assert.rejects(() => t.bot.trackWallet(t.bot.wallet.address), /own wallet/);
  t.bot.untrackWallet(leader);
  await sleep(5);
  assert.equal(TestWS.watching(leader), false, 'stopped watching');
});

test('copy trading: when they sell a graduated coin on PumpSwap, the bot sells too', async () => {
  const { encodeAmmTradeEvent } = await import('./mockchain.mjs');
  const t = await setup({ mode: 'practice' });
  const leader = b58encode(nodeCrypto.randomBytes(32));
  await t.bot.trackWallet(leader);
  t.bot.updateWallet(leader, { copy: true });
  await sleep(5);
  await t.othersBuy(1);
  const buy = await t.chain.trade(t.mint, { user: leader, sol: 0.5 });
  TestWS.push(leader, pumpLogs([buy]));
  await until(() => t.bot.positions.size === 1);
  // the coin graduates; they sell everything on PumpSwap
  await t.chain.setCurve(t.mint, { complete: true, realTokenReserves: 0n });
  const pool = await t.chain.addPool({ mint: t.mint });
  const sell = encodeAmmTradeEvent({ isBuy: false, baseAmount: buy.tokenAmount, userBaseBefore: buy.tokenAmount, solAmount: 600_000_000n, pool, user: leader });
  TestWS.push(leader, pumpLogs([sell], { program: pump.PUMP_AMM }));
  await until(() => t.bot.positions.size === 0);
  assert.equal(t.bot.positions.size, 0, 'sold');
  assert.match(t.bot.history[0].reason, /sold/);
  const w = t.bot.wallets[0];
  assert.equal(w.trades[0].pool, pool);
  await until(() => w.trades[0].note === 'Copied the sell');
  assert.equal(w.trades[0].mint, t.mint);
});

for (const mode of ['practice', 'real']) {
  test(`copy trading (${mode}): copies their buy of a graduated coin on PumpSwap, then their sell`, async () => {
    const { encodeAmmTradeEvent } = await import('./mockchain.mjs');
    const t = await setup({ mode, sol: 2 });
    if (mode === 'real') await t.bot.refreshBalance();
    const leader = b58encode(nodeCrypto.randomBytes(32));
    await t.bot.trackWallet(leader);
    t.bot.updateWallet(leader, { copy: true, copySol: 0.1 });
    await sleep(5);
    await t.chain.setCurve(t.mint, { complete: true, realTokenReserves: 0n });
    const pool = await t.chain.addPool({ mint: t.mint });
    // they buy 1 SOL worth on PumpSwap at about the pool's price
    const base = 200_000_000_000_000n * 1_000_000_000n / (85_000_000_000n + 1_000_000_000n);
    const buy = encodeAmmTradeEvent({ isBuy: true, baseAmount: base, userBaseBefore: 0n, solAmount: 1_000_000_000n, pool, user: leader });
    TestWS.push(leader, pumpLogs([buy], { program: pump.PUMP_AMM }));
    await until(() => t.bot.positions.size === 1);
    const p = [...t.bot.positions.values()][0];
    assert.equal(p.copiedFrom, leader);
    assert.equal(p.onPool, true);
    assert.equal(p.pool, pool);
    if (mode === 'real') assert.equal(p.via, 'PumpSwap');
    const w = t.bot.wallets[0];
    await until(() => w.trades[0].note === 'Copied');
    assert.equal(w.trades[0].note, 'Copied');
    assert.equal(w.trades[0].mint, t.mint);
    // a graduated coin is not sold just for being graduated
    await t.step();
    assert.equal(t.bot.positions.size, 1, 'still held');
    assert.ok(p.lastValueLamports > 0n, 'valued on PumpSwap');
    // they sell everything: so does the bot
    const sell = encodeAmmTradeEvent({ isBuy: false, baseAmount: base, userBaseBefore: base, solAmount: 990_000_000n, pool, user: leader });
    TestWS.push(leader, pumpLogs([sell], { program: pump.PUMP_AMM }));
    await until(() => t.bot.positions.size === 0, 6000);
    assert.equal(t.bot.positions.size, 0, 'sold');
    assert.match(t.bot.history[0].reason, /sold/);
  });
}

test('copy trading: a PumpSwap buy that already ran up 25%+ is not chased', async () => {
  const { encodeAmmTradeEvent } = await import('./mockchain.mjs');
  const t = await setup({ mode: 'practice' });
  const leader = b58encode(nodeCrypto.randomBytes(32));
  await t.bot.trackWallet(leader);
  t.bot.updateWallet(leader, { copy: true });
  await sleep(5);
  await t.chain.setCurve(t.mint, { complete: true, realTokenReserves: 0n });
  const pool = await t.chain.addPool({ mint: t.mint });
  // they paid half of today's price
  const base = 2n * 200_000_000_000_000n * 1_000_000_000n / 85_000_000_000n;
  const buy = encodeAmmTradeEvent({ isBuy: true, baseAmount: base, userBaseBefore: 0n, solAmount: 1_000_000_000n, pool, user: leader });
  TestWS.push(leader, pumpLogs([buy], { program: pump.PUMP_AMM }));
  await until(() => /already up/.test(t.bot.wallets[0].trades[0]?.note || ''));
  assert.match(t.bot.wallets[0].trades[0].note, /already up/);
  assert.equal(t.bot.positions.size, 0);
});

for (const mode of ['practice', 'real']) {
  test(`copy trading (${mode}): copies every coin they buy, even when they buy many at once`, async () => {
    const t = await setup({ mode, sol: 3 });
    if (mode === 'practice') t.bot.practice.balance = pump.solToLamports(3);
    const leader = b58encode(nodeCrypto.randomBytes(32));
    await t.bot.trackWallet(leader);
    t.bot.updateWallet(leader, { copy: true, copySol: 0.1 });
    await sleep(5);
    const mints = [];
    for (let i = 0; i < 8; i++) {
      const mint = b58encode(nodeCrypto.randomBytes(32));
      await t.chain.addCoin({ mint });
      mints.push(mint);
    }
    // they buy 8 different coins within a second
    const evs = [];
    for (const mint of mints) evs.push(await t.chain.trade(mint, { user: leader, sol: 0.3 }));
    for (const ev of evs) TestWS.push(leader, pumpLogs([ev]));
    await until(() => t.bot.positions.size === 8, 30000);
    assert.equal(t.bot.positions.size, 8, 'all 8 copied');
    for (const p of t.bot.positions.values()) assert.equal(p.copiedFrom, leader);
    // a second buy of a coin already copied isn't an error
    const again = await t.chain.trade(mints[0], { user: leader, sol: 0.2 });
    TestWS.push(leader, pumpLogs([again]));
    await until(() => t.bot.wallets[0].trades[0]?.note === 'Already copied this coin');
    assert.equal(t.bot.positions.size, 8);
  });
}

test('copy trading: when SOL runs low, copies with what is left instead of skipping', async () => {
  const t = await setup({ mode: 'practice' });
  t.bot.practice.balance = pump.solToLamports(0.15);
  const leader = b58encode(nodeCrypto.randomBytes(32));
  await t.bot.trackWallet(leader);
  t.bot.updateWallet(leader, { copy: true, copySol: 0.1 });
  await sleep(5);
  const second = b58encode(nodeCrypto.randomBytes(32));
  await t.chain.addCoin({ mint: second });
  const a = await t.chain.trade(t.mint, { user: leader, sol: 0.3 });
  TestWS.push(leader, pumpLogs([a]));
  await until(() => t.bot.positions.size === 1);
  const b = await t.chain.trade(second, { user: leader, sol: 0.3 });
  TestWS.push(leader, pumpLogs([b]));
  await until(() => t.bot.positions.size === 2);
  assert.equal(t.bot.positions.size, 2);
  assert.match(t.bot.wallets[0].trades[0].note, /all that was left/);
  // nothing left at all: now it says so
  const third = b58encode(nodeCrypto.randomBytes(32));
  await t.chain.addCoin({ mint: third });
  const c = await t.chain.trade(third, { user: leader, sol: 0.3 });
  TestWS.push(leader, pumpLogs([c]));
  await until(() => /not enough SOL left/.test(t.bot.wallets[0].trades[0]?.note || ''));
  assert.match(t.bot.wallets[0].trades[0].note, /not enough SOL left/);
});

// ---------- practice money ----------

test('practice money: the one-time $500 is added once the SOL price loads, and only once', async () => {
  const { MockChain } = await import('./mockchain.mjs');
  const { MemStorage } = await import('./harness.mjs');
  const chain = new MockChain();
  const fetchImpl = async (url, init) => (String(url).includes('coingecko') ? { ok: true, status: 200, json: async () => ({ solana: { usd: 125 } }) } : chain.fetchImpl(url, init));
  const storage = new MemStorage();
  const store = new Store(storage);
  store.save('settings', { settingsVersion: 2, setupDone: true, mode: 'practice', rpcInput: 'https://rpc.test/' });
  store.save('state', { practice: { balance: 250_000_000n } });
  const bot = new Bot({ store, fetchImpl, WebSocketImpl: TestWS, timing: FAST });
  bots.push(bot);
  await bot.init();
  await until(() => bot.practice.balance > 250_000_000n);
  assert.equal(bot.practice.balance, 250_000_000n + 4_000_000_000n, '$500 at $125 = 4 SOL');
  assert.equal(bot.settings.pendingPracticeUsd, 0);
  assert.match(bot.activity[0].message, /Added \$500 \(4\.000 SOL\)/);
  bot.dispose();
  const again = new Bot({ store: new Store(storage), fetchImpl, WebSocketImpl: TestWS, timing: FAST });
  bots.push(again);
  await again.init();
  await sleep(30);
  assert.equal(again.practice.balance, 4_250_000_000n, 'not added twice');
  // and the Add buttons work any time
  again.addPracticeUsd(100);
  assert.equal(again.practice.balance, 4_250_000_000n + 800_000_000n);
  again.solUsd = null;
  assert.throws(() => again.addPracticeUsd(100), /SOL price/);
});

test('sell buttons: sell part of a trade by hand, then the rest', async () => {
  const t = await setup({ mode: 'practice' });
  await t.othersBuy(1);
  const p = await t.bot.manualBuy(t.mint, 0.1);
  const before = BigInt(p.tokens);
  const bal = t.bot.practice.balance;
  t.bot.sellPart(p.id, 0.25);
  await until(() => p.state === 'open' && t.bot.history.length === 1);
  assert.equal(BigInt(p.tokens), before - before / 4n, 'sold a quarter');
  assert.ok(t.bot.practice.balance > bal, 'got practice SOL back');
  assert.ok(t.bot.history[0].partial);
  assert.equal(t.bot.history[0].reason, 'You sold 25%');
  t.bot.sellPart(p.id, 1);
  await until(() => t.bot.positions.size === 0);
  assert.equal(t.bot.history[0].reason, 'Sold by you');
  assert.equal(t.bot.stats('practice').trades, 1, 'one trade, partial sells included in its total');
});

test('dollars: the SOL price comes from the chain when price websites are blocked', async () => {
  const { MockChain, encodeTokenAccount } = await import('./mockchain.mjs');
  const { b58decode } = await import('../js/b58.js');
  const chain = new MockChain();
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const baseVault = b58encode(nodeCrypto.randomBytes(32)), quoteVault = b58encode(nodeCrypto.randomBytes(32));
  const pool = new Uint8Array(752);
  pool.set(b58decode(baseVault), 336); pool.set(b58decode(quoteVault), 368);
  pool.set(b58decode(pump.WSOL), 400); pool.set(b58decode(USDC), 432);
  chain.set('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', { lamports: 1n, owner: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', data: pool });
  chain.set(baseVault, { lamports: 1n, owner: pump.TOKEN, data: encodeTokenAccount(pump.WSOL, 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ', 100_000n * 10n ** 9n) });
  chain.set(quoteVault, { lamports: 1n, owner: pump.TOKEN, data: encodeTokenAccount(USDC, 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ', 14_250_000n * 10n ** 6n) });
  const blocked = async (url, init) => { if (/coingecko|coinbase|kraken|jup\.ag/.test(String(url))) throw new TypeError('Load failed'); return chain.fetchImpl(url, init); };
  const { MemStorage } = await import('./harness.mjs');
  const bot = new Bot({ store: new Store(new MemStorage()), fetchImpl: blocked, WebSocketImpl: TestWS, timing: FAST });
  bots.push(bot);
  await bot.init();
  bot.updateSettings({ rpcInput: 'https://rpc.test/' });
  assert.equal(await bot.refreshSolPrice(), 142.5);
  assert.equal(bot.solUsd, 142.5);
  // a pool whose vaults aren't SOL and USDC is never trusted
  chain.set(quoteVault, { lamports: 1n, owner: pump.TOKEN, data: encodeTokenAccount(b58encode(nodeCrypto.randomBytes(32)), 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ', 1n) });
  bot.solUsd = null;
  assert.equal(await bot.refreshSolPrice(), null);
  assert.equal(bot._usd(-1_500_000_000n), '');
  bot.solUsd = 142.5;
  assert.equal(bot._usd(-1_500_000_000n), ' (−$213.75)');
});

test('one release, one version: version.json, the app, the page and every import match', async () => {
  const fs = await import('node:fs');
  const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const v = JSON.parse(read('version.json')).version;
  assert.equal(read('js/main.js').match(/const VERSION = '([^']+)'/)[1], v);
  const html = read('index.html');
  for (const f of ['css/app.css', 'js/boot.js', 'js/main.js']) assert.ok(html.includes(`${f}?v=${v}`), f + ' in index.html');
  for (const f of fs.readdirSync(new URL('../js/', import.meta.url))) {
    for (const m of read('js/' + f).matchAll(/from '\.\/(\w+)\.js([^']*)'/g)) assert.equal(m[2], '?v=' + v, `${f} imports ${m[1]}.js${m[2]}`);
  }
});
