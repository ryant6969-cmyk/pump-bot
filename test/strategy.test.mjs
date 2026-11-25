// The rules on their own: which coins get studied, how a study is scored,
// when to sell, the holder check, and settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { b58encode } from '../js/b58.js';
import { STYLES, DEFAULT_SETTINGS, resolveRules, migrateSettings, evaluateScan, evaluateExit, evaluateHolders } from '../js/strategy.js';
import { Tape, measure, judge, fatalDuringStudy, flowSignals } from '../js/analyst.js';
import * as pump from '../js/pump.js';
import { parseWalletInput, resolveWallet } from '../js/wallets.js';

const rules = resolveRules({ ...DEFAULT_SETTINGS, style: 'balanced' });
const NOW = 10_000_000;
const curve = { complete: false, isMayhemMode: false, isCashbackCoin: false, solPaired: true, depth: 0 };
const addr = () => b58encode(nodeCrypto.randomBytes(32));

test('settings: old saves are migrated; overrides are clamped; junk is ignored', () => {
  assert.equal(migrateSettings({ skipMayhem: true }).skipMayhem, false, 'v2 allows mayhem coins (with strict checks)');
  assert.equal(migrateSettings({ settingsVersion: 2, skipMayhem: true }).skipMayhem, true, 'a v2 choice is kept');
  const r = resolveRules({ ...DEFAULT_SETTINGS, tradeSol: 1000, stopLossPct: 200, maxOpen: 2.6, takeProfitPct: 'abc', trailDropPct: -5, studySec: 2, mayhemProfitMinUsd: 8, mayhemProfitMaxUsd: 3 });
  assert.equal(r.tradeSol, 100);
  assert.equal(r.stopLossPct, 95);
  assert.equal(r.maxOpen, 3);
  assert.equal(r.takeProfitPct, STYLES.balanced.takeProfitPct);
  assert.equal(r.trailDropPct, 1);
  assert.equal(r.studySec, 15, 'never studies less than 15 s');
  assert.equal(r.mayhemProfitMaxUsd, 8, 'max is never below min');
  assert.equal(rules.studySec, 45);
  assert.equal(rules.mayhemStudySec, 25);
  assert.deepEqual([rules.mayhemProfitMinUsd, rules.mayhemProfitMaxUsd], [5, 10]);
  assert.equal(resolveRules({ style: 'nope' }).label, 'Balanced');
});

// ---- scan: which coins are worth a study ----
function scanCoin(sols, { age = 60, stepMs = 2500, c = curve, vsl = 1.4 } = {}) {
  const snaps = sols.map((sol, i) => ({ t: NOW - (sols.length - 1 - i) * stepMs, sol, mcap: 28 + sol * 1.6, progress: sol / 85, vsl }));
  return { createdAt: NOW - age * 1000, snaps, curve: c };
}
const climbing = Array.from({ length: 12 }, (_, i) => 1 + i * 0.25);

test('scan: studies coins with money coming in, skips the rest with a reason', () => {
  assert.equal(evaluateScan(scanCoin(climbing), rules, NOW).ok, true);
  assert.match(evaluateScan(scanCoin([1]), rules, NOW).reason, /Collecting/);
  assert.match(evaluateScan(scanCoin(climbing, { c: { ...curve, complete: true } }), rules, NOW).reason, /graduated/);
  assert.match(evaluateScan(scanCoin(climbing, { c: { ...curve, solPaired: false } }), rules, NOW).reason, /SOL/);
  assert.match(evaluateScan(scanCoin(climbing, { age: 3 }), rules, NOW).reason, /Too new/);
  assert.match(evaluateScan(scanCoin(climbing, { age: 3600 }), rules, NOW).reason, /Too old/);
  assert.match(evaluateScan(scanCoin([0.1, 0.2, 0.3]), rules, NOW).reason, /buyers/);
  assert.match(evaluateScan(scanCoin(climbing, { vsl: 0.7 }), rules, NOW).reason, /launch/, 'a coin below its launch price (like MANGY) is skipped');
  const falling = scanCoin(climbing);
  falling.snaps.push({ t: NOW + 2500, sol: 3, mcap: 28, progress: 0.04, vsl: 1.3 });
  assert.match(evaluateScan(falling, rules, NOW + 2500).reason, /Falling/);
  assert.match(evaluateScan(scanCoin(Array(12).fill(3)), rules, NOW).reason, /Not moving/);
  assert.equal(evaluateScan(scanCoin(climbing, { c: { ...curve, isMayhemMode: true } }), rules, NOW).ok, true, 'mayhem coins can be studied');
  assert.match(evaluateScan(scanCoin(climbing, { c: { ...curve, isMayhemMode: true } }), { ...rules, skipMayhem: true }, NOW).reason, /Mayhem/);
  assert.match(evaluateScan(scanCoin(climbing), rules, NOW + 60_000).reason, /stale/);
});

// ---- the study ----
function ev(mint, user, isBuy, sol, state) {
  const net = BigInt(Math.round(sol * 1e9));
  let tok;
  if (isBuy) { tok = (net * state.vT) / (state.vQ + net); state.vQ += net; state.vT -= tok; state.rQ += net; }
  else { tok = (net * state.vT) / (state.vQ - net); state.vQ -= net; state.vT += tok; state.rQ -= net; }
  return { mint, user, isBuy, solAmount: net, tokenAmount: tok, virtualSolReserves: state.vQ, virtualTokenReserves: state.vT, realSolReserves: state.rQ, realTokenReserves: state.vT - 279_900_000_000_000n };
}
function studied({ buyers = 20, buySol = 0.3, sellers = 2, sellSol = 0.2, creatorSells = 0, flippers = 0, agentTrades = 0, agent = null } = {}) {
  const mint = addr(), creator = addr();
  const tape = new Tape({ mint, creator, ignore: [agent] });
  const st = { vQ: 33_000_000_000n, vT: 975_000_000_000_000n, rQ: 3_000_000_000n };
  const plan = [];
  for (let i = 0; i < buyers; i++) plan.push([addr(), true, buySol]);
  for (let i = 0; i < sellers; i++) plan.push([addr(), false, sellSol]);
  for (let i = 0; i < creatorSells; i++) plan.push([creator, false, 0.6]);
  for (let i = 0; i < flippers; i++) { const w = addr(); plan.push([w, true, 0.5], [w, false, 0.45], [w, true, 0.5], [w, false, 0.45]); }
  for (let i = 0; i < agentTrades; i++) plan.push([agent, i % 2 === 0, 0.3]);
  // spread the trades evenly over the 45 s study, the last one just now
  const gap = 44_000 / plan.length;
  plan.forEach(([user, isBuy, sol], i) => tape.add(ev(mint, user, isBuy, sol, st), NOW - 44_500 + (i + 1) * gap, 'sig' + i));
  return { tape, creator, mint, studyStart: NOW - 46_000 };
}
const ctx = (s, extra = {}) => ({ tape: s.tape, studyStart: s.studyStart, now: NOW, coin: { creator: s.creator }, curve, solRaised: 9, vsLaunch: 1.6, progress: 0.15, peakMcap2m: 50, mcap: 50, rules, ...extra });

test('study: real, spread-out buying with money coming in scores high and passes', () => {
  const s = studied();
  const v = judge(ctx(s));
  assert.equal(v.ok, true, JSON.stringify(v.vetoes));
  assert.ok(v.score >= v.need && v.score >= 80, 'score ' + v.score);
  assert.equal(v.m.uniqueBuyers, 20);
  assert.equal(v.parts.length, 7);
  assert.equal(v.parts.reduce((a, p) => a + p.max, 0), 100);
});

test('study: the MANGY pattern (creator dumping, below launch, little SOL) is rejected', () => {
  const s = studied({ buyers: 5, buySol: 0.1, creatorSells: 2 });
  const v = judge(ctx(s, { solRaised: 0.6, vsLaunch: 0.45, coin: { creator: s.creator, isMayhemMode: true }, curve: { ...curve, isMayhemMode: true } }));
  assert.equal(v.ok, false);
  for (const re of [/Creator is selling/, /real buyers/, /Too little SOL/, /launch price/, /mayhem/i]) assert.ok(v.vetoes.some((x) => re.test(x)), 'missing veto ' + re + ' in ' + JSON.stringify(v.vetoes));
  assert.equal(fatalDuringStudy(s.tape, s.studyStart, NOW, { creator: s.creator }), 'Creator is selling', 'stops studying it early');
});

test('study: one whale, heavy selling, churning bots and the mayhem agent are all caught', () => {
  const whale = studied({ buyers: 9, buySol: 0.1 });
  whale.tape.add(ev(whale.mint, addr(), true, 4, { vQ: 40_000_000_000n, vT: 800_000_000_000_000n, rQ: 10_000_000_000n }), NOW - 3000, 'w');
  assert.ok(judge(ctx(whale)).vetoes.includes('One wallet is doing most of the buying'));
  const dump = studied({ buyers: 10, buySol: 0.2, sellers: 8, sellSol: 0.5 });
  assert.ok(judge(ctx(dump)).vetoes.some((x) => /More selling|money/.test(x)));
  const churn = studied({ buyers: 4, flippers: 6 });
  const vc = judge(ctx(churn));
  assert.equal(vc.m.flippers, 6, 'churning wallets spotted');
  assert.equal(vc.m.uniqueBuyers, 4, 'and not counted as buyers');
  assert.equal(vc.ok, false);
  const agent = addr();
  const may = studied({ buyers: 3, agentTrades: 30, agent });
  const vm = judge(ctx(may, { coin: { creator: may.creator, isMayhemMode: true }, curve: { ...curve, isMayhemMode: true } }));
  assert.equal(vm.ok, false);
  assert.ok(vm.m.ignoredSol > 5, "the agent's trades are ignored");
});

test('study: mayhem coins need more buyers and a clearly rising price', () => {
  const s = studied({ buyers: 12 });
  const v = judge(ctx(s));
  assert.equal(v.ok, true, 'fine as a normal coin: ' + JSON.stringify(v.vetoes));
  const vm = judge(ctx(s, { coin: { creator: s.creator, isMayhemMode: true }, curve: { ...curve, isMayhemMode: true } }));
  assert.equal(vm.ok, false, 'not enough for a mayhem coin');
  assert.ok(vm.vetoes.some((x) => /flying|real buyers/.test(x)), JSON.stringify(vm.vetoes));
  assert.equal(vm.need, rules.entry.minScore + 5);
  // a mayhem coin that really is flying: many buyers, speeding up into the end
  const hot = studied({ buyers: 30, buySol: 0.35, sellers: 0 });
  const vh = judge(ctx(hot, { coin: { creator: hot.creator, isMayhemMode: true }, curve: { ...curve, isMayhemMode: true } }));
  assert.equal(vh.ok, true, JSON.stringify(vh.vetoes));
});

test('study: after losses in a row the bot gets pickier', () => {
  const s = studied({ buyers: 11, buySol: 0.12 });
  const easy = judge(ctx(s));
  const picky = judge(ctx(s, { pickiness: 15 }));
  assert.equal(picky.need, easy.need + 15);
  if (easy.score < picky.need) assert.equal(picky.ok, false);
});

// ---- holders ----
test('holders: excludes the curve and the mayhem agent, then checks whales and the creator', () => {
  const supply = 1_000_000n * 10n ** 6n;
  const h = (pct, address = 'w' + pct + Math.random()) => ({ address, amount: (supply * BigInt(Math.round(pct * 100))) / 10_000n });
  const spread = [h(60, 'curve'), h(30, 'agent'), ...Array.from({ length: 15 }, () => h(1.5))];
  assert.equal(evaluateHolders({ holders: spread, supply, excludeAddresses: ['curve', 'agent'] }, rules).ok, true);
  assert.equal(evaluateHolders({ holders: spread, supply, excludeAddresses: ['curve'] }, rules).ok, false, 'the agent would look like a whale');
  assert.match(evaluateHolders({ holders: [h(60, 'curve'), h(12)], supply, excludeAddresses: ['curve'] }, rules).reason, /One wallet holds 12/);
  assert.match(evaluateHolders({ holders: [h(60, 'curve'), ...Array.from({ length: 10 }, () => h(4))], supply, excludeAddresses: ['curve'] }, rules).reason, /Top 10/);
  assert.match(evaluateHolders({ holders: [h(60, 'curve'), h(9, 'dev'), h(1)], supply, excludeAddresses: ['curve'], devAccount: 'dev' }, rules).reason, /Creator holds 9/);
  // the creator bought 5% at launch and now holds 1%: they sold most of it
  assert.match(evaluateHolders({ holders: [h(60, 'curve'), h(1, 'dev'), h(2)], supply, excludeAddresses: ['curve'], devAccount: 'dev', devBought: h(5).amount }, rules).reason, /already sold/);
  assert.equal(evaluateHolders({ holders: [h(60, 'curve'), h(4, 'dev'), h(2)], supply, excludeAddresses: ['curve'], devAccount: 'dev', devBought: h(5).amount }, rules).ok, true);
});

// ---- exits ----
test('exit: take profit, stop loss, trailing stop, time limit, graduation', () => {
  const pos = { costLamports: 100n, peakValueLamports: 100n, openedAt: NOW - 60_000 };
  assert.equal(evaluateExit(pos, 146, rules, {}, NOW).reason, 'Take profit');
  assert.equal(evaluateExit(pos, 81, rules, {}, NOW).reason, 'Stop loss');
  assert.equal(evaluateExit(pos, 110, rules, {}, NOW).sell, false);
  assert.equal(evaluateExit({ ...pos, peakValueLamports: 140n }, 122, rules, {}, NOW).reason, 'Trailing stop');
  assert.equal(evaluateExit({ ...pos, peakValueLamports: 140n }, 125, rules, {}, NOW).sell, false);
  assert.equal(evaluateExit({ ...pos, openedAt: NOW - 11 * 60_000 }, 105, rules, {}, NOW).reason, 'Time limit');
  assert.equal(evaluateExit(pos, 105, rules, { progress: 0.96 }, NOW).reason, 'About to graduate');
  assert.equal(evaluateExit(pos, 105, rules, { complete: true }, NOW).reason, 'Coin graduated');
  assert.equal(evaluateExit({ ...pos, costLamports: 0n }, 105, rules, {}, NOW).sell, false);
});

test('exit: sells right away on a creator dump, a big dumper, or sellers taking over', () => {
  const pos = { costLamports: 100n, peakValueLamports: 120n, openedAt: NOW - 60_000 };
  const flow = { creatorSelling: false, bigDump: false, sellersWin: false, strength: 0.5, net60: 1 };
  assert.equal(evaluateExit(pos, 120, rules, { flow }, NOW).sell, false);
  assert.equal(evaluateExit(pos, 120, rules, { flow: { ...flow, creatorSelling: true } }, NOW).reason, 'Creator is selling');
  assert.equal(evaluateExit(pos, 120, rules, { flow: { ...flow, bigDump: true } }, NOW).reason, 'A big holder dumped');
  assert.equal(evaluateExit(pos, 110, rules, { flow: { ...flow, sellersWin: true } }, NOW).reason, 'Sellers took over');
  // going nowhere: 4+ minutes flat with no money coming in
  assert.equal(evaluateExit({ ...pos, openedAt: NOW - 5 * 60_000 }, 101, rules, { flow: { ...flow, net60: -0.1 } }, NOW).reason, 'Going nowhere');
});

test('exit: mayhem coins take $5, or up to $10 while still flying', () => {
  const pos = { costLamports: 100_000_000n, peakValueLamports: 100_000_000n, openedAt: NOW - 30_000, mayhem: true };
  const usd = 200; // $20 position; $5 = 0.025 SOL
  const fly = { strength: 0.8, net60: 2 }, soft = { strength: 0.45, net60: 0.5 }, dead = { strength: 0.1, net60: 0 };
  assert.equal(evaluateExit(pos, 120_000_000, rules, { flow: soft, solUsd: usd }, NOW).sell, false, '$4 up: hold');
  assert.equal(evaluateExit(pos, 126_000_000, rules, { flow: soft, solUsd: usd }, NOW).reason, 'Took $5.20 profit');
  assert.equal(evaluateExit(pos, 140_000_000, rules, { flow: fly, solUsd: usd }, NOW).sell, false, '$8 up and flying: hold for $10');
  assert.equal(evaluateExit(pos, 151_000_000, rules, { flow: fly, solUsd: usd }, NOW).reason, 'Took $10.20 profit');
  assert.equal(evaluateExit(pos, 140_000_000, rules, { flow: dead, solUsd: usd }, NOW).reason, 'Took $8.00 profit', 'momentum died: take it');
  assert.equal(evaluateExit(pos, 80_000_000, rules, { flow: fly, solUsd: usd }, NOW).reason, 'Stop loss');
  assert.equal(evaluateExit(pos, 146_000_000, rules, { flow: fly }, NOW).reason, 'Take profit', 'no SOL price: uses the % target');
});

test('exit: copied trades follow the wallet you copy (plus the safety exits)', () => {
  const pos = { costLamports: 100n, peakValueLamports: 300n, openedAt: NOW - 60 * 60_000, copiedFrom: addr() };
  assert.equal(evaluateExit(pos, 250, rules, {}, NOW).sell, false, 'no take profit, trailing stop or time limit');
  assert.equal(evaluateExit(pos, 70, rules, {}, NOW).reason, 'Stop loss');
  assert.equal(evaluateExit(pos, 150, rules, { flow: { creatorSelling: true } }, NOW).reason, 'Creator is selling');
});

test('flow signals: creator selling, a big dumper, and buying strength', () => {
  const mint = addr(), creator = addr();
  const tape = new Tape({ mint, creator });
  const st = { vQ: 40_000_000_000n, vT: 800_000_000_000_000n, rQ: 10_000_000_000n };
  for (let i = 0; i < 8; i++) tape.add(ev(mint, addr(), true, 0.4, st), NOW - 18_000 + i * 2000, 'b' + i);
  let f = flowSignals(tape, NOW, { since: NOW - 60_000 });
  assert.equal(f.creatorSelling, false);
  assert.ok(f.strength > 0.6, 'strong buying: ' + f.strength);
  tape.add(ev(mint, creator, false, 0.2, st), NOW - 1000, 'c');
  assert.equal(flowSignals(tape, NOW, { since: NOW - 60_000 }).creatorSelling, true);
  tape.add(ev(mint, addr(), false, 2.5, st), NOW - 500, 'd');
  f = flowSignals(tape, NOW, { since: NOW - 60_000 });
  assert.equal(f.bigDump, true);
  assert.equal(measure(tape).sells, 2);
});

// ---- curve math for any curve ----
test('curve: progress and launch price are right for standard and custom (mayhem) curves', () => {
  const std = { virtualTokenReserves: 1_073_000_000_000_000n, virtualQuoteReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n, realQuoteReserves: 0n, tokenTotalSupply: 10n ** 15n, complete: false };
  assert.equal(pump.curveProgress(std), 0);
  assert.equal(pump.curvePriceVsLaunch(std), 1);
  // a custom curve: 60 virtual SOL, 1.5B virtual tokens, 1.2B for sale; someone buys 10 SOL
  const vT0 = 1_500_000_000_000_000n, vQ0 = 60_000_000_000n, r0 = 1_200_000_000_000_000n, buy = 10_000_000_000n;
  const out = (buy * vT0) / (vQ0 + buy);
  const c = { virtualTokenReserves: vT0 - out, virtualQuoteReserves: vQ0 + buy, realTokenReserves: r0 - out, realQuoteReserves: buy, tokenTotalSupply: 2n * 10n ** 15n, complete: false };
  const shape = pump.curveShape(c);
  assert.ok(Math.abs(Number(shape.forSale - r0)) < 1e6, 'found the 1.2B tokens for sale');
  assert.ok(Math.abs(pump.curveProgress(c) - Number(out) / Number(r0)) < 1e-6);
  assert.ok(Math.abs(pump.curvePriceVsLaunch(c) - (70 / 60) ** 2) < 1e-6);
  assert.equal(pump.curveSolRaised(c), 10);
});

// ---- wallet input ----
test('wallet input: addresses, profile links, @usernames', async () => {
  const a = addr();
  assert.deepEqual(parseWalletInput(a), { address: a });
  assert.deepEqual(parseWalletInput(' @' + a + ' '), { address: a });
  assert.deepEqual(parseWalletInput('https://pump.fun/profile/' + a + '?tab=coins'), { address: a });
  assert.deepEqual(parseWalletInput('https://solscan.io/account/' + a), { address: a });
  assert.deepEqual(parseWalletInput('@cupsey'), { username: 'cupsey' });
  assert.deepEqual(parseWalletInput('pump.fun/profile/cupsey'), { username: 'cupsey' });
  assert.equal(parseWalletInput('hello there'), null);
  assert.equal(parseWalletInput(''), null);
  let asked = null;
  const ok = async (url) => { asked = url; return { ok: true, status: 200, json: async () => ({ address: a, username: 'cupsey' }) }; };
  assert.deepEqual(await resolveWallet('@cupsey', ok), { address: a, username: 'cupsey' });
  assert.equal(asked, 'https://frontend-api-v3.pump.fun/users/cupsey');
  await assert.rejects(() => resolveWallet('@nobody', async () => ({ ok: false, status: 404 })), /no user called @nobody/);
  await assert.rejects(() => resolveWallet('@cupsey', async () => { throw new TypeError('Load failed'); }), /paste that instead/);
  await assert.rejects(() => resolveWallet('@cupsey', async () => ({ ok: true, status: 200, json: async () => ({ username: 'cupsey' }) })), /Paste their wallet address/);
});
